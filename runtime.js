// 源运行时 —— 解释源文档（ADR-0002）。
//
// 装载器把 `var DOC = <文档 JSON>;` 拼在本文件之前，所以 DOC 是本文件的全局。
//
// 对宿主暴露两个全局函数，参数与返回值都是 JSON 字符串：
//   plan(req)  -> {"name","url","headers","input"} 继续抓取
//              |  {"done":true}   所有请求步骤已完成，可以 parse
//              |  {"abort":true}  本次 op 无法进行（模板求值为空），按空结果返回
//   parse(req) -> {"data": <crawl 协议值>, "hidden": [{"name","key","value"}]}
// req = {op, payload, ctx, responses}；responses 是 {步骤名: 响应体}。
//
// HTML 求值经宿主绑定 __host.select(html, selector) —— 返回 [{attrs, text, html}] 的
// JSON 字符串，由 app 侧的 scraper（html5ever + CSS 选择器）完成；JSON 路径在本文件里走查。
// 沙箱不挂 RegExp，本文件只用字符串方法。

// ---------- 通用小工具 ----------

function collapse(s) {
  var out = "";
  var ws = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      ws = out.length > 0;
    } else {
      if (ws) out += " ";
      out += ch;
      ws = false;
    }
  }
  return out;
}

function trim(s) {
  var a = 0;
  var b = s.length;
  while (a < b && isSpace(s[a])) a++;
  while (b > a && isSpace(s[b - 1])) b--;
  return s.slice(a, b);
}

function isSpace(ch) {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

function stripTags(s) {
  var out = "";
  var inTag = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === "<") inTag = true;
    else if (ch === ">") {
      inTag = false;
      out += " ";
    } else if (!inTag) out += ch;
  }
  return out;
}

// 常见实体还原（&amp; 等）。只处理命名实体与数字实体，不引入正则。
var ENTITIES = [
  ["&amp;", "&"], ["&lt;", "<"], ["&gt;", ">"], ["&quot;", '"'],
  ["&#39;", "'"], ["&apos;", "'"], ["&nbsp;", " "], ["&#160;", " "]
];

function unescape(s) {
  for (var i = 0; i < ENTITIES.length; i++) {
    s = splitJoin(s, ENTITIES[i][0], ENTITIES[i][1]);
  }
  return s;
}

function splitJoin(s, find, replace) {
  if (find === "") return s;
  return s.split(find).join(replace);
}

function after(s, marker) {
  var i = s.indexOf(marker);
  return i < 0 ? "" : s.slice(i + marker.length);
}

function before(s, marker) {
  var i = s.indexOf(marker);
  return i < 0 ? "" : s.slice(0, i);
}

function firstOn(s, sep) {
  var i = s.indexOf(sep);
  return i < 0 ? s : s.slice(0, i);
}

function digitsAfter(s, key) {
  var i = s.indexOf(key);
  if (i < 0) return "";
  var b = i + key.length;
  var out = "";
  while (b < s.length && s[b] >= "0" && s[b] <= "9") {
    out += s[b];
    b++;
  }
  return out;
}

// URL 里的查询参数（含 & 与 &amp; 两种分隔）
function param(url, name) {
  var q = url.indexOf("?");
  if (q < 0) return "";
  var segs = url.slice(q + 1).split("&");
  var key = name + "=";
  for (var i = 0; i < segs.length; i++) {
    if (segs[i].indexOf(key) === 0) return segs[i].slice(key.length);
  }
  return "";
}

// 相对协议与 http 升级（旧脚本里的 absUrl / https 两种处理）
function absoluteUrl(u) {
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("http://") === 0) return "https://" + u.slice("http://".length);
  return u;
}

function isImageUrl(u) {
  var l = u.toLowerCase();
  return (
    l.indexOf(".jpg") >= 0 || l.indexOf(".jpeg") >= 0 ||
    l.indexOf(".png") >= 0 || l.indexOf(".webp") >= 0 ||
    l.indexOf(".gif") >= 0 || l.indexOf(".avif") >= 0
  );
}

// ---------- 变换与过滤器（闭集，见 crawler/doc.rs 的 TRANSFORMS / FILTERS） ----------

function applyTransform(value, name) {
  if (value === null || value === undefined) return "";
  var v = String(value);
  var cut = name.indexOf(":");
  var op = cut < 0 ? name : name.slice(0, cut);
  var arg = cut < 0 ? "" : name.slice(cut + 1);
  switch (op) {
    case "trim": return trim(v);
    case "collapse": return trim(collapse(v));
    case "stripTags": return trim(collapse(stripTags(v)));
    case "unescape": return unescape(v);
    case "absoluteUrl": return absoluteUrl(v);
    case "encode": return encodeURIComponent(v);
    case "lower": return v.toLowerCase();
    case "firstOn": return firstOn(v, arg);
    case "after": return after(v, arg);
    case "before": return before(v, arg);
    case "digitsAfter": return digitsAfter(v, arg);
    case "param": return param(v, arg);
    case "stripPrefix":
      return v.indexOf(arg) === 0 ? v.slice(arg.length) : v;
    case "stripSuffix": {
      var i = v.lastIndexOf(arg);
      return i >= 0 && i === v.length - arg.length ? v.slice(0, i) : v;
    }
    case "prepend": return arg + v;
    case "split": {
      var last = arg.lastIndexOf(":");
      var sep = last < 0 ? arg : arg.slice(0, last);
      var idx = last < 0 ? 0 : parseInt(arg.slice(last + 1), 10);
      var parts = v.split(sep);
      return parts[idx] === undefined ? "" : parts[idx];
    }
    default: throw new Error("未知变换: " + name);
  }
}

function applyFilter(value, name) {
  if (value === null || value === undefined) return false;
  var v = String(value);
  var cut = name.indexOf(":");
  var op = cut < 0 ? name : name.slice(0, cut);
  var arg = cut < 0 ? "" : name.slice(cut + 1);
  switch (op) {
    case "nonEmpty": return v !== "";
    case "imageUrl": return isImageUrl(v);
    case "contains": return v.indexOf(arg) >= 0;
    case "startsWith": return v.indexOf(arg) === 0;
    case "endsWith": return v.length >= arg.length && v.slice(v.length - arg.length) === arg;
    default: throw new Error("未知过滤器: " + name);
  }
}

// ---------- JSON 路径 ----------

// 点分路径；数字段是数组下标；返回 null 表示不存在。
function jsonPath(value, path) {
  if (!path) return value === undefined ? null : value;
  var segs = path.split(".");
  var cur = value;
  for (var i = 0; i < segs.length; i++) {
    if (cur === null || cur === undefined) return null;
    var seg = segs[i];
    if (Array.isArray(cur)) {
      var n = parseInt(seg, 10);
      if (!(n >= 0) || n >= cur.length) return null;
      cur = cur[n];
    } else if (typeof cur === "object") {
      if (cur[seg] === undefined) return null;
      cur = cur[seg];
    } else {
      return null;
    }
  }
  return cur === undefined ? null : cur;
}

// ---------- 作用域 ----------

// HTML 作用域是字符串（一段标记）；JSON 作用域是任意值。kind 由 op 的 input 决定。
function textOf(node, kind) {
  if (node === null || node === undefined) return "";
  if (kind === "json") return scalar(node);
  return collapse(node.text || "");
}

function scalar(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function attrOf(node, name) {
  if (!node || !node.attrs) return "";
  var v = node.attrs[name];
  return v === undefined || v === null ? "" : String(v);
}

// 选择：HTML 走宿主绑定，JSON 走 jsonPath。返回节点数组。
// HTML 的作用域可以是一段标记（根），也可以是上一个选择出来的单元节点（用它的内部标记继续找）。
function selectAll(value, selector, kind) {
  if (selector === null || selector === undefined || selector === "") {
    return value === null || value === undefined ? [] : [value];
  }
  if (kind === "json") {
    var root = typeof value === "string" ? JSON.parse(value) : value;
    var v = jsonPath(root, selector);
    if (v === null || v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }
  var html = typeof value === "string" ? value : innerHtmlOf(value);
  if (!html) return [];
  return JSON.parse(__host.select(html, selector));
}

function innerHtmlOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object" && typeof node.html === "string") return node.html;
  return "";
}

function selectOne(value, selector, kind) {
  var all = selectAll(value, selector, kind);
  return all.length ? all[0] : null;
}

// ---------- 模板 ----------

// 任一占位求值为空 → 整条模板作废（返回空串）。这条规则覆盖全部「没有 URL 就不抓取」的场合。
function tpl(text, e) {
  if (text === null || text === undefined) return "";
  var rest = String(text);
  var out = "";
  for (;;) {
    var open = rest.indexOf("{");
    if (open < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, open);
    var close = rest.indexOf("}", open + 1);
    if (close < 0) return "";
    var body = rest.slice(open + 1, close);
    var parts = body.split("|");
    var v = resolve(trim(parts[0]), e);
    for (var i = 1; i < parts.length; i++) v = applyTransform(v, trim(parts[i]));
    if (v === null || v === undefined || v === "") return "";
    out += v;
    rest = rest.slice(close + 1);
  }
  return out;
}

function tplChain(chain, e) {
  if (chain === null || chain === undefined) return "";
  if (typeof chain === "string") return tpl(chain, e);
  for (var i = 0; i < chain.length; i++) {
    var v = tpl(chain[i], e);
    if (v) return v;
  }
  return "";
}

function resolve(name, e) {
  if (name === "item") return textOf(e.item, e.kind);
  if (name === "index") return e.index === null || e.index === undefined ? "" : String(e.index);
  if (name.indexOf("item.") === 0) return readPathOf(e.item, name.slice(5), e.kind);
  if (name.indexOf("item@") === 0) return attrOf(e.item, name.slice(5));
  if (name.indexOf("resp.") === 0) {
    var body = e.responses[name.slice(5)];
    return body === undefined ? "" : body;
  }
  if (e.stepVars && e.stepVars[name] !== undefined) return str(e.stepVars[name]);
  var hidden = hiddenLookup(name, e);
  if (hidden !== null) return hidden;
  if (name === "comicId") return localComicId(e);
  if (name === "itemId") return str(e.itemId);
  if (name === "categoryUrl") return categoryUrlOf(e);
  if (e.ctx[name] !== undefined) return str(e.ctx[name]);
  if (e.payload[name] !== undefined) return str(e.payload[name]);
  if (DOC.vars && DOC.vars[name] !== undefined) return str(DOC.vars[name]);
  if (name === "base") return DOC.base || "";
  if (name === "idPrefix") return DOC.idPrefix || "";
  return "";
}

// 文档里的漫画 id 是「前缀 + 本地 id」；模板里的 {comicId} 是本地 id。
function localComicId(e) {
  return stripPrefix(str(e.payload.comicId), DOC.idPrefix || "");
}

function stripPrefix(s, prefix) {
  if (prefix && s.indexOf(prefix) === 0) return s.slice(prefix.length);
  return s;
}

// 静态分类表里与 payload.label 同名条目的 URL；没有同名条目返回空串（整条模板作废 → 不抓取）。
function categoryUrlOf(e) {
  var label = str(e.payload.label);
  var cats = DOC.categories || [];
  for (var i = 0; i < cats.length; i++) {
    if (cats[i].label === label) return cats[i].url;
  }
  return "";
}

function str(v) {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : String(v);
}

// 隐藏值：ctx.hidden[名][键]；键先按「漫画:章节」再按漫画。
function hiddenLookup(name, e) {
  var store = e.ctx.hidden;
  if (!store) return null;
  var byName = store[name];
  if (!byName) return null;
  var comicId = str(e.payload.comicId);
  if (!comicId) return null;
  var byChapter = byName[comicId + ":" + str(e.payload.chapterIndex)];
  if (byChapter !== undefined) return str(byChapter);
  if (byName[comicId] !== undefined) return str(byName[comicId]);
  return null;
}

function readPathOf(value, path, kind) {
  if (kind === "json") return scalar(jsonPath(value, path));
  var node = selectOne(value, path, kind);
  return node === null ? "" : textOf(node, kind);
}

// ---------- 取值 ----------

// 读一个 extractor，返回字符串（空串 = 未取到）。
function read(ex, value, e) {
  if (typeof ex === "string") {
    var node = selectOne(value, ex, e.kind);
    return node === null ? "" : textOf(node, e.kind);
  }
  // 规则自带局部变量：先在本作用域里把它们求出来，供模板类取值使用
  var env = e;
  if (ex.vars) {
    env = envOf(e);
    var scoped = {};
    for (var k in e.stepVars) scoped[k] = e.stepVars[k];
    for (var vn in ex.vars) scoped[vn] = read(ex.vars[vn], value, e);
    env.stepVars = scoped;
  }
  if (ex.default !== undefined) return tpl(ex.default, env);
  if (ex.fromChapter !== undefined) return fromChapter(ex.fromChapter, env);
  if (ex.array) {
    var values = arrayValue(ex.array, value, env);
    if (!values.length) return "";
    // first:false 的取值（作者这类多值字段）连接成一个字符串；标签走 readTags 取数组
    if (ex.array.first === false) return values.join(ex.array.join || ", ");
    return values[0];
  }
  if (ex.template !== undefined) return tpl(ex.template, env);

  var target = value;
  var kind = env.kind;
  if (ex.from) {
    var step = stepByName(ex.from, env.req);
    if (!step) throw new Error("未知请求步骤: " + ex.from);
    var body = env.responses[ex.from];
    if (body === undefined) return "";
    target = body;
    kind = step.input || inputKind(env.req);
  }
  var raw;
  if (ex.select) {
    var matches = selectAll(target, ex.select, kind);
    raw = ex.pick === "last" ? (matches.length ? matches[matches.length - 1] : null) : matches[0] || null;
  } else {
    raw = target;
  }
  var out;
  if (ex.attr) out = attrOf(raw, ex.attr);
  else if (ex.localized) out = pickLocalized(raw);
  else out = textOf(raw, kind);

  // 过滤器不满足 = 本规则不适用（回退链落到下一条），不再走条件分支
  if (ex.filter && !applyFilter(out, ex.filter)) return "";
  var list = ex.transform || [];
  for (var i = 0; i < list.length; i++) out = applyTransform(out, list[i]);

  if (ex.contains !== undefined || ex.equals !== undefined) {
    var hit = ex.contains !== undefined
      ? out.indexOf(tpl(ex.contains, env)) >= 0
      : out === tpl(ex.equals, env);
    var picked = hit ? ex.then : ex["else"];
    return picked === undefined ? out : tpl(picked, env);
  }
  return out;
}

// 字段：单个 extractor，或有序回退链（首个非空获胜）。
function readField(field, value, e) {
  if (Array.isArray(field)) {
    for (var i = 0; i < field.length; i++) {
      var v = read(field[i], value, e);
      if (v) return v;
    }
    return "";
  }
  return read(field, value, e);
}

function pickLocalized(node) {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return scalar(node);
  var order = ["en", "zh", "ja", "ko"];
  for (var i = 0; i < order.length; i++) {
    var v = node[order[i]];
    if (typeof v === "string" && v) return v;
  }
  for (var k in node) {
    if (typeof node[k] === "string" && node[k]) return node[k];
  }
  return "";
}

// 数组查找：定位一个数组，按 key 匹配（或不筛选），对每个命中取 take，返回字符串数组。
// at / key / take 都按当前作用域的种类求值：HTML 走选择器与属性，JSON 走点分路径。
function arrayValue(spec, value, e) {
  var scope = value;
  var kind = e.kind;
  if (spec.inStep) {
    var step = stepByName(spec.inStep, e.req);
    var body = e.responses[spec.inStep];
    if (body === undefined) return [];
    scope = body;
    kind = step ? step.input || inputKind(e.req) : "json";
  }
  var arr = spec.at ? selectAll(scope, spec.at, kind) : Array.isArray(scope) ? scope : [];
  if (!Array.isArray(arr)) return [];
  if (spec.skip) arr = arr.slice(spec.skip);
  var want = spec.equals !== undefined ? tpl(spec.equals, e) : null;
  var sub = spec.contains !== undefined ? tpl(spec.contains, e) : null;
  var first = spec.first !== false;
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var el = arr[i];
    if (want !== null || sub !== null) {
      // key 缺省 = 元素自身的文本（「这一段里含某标记」这类判定）
      var got = spec.key !== undefined ? readField(spec.key, el, e) : textOf(el, kind);
      var hit = want !== null ? got === want || numericEqual(got, want) : got.indexOf(sub) >= 0;
      if (!hit) continue;
    }
    var v = readField(spec.take, el, e);
    if (!v) continue;
    out.push(v);
    if (first) break;
  }
  return out;
}

// 标签这类列表字段：声明了 array 就用它取全部，否则按单个值包一层。
function readTags(field, value, e) {
  var specs = Array.isArray(field) ? field : [field];
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    if (typeof spec === "object" && spec !== null && spec.array) {
      var values = arrayValue(spec.array, value, e);
      if (values.length) return values;
      continue;
    }
    var v = read(spec, value, e);
    if (v) return [v];
  }
  return [];
}

// 「1」与「1.0」视为相等（章节号在 JSON 里可能是数字或字符串）。
function numericEqual(a, b) {
  var x = parseFloat(a);
  var y = parseFloat(b);
  return x === x && y === y && x === y;
}

function fromChapter(which, e) {
  var chapters = e.chapters || [];
  if (!chapters.length) return "";
  var ch = which === "last" ? chapters[chapters.length - 1] : chapters[0];
  return ch && ch.title ? ch.title : "";
}

// ---------- 请求步骤与请求头 ----------

function inputKind(req) {
  var spec = DOC.ops[req.op];
  return (spec && spec.input) || "html";
}

function stepByName(name, req) {
  var spec = DOC.ops[req.op];
  var steps = (spec && spec.request) || [];
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].name === name) return steps[i];
  }
  return null;
}

function headerMap(chain, e, out) {
  for (var name in chain) {
    var v = tplChain(chain[name], e);
    if (v) out[name] = v;
  }
}

function headersFor(req, step, e) {
  var out = {};
  if (DOC.headers) headerMap(DOC.headers, e, out);
  var byOp = DOC.headersByOp && DOC.headersByOp[req.op];
  if (byOp) headerMap(byOp, e, out);
  if (step && step.headers) headerMap(step.headers, e, out);
  return out;
}

// ---------- 集合 ----------

function itemList(spec, e) {
  var scope = e.root;
  var kind = e.kind;
  var items = spec.items;
  // 单元定位的钩子：整个单元列表由文档里的 JS 给出（hentara 的本地搜索要在全站索引上过滤排序）
  if (typeof items === "object" && items !== null && items.script) {
    return runItemsHook(items.script, e);
  }
  // items 可以指定从某个请求步骤的响应里找（mangadex/copymanga 的章节来自独立的 feed）
  if (typeof items === "object" && items !== null && items.from) {
    var step = stepByName(items.from, e.req);
    var body = e.responses[items.from];
    if (body === undefined) return [];
    scope = body;
    kind = step ? step.input || inputKind(e.req) : "json";
    items = items.select;
  }
  if (spec.region) {
    var region = selectOne(scope, spec.region, kind);
    if (region === null) return [];
    scope = kind === "html" ? region.html : region;
  }
  var nodes = selectAll(scope, items, kind);
  if (spec.where) {
    var kept = [];
    for (var i = 0; i < nodes.length; i++) {
      if (read(spec.where, nodes[i], e)) kept.push(nodes[i]);
    }
    nodes = kept;
  }
  return nodes;
}

// ---------- 协议值构造 ----------

function comicFrom(node, spec, e) {
  var id = read(spec.id, node, e);
  if (!id) return null;
  e.itemId = id;
  var fields = spec.fields || {};
  var out = {
    id: (DOC.idPrefix || "") + id,
    source: DOC.id,
    sourceTitle: DOC.title,
    title: "",
    author: "",
    intro: "",
    cover: "",
    status: "serial",
    updateTime: "",
    lastChapter: "",
    tags: [],
    lastReadChapter: 0,
    lastReadTime: 0
  };
  for (var name in fields) {
    if (name === "tags") {
      out.tags = readTags(fields[name], node, e);
      continue;
    }
    var v = readField(fields[name], node, e);
    if (name in out) out[name] = v;
  }
  return { comic: out, node: node, localId: id };
}

function chaptersFrom(chSpec, e) {
  var nodes = itemList({ items: chSpec.items }, e);
  if (chSpec.where) {
    var kept = [];
    for (var w = 0; w < nodes.length; w++) {
      if (read(chSpec.where, nodes[w], e)) kept.push(nodes[w]);
    }
    nodes = kept;
  }
  var rows = [];
  var positionMode = false;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var ce = envOf(e);
    ce.item = node;
    ce.index = i + 1;
    var raw = chSpec.index ? readField(chSpec.index, node, ce) : "";
    if (raw === "position") positionMode = true;
    var index = positionMode ? i + 1 : parseFloat(raw);
    // 声明了 index 却取不到号（或不是数）的条目丢弃
    if (chSpec.index && !positionMode && !(index === index)) continue;
    // 标题的默认值（如「第 {index} 话」）用章节号，不用循环序号
    ce.index = chSpec.index ? String(index) : i + 1;
    var title = chSpec.title ? readField(chSpec.title, node, ce) : "";
    var sortKeys = [];
    for (var s = 0; s < (chSpec.sortBy || []).length; s++) {
      sortKeys.push(readField(chSpec.sortBy[s], node, ce));
    }
    rows.push({
      index: index,
      title: title,
      pages: [],
      external: chSpec.external ? !!read(chSpec.external, node, ce) : false,
      downloaded: false,
      read: false,
      // 去重键：声明了 dedupBy 用它，否则用章节号本身
      dedupKey: chSpec.dedupBy ? readField(chSpec.dedupBy, node, ce) : raw,
      sortKeys: sortKeys,
      node: node,
      env: ce
    });
  }
  rows = dedupe(rows, function (r) { return r.dedupKey; });
  rows = sortChapters(rows, chSpec);
  // position：排序去重后的 1 起序号（baozimh 这类页面本身不给章节号的源）
  if (positionMode) {
    for (var k = 0; k < rows.length; k++) rows[k].index = k + 1;
  }
  return rows;
}

// 章节排序：声明了 sortBy 就按多键升序（能解析成数就按数值比），否则按 sort 方向比章节号。
function sortChapters(rows, spec) {
  if (spec.sortBy && spec.sortBy.length) {
    rows.sort(function (a, b) {
      for (var i = 0; i < a.sortKeys.length; i++) {
        var x = a.sortKeys[i];
        var y = b.sortKeys[i];
        var nx = parseFloat(x);
        var ny = parseFloat(y);
        var cmp = nx === nx && ny === ny ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
    return rows;
  }
  if (!spec.sort) return rows;
  rows.sort(function (a, b) {
    return spec.sort === "desc" ? b.index - a.index : a.index - b.index;
  });
  return rows;
}

function dedupe(rows, keyOf) {
  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var k = keyOf(rows[i]);
    if (k === "" || k === null || k === undefined) {
      out.push(rows[i]);
      continue;
    }
    if (seen[k]) continue;
    seen[k] = true;
    out.push(rows[i]);
  }
  return out;
}

// ---------- 入口 ----------

function opEnv(req) {
  return {
    req: req,
    payload: req.payload || {},
    ctx: req.ctx || {},
    responses: req.responses || {},
    kind: inputKind(req),
    root: null,
    item: null,
    itemId: null,
    index: null,
    chapters: [],
    stepVars: {}
  };
}

function envOf(e) {
  return {
    req: e.req,
    payload: e.payload,
    ctx: e.ctx,
    responses: e.responses,
    kind: e.kind,
    root: e.root,
    item: e.item,
    itemId: e.itemId,
    index: e.index,
    chapters: e.chapters,
    stepVars: e.stepVars
  };
}

// 首步响应作为解析的根作用域（多步请求时，文档用 from 指定某一步）。
function rootScope(req, spec) {
  var steps = spec.request || [];
  if (!steps.length) return null;
  var first = steps[0];
  var body = req.responses[first.name];
  if (body === undefined) return null;
  var kind = first.input || inputKind(req);
  return kind === "json" ? JSON.parse(body) : body;
}

function plan(reqJson) {
  var req = JSON.parse(reqJson);
  var spec = DOC.ops[req.op];
  if (!spec) return JSON.stringify({ done: true });
  var steps = spec.request || [];
  var e = opEnv(req);
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (req.responses[step.name] !== undefined) continue;
    e.stepVars = {};
    var vars = step.vars || {};
    for (var name in vars) e.stepVars[name] = read(vars[name], null, e);
    var url = tplChain(step.url, e);
    if (!url) return JSON.stringify({ abort: true });
    return JSON.stringify({
      name: step.name,
      url: url,
      headers: headersFor(req, step, e),
      input: step.input || inputKind(req)
    });
  }
  return JSON.stringify({ done: true });
}

function parse(reqJson) {
  var req = JSON.parse(reqJson);
  // categories 未声明 op 时用文档顶层的静态分类表；声明了就按普通 op 抓取解析。
  if (req.op === "categories" && !DOC.ops["categories"]) {
    return JSON.stringify({ data: categoriesOf(), hidden: [] });
  }
  var spec = DOC.ops[req.op];
  if (!spec) return JSON.stringify({ data: emptyFor(req.op), hidden: [] });
  if (spec.script) {
    var value = runHook(spec.script, req, spec);
    return JSON.stringify({ data: value, hidden: [] });
  }
  var e = opEnv(req);
  e.root = rootScope(req, spec);
  var data;
  var hidden = [];
  switch (req.op) {
    case "categories":
      data = categoriesFrom(spec, e);
      break;
    case "search":
    case "category":
      data = listOf(spec, e, hidden);
      break;
    case "detail":
      data = detailOf(spec, e, hidden);
      break;
    case "images":
      data = imagesOf(spec, e);
      break;
    default:
      throw new Error("未知 op: " + req.op);
  }
  return JSON.stringify({ data: data, hidden: hidden });
}

function categoriesOf() {
  var out = [];
  var cats = DOC.categories || [];
  for (var i = 0; i < cats.length; i++) out.push(cats[i].label);
  return out;
}

// 动态分类：抓回来的列表里逐项取 label（mangadex 的标签表）。
function categoriesFrom(spec, e) {
  var nodes = itemList(spec, e);
  var field = (spec.fields || {}).label;
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var v = field !== undefined ? readField(field, nodes[i], e) : "";
    if (v) out.push(v);
  }
  return out;
}

function listOf(spec, e, hidden) {
  var nodes = itemList(spec, e);
  if (spec.limit) nodes = nodes.slice(0, spec.limit);
  var rows = [];
  for (var i = 0; i < nodes.length; i++) {
    var ie = envOf(e);
    ie.item = nodes[i];
    ie.index = i + 1;
    var built = comicFrom(nodes[i], spec, ie);
    if (!built) continue;
    rows.push({ comic: built.comic, localId: built.localId, node: nodes[i], env: ie });
  }
  rows = dedupe(rows, function (r) { return r.comic.id; });
  collectHidden(spec.hidden, rows, hidden, function (r) { return r.comic.id; });
  var out = [];
  for (var j = 0; j < rows.length; j++) out.push(rows[j].comic);
  return out;
}

function detailOf(spec, e, hidden) {
  var scope = e.root;
  var ce = envOf(e);
  ce.root = scope;
  var comic = {
    id: (DOC.idPrefix || "") + localComicId(e),
    source: DOC.id,
    sourceTitle: DOC.title,
    title: "",
    author: "",
    intro: "",
    cover: "",
    status: "serial",
    updateTime: "",
    lastChapter: "",
    tags: [],
    lastReadChapter: 0,
    lastReadTime: 0
  };
  for (var name in spec.comic || {}) {
    if (name === "tags") {
      comic.tags = readTags(spec.comic[name], scope, ce);
      continue;
    }
    var v = readField(spec.comic[name], scope, ce);
    if (name in comic) comic[name] = v;
  }
  var chapters = [];
  if (spec.chapters) {
    var rows = chaptersFrom(spec.chapters, ce);
    ce.chapters = rows;
    // lastChapter 依赖已产出的章节，补一次
    if (spec.comic && spec.comic.lastChapter) {
      comic.lastChapter = readField(spec.comic.lastChapter, scope, ce);
    }
    for (var i = 0; i < rows.length; i++) {
      chapters.push({
        index: rows[i].index,
        title: rows[i].title,
        pages: rows[i].pages,
        external: rows[i].external,
        downloaded: rows[i].downloaded,
        read: rows[i].read
      });
    }
    collectChapterHidden(spec.chapters.hidden, rows, hidden, comic.id);
  }
  if (spec.hidden) {
    collectHidden(spec.hidden, [{ comic: comic }], hidden, function (r) { return r.comic.id; });
  }
  return { comic: comic, chapters: chapters };
}

function imagesOf(spec, e) {
  var nodes = itemList(spec, e);
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var ie = envOf(e);
    ie.item = nodes[i];
    ie.index = i + 1;
    var u = readField(spec.url, nodes[i], ie);
    if (u) out.push(u);
  }
  return out;
}

// 隐藏值：op 级按「漫画 id」记键，章节级按「漫画 id:章节号」记键。
function collectHidden(decl, rows, hidden, keyOf) {
  if (!decl) return;
  for (var name in decl) {
    for (var i = 0; i < rows.length; i++) {
      var v = read(decl[name], rows[i].node, rows[i].env);
      if (v) hidden.push({ name: name, key: keyOf(rows[i]), value: v });
    }
  }
}

function collectChapterHidden(decl, rows, hidden, comicId) {
  if (!decl) return;
  for (var name in decl) {
    for (var i = 0; i < rows.length; i++) {
      var v = read(decl[name], rows[i].node, rows[i].env);
      if (v) hidden.push({ name: name, key: comicId + ":" + rows[i].index, value: v });
    }
  }
}

function emptyFor(op) {
  return op === "detail" ? {} : [];
}

// 单元定位的钩子：返回节点数组（不需要自己拼 Comic，字段仍走声明式）。
function runItemsHook(src, e) {
  var fn = eval("(" + src + ")");
  return fn(hookApi(e.req, e));
}

// 钩子拿到的 api：与声明式层同一份上下文与宿主绑定。
function hookApi(req, e) {
  return {
    op: req.op,
    payload: req.payload || {},
    ctx: req.ctx || {},
    responses: req.responses || {},
    doc: DOC,
    root: e ? e.root : null,
    host: __host
  };
}

// 整 op 的解析钩子：文档里嵌的 JS 源码，编译后调用，参数是 api。
function runHook(src, req, spec) {
  var fn = eval("(" + src + ")");
  var api = hookApi(req, null);
  api.root = rootScope(req, spec);
  return fn(api);
}

// vitest 侧加载入口（Rust 引擎读全局 plan/parse，二者都在）
globalThis.__source = { plan: plan, parse: parse };
