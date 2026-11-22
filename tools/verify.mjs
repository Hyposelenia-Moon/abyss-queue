#!/usr/bin/env node
/**
 * 三向对账：源 xlsx（只读）＝ 状态文档（queue.json）＝ 导出后再导入。
 *
 * 用法：
 *   node tools/verify.mjs <源表.xlsx> [--doc <queue.json>] [--export <导出.xlsx>]
 *
 * 比对口径（`docs/queue.schema.md`）：
 *   - 页签顺序与名字一致；
 *   - 表头 A–G 的文字一致（B 列的换行也算）；
 *   - 顶部区（表头前的行）逐格一致，F 列（账号强度）不参与；
 *   - 数据区每行的 6 个字段一致，空行占位也算；
 *   - 三列下拉（选择主播 / 目标 / 完成情况）的选项一致。
 *
 * 退出码：0 全一致；1 有差异或文件缺失。
 */
import fs from "node:fs"
import path from "node:path"
import { importWorkbook } from "../model/doc-import.js"
import { exportWorkbook } from "../model/doc-export.js"
import { docFileOf, readDoc } from "../model/queue-doc.js"

const args = process.argv.slice(2)
const pos = []
const opts = {}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--doc") opts.doc = args[++i]
  else if (a === "--export") opts.export = args[++i]
  else if (a === "--help" || a === "-h") {
    console.log("用法：node tools/verify.mjs <源表.xlsx> [--doc <queue.json>] [--export <导出.xlsx>]")
    process.exit(0)
  } else if (a.startsWith("--")) {
    console.error(`❌ 不认识的参数：${a}`)
    process.exit(1)
  } else pos.push(a)
}

const ROW_FIELDS = ["nickname", "gameName", "anchor", "goal", "note", "status"]

const fail = message => {
  console.error(`❌ ${message}`)
  process.exit(1)
}

const normalize = doc => ({
  sheets: doc.sheets.map(s => ({
    name: String(s.name),
    header: ["A", "B", "C", "D", "E", "F", "G"].map(letter => String(s.header?.[letter] ?? "")),
    top: s.top.map((rec, index) => {
      const cells = Object.keys(rec ?? {})
        /** F 列（账号强度）已丢弃；第 1 行 A 格是标题，按榜名推导，不比旧文字 */
        .filter(letter => letter !== "F" && !(index === 0 && letter === "A"))
        .sort()
        .map(letter => `${letter}=${String(rec[letter] ?? "")}`)
      return cells.join("\u0001")
    }),
    rows: s.rows.map(r =>
      r?.blank === true ? "<blank>" : ROW_FIELDS.map(key => String(r?.[key] ?? "")).join("\u0001"),
    ),
    options: {
      anchor: [...(s.options?.anchor ?? [])],
      goal: [...(s.options?.goal ?? [])],
      status: [...(s.options?.status ?? [])],
    },
  })),
})

const label = {
  header: "表头",
  top: "顶部区",
  rows: "数据行",
  options: "下拉选项",
}

/** 返回第一条差异的文字说明；一致则 null */
const firstDiff = (a, b) => {
  if (a.sheets.length !== b.sheets.length)
    return `页签数量不同：${a.sheets.length} vs ${b.sheets.length}（${a.sheets.map(s => s.name).join("、")} vs ${b.sheets.map(s => s.name).join("、")}）`
  for (let i = 0; i < a.sheets.length; i++) {
    const x = a.sheets[i]
    const y = b.sheets[i]
    if (x.name !== y.name) return `第 ${i + 1} 个页签名字不同：${x.name} vs ${y.name}`
    for (const key of ["header", "top", "rows", "options"]) {
      const ax = JSON.stringify(x[key])
      const by = JSON.stringify(y[key])
      if (ax === by) continue
      if (Array.isArray(x[key]) && x[key].length !== y[key].length)
        return `${x.name} 的${label[key]}条数不同：${x[key].length} vs ${y[key].length}`
      if (Array.isArray(x[key])) {
        const at = x[key].findIndex((_, j) => JSON.stringify(x[key][j]) !== JSON.stringify(y[key][j]))
        return `${x.name} 的${label[key]}第 ${at + 1} 条不同：${JSON.stringify(x[key][at])} vs ${JSON.stringify(y[key][at])}`
      }
      return `${x.name} 的${label[key]}不同`
    }
  }
  return null
}

if (pos.length !== 1) fail("要给一张源表：node tools/verify.mjs <源表.xlsx>")
const source = path.resolve(pos[0])
if (!fs.existsSync(source)) fail(`源表不存在：${source}`)
const docFile = path.resolve(opts.doc ?? docFileOf(source))
if (!fs.existsSync(docFile)) fail(`状态文档不存在：${docFile}（先跑 tools/migrate.mjs）`)

const sourceDoc = await importWorkbook(fs.readFileSync(source))
let doc
try {
  doc = await readDoc(docFile)
} catch (err) {
  fail(`状态文档读不了：${err.message}`)
}

const exportedBuf = opts.export
  ? fs.readFileSync(path.resolve(opts.export))
  : await exportWorkbook(doc)
const exportedDoc = await importWorkbook(exportedBuf)

const a = normalize(sourceDoc)
const b = normalize(doc)
const c = normalize(exportedDoc)

/** 标题是推导出来的：状态文档里第 1 行 A 格必须等于榜名（迁移时不再沿用旧表文字） */
for (const sheet of doc.sheets) {
  const title = String(sheet.top?.[0]?.A ?? "")
  if (title !== sheet.name) fail(`「${sheet.name}」的标题应是榜名本身，实际是 ${JSON.stringify(title)}`)
}

const ab = firstDiff(a, b)
const bc = firstDiff(b, c)
if (ab || bc) {
  console.error("❌ 三向对账失败")
  if (ab) console.error(`   源表 ↔ 状态文档：${ab}`)
  if (bc) console.error(`   状态文档 ↔ 导出：${bc}`)
  process.exit(1)
}

console.log(`✅ 三向对账通过：${doc.sheets.length} 个页签`)
for (const s of b.sheets)
  console.log(`   - ${s.name}：顶部 ${s.top.length} 行 / 数据 ${s.rows.length} 行 / 下拉 ${s.options.anchor.length}·${s.options.goal.length}·${s.options.status.length}`)
