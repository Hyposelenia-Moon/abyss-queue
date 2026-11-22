#!/usr/bin/env node
/**
 * 把一张 xlsx 表迁移成状态文档（`queue.json`），可选再导出一份“简单工作簿”用于对账。
 *
 * 用法：
 *   node tools/migrate.mjs <源表.xlsx> [--out <queue.json>] [--export <导出.xlsx>] [--force]
 *
 * 规则（与 `docs/queue.schema.md` 一致）：
 *   - 只读源表，绝不改写它；`--out` 指向同一路径会被拒绝；
 *   - 账号强度（F 列）在导入时丢弃；标题改成榜名本身（不带日期、不带“排队”）；
 *   - 空行按占位记录保留，表头前的顶部区原文保留；
 *   - 已存在的输出要加 `--force` 才覆盖。
 */
import fs from "node:fs"
import path from "node:path"
import { importWorkbook } from "../model/doc-import.js"
import { exportWorkbook } from "../model/doc-export.js"
import { docFileOf, readDoc, writeDoc } from "../model/queue-doc.js"

const args = process.argv.slice(2)
const pos = []
const opts = { force: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--force") opts.force = true
  else if (a === "--out") opts.out = args[++i]
  else if (a === "--export") opts.export = args[++i]
  else if (a === "--help" || a === "-h") {
    console.log("用法：node tools/migrate.mjs <源表.xlsx> [--out <queue.json>] [--export <导出.xlsx>] [--force]")
    process.exit(0)
  } else if (a.startsWith("--")) fail(`不认识的参数：${a}`)
  else pos.push(a)
}

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

if (pos.length !== 1) fail("要给一张源表：node tools/migrate.mjs <源表.xlsx>")
const source = path.resolve(pos[0])
const out = path.resolve(opts.out ?? docFileOf(source))
const exported = opts.export ? path.resolve(opts.export) : null

if (!fs.existsSync(source)) fail(`源表不存在：${source}`)
if (out === source) fail("输出路径不能和源表是同一个文件")
const sameFile = (a, b) => path.extname(a).toLowerCase() === path.extname(b).toLowerCase() && path.resolve(a) === path.resolve(b)
if (exported && sameFile(exported, source)) fail("导出路径不能和源表是同一个文件")

for (const target of [out, exported].filter(Boolean)) {
  if (fs.existsSync(target) && !opts.force) fail(`输出已存在：${target}（要覆盖请加 --force）`)
}

const doc = await importWorkbook(fs.readFileSync(source))
doc.revision = Math.max(1, Number(doc.revision) || 0)
const only = doc.sheets.map(s => ({
  name: s.name,
  kind: s.kind,
  top: s.top.length,
  rows: s.rows.length,
  options: [s.options?.anchor?.length ?? 0, s.options?.goal?.length ?? 0, s.options?.status?.length ?? 0],
}))

fs.mkdirSync(path.dirname(out), { recursive: true })
await writeDoc(out, doc, { backup: false })
if (exported) {
  const saved = await readDoc(out)
  fs.mkdirSync(path.dirname(exported), { recursive: true })
  fs.writeFileSync(exported, await exportWorkbook(saved))
}

console.log(`✅ 已迁移：${source}`)
console.log(`   状态文档：${out}（${doc.sheets.length} 页签，revision ${doc.revision}）`)
for (const s of only) console.log(`   - ${s.name}：顶部 ${s.top} 行 / 数据 ${s.rows} 行 / 下拉 ${s.options.join("·")}`)
if (exported) console.log(`   导出副本：${exported}`)
console.log("   下一步：node tools/verify.mjs <源表.xlsx> --doc " + out)
