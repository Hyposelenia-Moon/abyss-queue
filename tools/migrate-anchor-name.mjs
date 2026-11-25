#!/usr/bin/env node
/**
 * 一次性迁移：把表里的「都可以」改成「公共队列」
 *
 * 2026-11-25 起，「选择主播」里的公共队列选项从「都可以」改名为「公共队列」。
 * 代码侧只认新名字，**老表必须先迁移**（没有兼容分支）：
 *   - D 列（选择主播）的**数据验证下拉**里那一项；
 *   - 老单元格里已经选成「都可以」的那些行。
 *
 * 这份脚本只做这两件事，其余内容（样式、公式、其它列的下拉、合并格）一个字都不动：
 * 直接改 zip 里的 XML 文本，不经 xlsx 库重写 —— 重写会丢掉列宽、条件格式之类的细节。
 *
 * 用法：
 *   node tools/migrate-anchor-name.mjs <表.xlsx>              # 原地改（先留一份 .before-public-queue.bak）
 *   node tools/migrate-anchor-name.mjs <表.xlsx> --out 新.xlsx # 改到新文件（原文件不动）
 *   node tools/migrate-anchor-name.mjs <表.xlsx> --dry        # 只报告会改几处，不写盘
 *
 * @module tools/migrate-anchor-name
 */
import fs from "node:fs"
import path from "node:path"

import JSZip from "jszip"

const OLD = "都可以"
const NEW = "公共队列"

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(a => a.startsWith("--")))
const positional = argv.filter(a => !a.startsWith("--"))
const outIndex = argv.indexOf("--out")
const outPath = outIndex >= 0 ? argv[outIndex + 1] : ""
const src = positional.find(a => a !== outPath)

if (!src) {
  console.error("用法：node tools/migrate-anchor-name.mjs <表.xlsx> [--out 新.xlsx] [--dry]")
  process.exit(2)
}
if (!fs.existsSync(src)) {
  console.error(`找不到表：${src}`)
  process.exit(2)
}

/** 计数：改了哪些文件、各几处 */
const changed = []
const zip = await JSZip.loadAsync(fs.readFileSync(src))

/**
 * 只改这两个位置：
 *   - `xl/sharedStrings.xml`：单元格文本与下拉里那份共享字符串
 *   - `xl/worksheets/*.xml`：`<dataValidation>` 里的 `formula1` 直接写死的下拉清单
 */
const targets = Object.keys(zip.files).filter(
  name => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(name),
)

for (const name of targets) {
  const file = zip.file(name)
  if (!file) continue
  const before = await file.async("string")
  if (!before.includes(OLD)) continue
  const after = before.split(OLD).join(NEW)
  const hits = before.split(OLD).length - 1
  changed.push({ name, hits })
  zip.file(name, after)
}

const total = changed.reduce((n, x) => n + x.hits, 0)
if (!total) {
  console.log(`✅ 没有需要迁移的内容：${src}（找不到「${OLD}」）`)
  process.exit(0)
}
console.log(`找到 ${total} 处「${OLD}」→「${NEW}」：${changed.map(x => `${x.name}（${x.hits}）`).join("、")}`)
if (flags.has("--dry")) {
  console.log("（--dry：没有写盘）")
  process.exit(0)
}

const dest = outPath || src
if (!outPath) {
  const bak = `${src}.before-public-queue.bak`
  fs.copyFileSync(src, bak)
  console.log(`原文件已备份：${bak}`)
}
const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
fs.writeFileSync(dest, buf)
console.log(`✅ 已写出：${dest}（${buf.length} 字节）`)
if (!outPath && path.basename(src) === "空模板.xlsx") console.log("提示：这是仓库里的空模板，直接提交即可。")
