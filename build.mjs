// 生成源仓库索引 sources.json。
//
// 索引形状（客户端 fw6/mojuan 的源管理页按它取）：
//
//   {
//     "runtime": { "version": 1, "script": "<runtime.js 全文>", "sha256": "…" },
//     "sources": {
//       "webtoons": { "name": "Webtoons", "version": 2, "document": "<源文档全文>", "sha256": "…" }
//     }
//   }
//
// sha256 是对字符串的 UTF-8 字节算的（与客户端 sha256Hex 一致）：客户端装之前会重算一遍，
// 不符就拒绝替换。
//
// 版本号由这个脚本维护：内容（sha256）变了就 +1，没变就沿用上一版的号。客户端按
// 「索引版本 > 已装版本」判断有没有更新，所以手改版本号是多余的。
//
// 用法（在本仓库根目录）：node build.mjs

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const INDEX = join(ROOT, "sources.json");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** 上一版索引（没有就当成空的）。 */
function previousIndex() {
    try {
        return JSON.parse(readFileSync(INDEX, "utf8"));
    } catch {
        return { runtime: null, sources: {} };
    }
}

/** 内容没变就沿用上一版的版本号，变了才 +1。 */
function nextVersion(prev, script) {
    if (prev && prev.sha256 === sha256(script)) {
        return prev.version;
    }
    return (prev?.version ?? 0) + 1;
}

function readSourceIds() {
    return readdirSync(join(ROOT, "sources"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .sort();
}

const prev = previousIndex();

const runtimeScript = readFileSync(join(ROOT, "runtime.js"), "utf8");
const runtime = {
    version: nextVersion(prev.runtime, runtimeScript),
    script: runtimeScript,
    sha256: sha256(runtimeScript),
};

const sources = {};
for (const id of readSourceIds()) {
    const document = readFileSync(join(ROOT, "sources", `${id}.json`), "utf8");
    const parsed = JSON.parse(document);
    if (parsed.id !== id) {
        throw new Error(`sources/${id}.json 里的 id 是 ${parsed.id}，与文件名不一致`);
    }
    sources[id] = {
        name: parsed.title,
        version: nextVersion(prev.sources?.[id], document),
        document,
        sha256: sha256(document),
    };
}

writeFileSync(INDEX, `${JSON.stringify({ runtime, sources }, null, 2)}\n`);
const summary = Object.entries(sources)
    .map(([id, s]) => `${id} v${s.version}`)
    .join("、");
console.log(`已写入 sources.json：runtime v${runtime.version}；${summary}`);
