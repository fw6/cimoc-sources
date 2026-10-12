# cimoc-sources — 墨卷漫画源仓库

墨卷（[fw6/mojuan](https://github.com/fw6/mojuan)）的漫画源分发仓库。应用从
`https://raw.githubusercontent.com/fw6/cimoc-sources/main/sources.json` 取索引，
在设置页的「漫画源」面板里列出可安装的源、检查更新；也可以手动导入一份源文档。

## 一个源就是一份 JSON 文档

源不再是一段 JS 脚本：解析规则与 URL 构造写成一份**源文档**（`sources/<id>.json`），
由应用内置的**源运行时**（`runtime.js`）解释。文档的格式由一份 JSON Schema 定义——
把它的地址填进编辑器的 `$schema` 就有补全与校验：

```json
{
  "$schema": "https://mojuan.fengw.site/schema.json",
  "schema": 1,
  "id": "mysite",
  "title": "我的漫画",
  "idPrefix": "mysite-",
  "base": "https://mysite.com",
  "categories": [{ "label": "热血", "url": "https://mysite.com/list/rexue/" }],
  "ops": {
    "search": {
      "request": [{ "name": "list", "url": "{base}/search?q={keyword|encode}" }],
      "items": "div.book-item",
      "id": { "select": "a", "attr": "href", "transform": ["after:/book/", "before:/"] },
      "fields": {
        "title": ["h3.title", { "select": "img", "attr": "alt" }],
        "cover": { "select": "img", "attr": "data-src", "filter": "imageUrl" }
      }
    }
  }
}
```

文档里的关键概念（Schema 里有逐字段说明）：

- **取值规则**：字符串是选择器（HTML 选择器或 JSON 路径），对象写法覆盖属性、回退链、
  过滤、变换、条件、语言映射与数组查找。
- **模板与空值**：`{占位}` 求值为空则整条模板作废、落到模板链的下一条；整链为空就不抓取。
- **多步请求**：`request` 是有序的步骤列表，后一步的 `url` 可以用 `vars` 里从前面步骤响应
  取出的值（「先取章节列表，再按章节号取正文」这类站点）。
- **隐藏值**：`hidden` 声明的值不会进界面数据，由应用按源缓存起来供后续 op 用（系列 URL、
  章节中转链这类）。
- **钩子**：`script` 是文档内嵌的 JS，只用在文档表达不了的算法上。它有两个位置：
  `ops.<op>.script` 给出该 op 的最终值（`manhuagui.json` 的 `p.a.c.k.e.r` 解包），`items` 上的
  `script` 只给出单元列表、字段仍走声明式（`hentara.json` 的本地搜索）。写在别处会被拒——
  运行时不会读它，与其静默失效不如报错。

  钩子拿到一个 `api`：`op` / `payload` / `ctx` / `responses` / `doc` / `root`，外加共享前导
  `helpers`（`collapse`、`trim`、`stripTags`、`unescape`、`after`、`before`、`firstOn`、
  `digitsAfter`、`param`、`absoluteUrl`、`isImageUrl`、`jsonPath`、`scalar`、`str`、
  `applyTransform`、`applyFilter`——与声明式层同一份实现，不必再抄一遍）与
  `select(html, selector)`（宿主选择器，返回 `{attrs, text, html}` 的数组）。沙箱里有
  `RegExp`，但单次求值只有 2 秒墙钟，正则要避免灾难性回溯。

## 加一个源 / 改一个源

1. 往 `sources/` 放一份文档（文件名 = 文档里的 `id`）。
2. 跑 `node build.mjs` 重新生成 `sources.json`（它会算好 sha256、内容变了自动升版本）。
3. 提交。应用侧「读取源目录」就能看到它。

改一个源同理：改 `sources/<id>.json` 再跑一次 `build.mjs`。版本号不用手改。

## 文件

| 文件 | 说明 |
|---|---|
| `sources/*.json` | 各源文档（手写、评审的对象） |
| `runtime.js` | 源运行时（解释文档的共享 JS；应用内置一份同样的副本，这里的是更新通道） |
| `build.mjs` | 由上面两者生成 `sources.json` |
| `sources.json` | **生成产物**，别手改 |

`runtime.js` 由应用仓库同步过来（`desktop/crates/mojuan-core/src/js/runtime.js`）：它既是
索引里 `runtime.script` 的来源，也是应用可以远程更新的那份。

文档的 JSON Schema 不在本仓库里，出口是 `https://mojuan.fengw.site/schema.json`
（由应用的 Rust 结构体生成，见 `updater/README.md`）。
