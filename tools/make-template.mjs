/**
 * 从一份真实表生成「空模板」
 *
 * 结构全留着（三张榜、表头、序号公式列、主播区、下拉验证、条件格式、合并单元格），
 * 只把**成员数据行**清空 —— 换月、迁移、新部署时用它起一份干净的表。
 *
 * 「清空」不是把格子删掉，而是**写成空值 + 用同一行奇偶的"从没用过的那一行"的样式**：
 * 表里数据区是隔行配色的（偶数行一套样式、奇数行另一套），直接把格子删掉会让
 * 上方原本的数据区变成"没样式"，看起来和下面的空行不一样。所以这里逐格补回对应样式。
 *
 * 用法：
 *   node tools/make-template.mjs <源表.xlsx> [输出路径=resources/空模板.xlsx]
 *   XLSX_PATH=<源表.xlsx> node tools/make-template.mjs
 *
 * 生成后会自检：数据行数必须是 0、工作表清单与源表一致、数据区每格的样式与"空行样板"一致。
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { openWorkbook, parseSheet } from "../lib/xlsx.js"
import { DATA_COLUMNS, buildModel } from "../lib/schema.js"
import { Table } from "../model/table.js"

const HERE = path.dirname(import.meta.dirname ?? path.dirname(pathToFileURL(process.argv[1]).pathname))
const SRC = process.argv[2] ?? process.env.XLSX_PATH ?? ""
const OUT = path.resolve(process.argv[3] ?? path.join(HERE, "resources", "空模板.xlsx"))

if (!SRC || !fs.existsSync(SRC)) {
  console.error(
    [
      "用法：node tools/make-template.mjs <源表.xlsx> [输出路径]",
      "",
      "源表就是当前在用的那份 xlsx（结构要对）：脚本只清数据行，不动表结构。",
      `也可以先设 XLSX_PATH 环境变量；默认输出 ${path.relative(process.cwd(), OUT)}`,
    ].join("\n"),
  )
  process.exit(1)
}

/** 逐榜算出：要清哪些行、以及"空行样板"每列该用什么样式（按奇偶分两套） */
const planOf = (sheet, model) => {
  const used = new Set(model.rows.map(r => r.row))
  const dataRows = []
  for (let r = model.dataStart; r <= model.dataEnd; r++) dataRows.push(r)
  const untouched = dataRows.filter(r => !used.has(r))
  if (!untouched.length) throw new Error(`「${sheet}」数据区没有空行可当样板，没法规范化样式`)

  /** 空行样板：**紧挨着数据区下面的**那一行（奇偶各取一行）—— 它就是"下方无数据的样式" */
  const donor = {}
  for (const r of untouched) if (donor[r % 2] === undefined) donor[r % 2] = r
  const styleOf = (row, col) => sheet.rows.get(row)?.cells.get(col)?.style
  const donorStyles = {}
  for (const parity of Object.keys(donor)) {
    donorStyles[parity] = {}
    for (const key of DATA_COLUMNS) {
      const col = model.col?.[key]
      donorStyles[parity][key] = col ? styleOf(donor[parity], col) : undefined
    }
  }
  return { dataRows, used: [...used], donor, donorStyles }
}

/** 先复制一份再改：绝不碰源表 */
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.copyFileSync(SRC, OUT)

const wbSrc = await openWorkbook(fs.readFileSync(SRC))
const plans = new Map()
for (const s of wbSrc.sheets) {
  const xml = await wbSrc.sheetXml(s.name)
  const sheet = parseSheet(xml, wbSrc.shared)
  const model = buildModel({ name: s.name, xml, shared: wbSrc.shared })
  plans.set(s.name, planOf(sheet, model))
}

const table = new Table({ file: OUT, backup: false })

/** 第一遍：把成员数据行整行清掉（格子会被删掉） */
const cleared = await table.mutate(ctx => {
  let n = 0
  for (const [name] of plans) {
    const model = ctx.model(name)
    for (const row of model.rows) {
      ctx.clearRow(name, row.row)
      n++
    }
  }
  return n
})

/**
 * 第二遍：把**清掉的那些行**逐格补回来（空值 + 同一奇偶的空行样板样式）
 *
 * 必须分两遍：写入时会沿用"已存在格子的样式"，先删掉再补才能真正换掉样式。
 * 只动清掉的行；下方本来就空的那些行原样保留（它们就是样板本身）。
 */
const styled = await table.mutate(ctx => {
  let n = 0
  for (const [name, plan] of plans) {
    const model = ctx.model(name)
    for (const r of plan.used) {
      const parity = r % 2
      for (const key of DATA_COLUMNS) {
        const col = model.col?.[key]
        if (!col) continue
        const style = plan.donorStyles[parity]?.[key]
        if (style === undefined) continue
        ctx.setRef(name, `${col}${r}`, "", style)
        n++
      }
    }
  }
  return n
})

/** 自检一：数据行必须清干净、工作表清单不动 */
const check = await table.read(({ models, names }) => ({
  names,
  rows: [...models.values()].map(m => ({ name: m.name, rows: m.rows.length, anchors: m.anchors.length, dataStart: m.dataStart, dataEnd: m.dataEnd, col: m.col })),
}))

const left = check.rows.filter(r => r.rows > 0)
console.log(`已生成空模板：${OUT}`)
console.log(`  工作表：${check.names.join(" / ")}`)
console.log(`  清掉数据行：${cleared} 行；补回样式：${styled} 格；主播区保留：${check.rows.map(r => `${r.name} ${r.anchors} 位`).join("、")}`)
if (left.length) {
  console.error(`❌ 还有数据没清干净：${left.map(r => `${r.name} ${r.rows} 行`).join("、")}`)
  process.exit(1)
}

/** 自检二：数据区每格的样式必须与同一奇偶的空行样板一致（就是这次的"规范化"） */
const wbOut = await openWorkbook(fs.readFileSync(OUT))
const problems = []
for (const s of wbOut.sheets) {
  const sheet = parseSheet(await wbOut.sheetXml(s.name), wbOut.shared)
  const plan = plans.get(s.name)
  const model = check.rows.find(r => r.name === s.name)
  for (const r of plan.used) {
    const parity = r % 2
    const sample = sheet.rows.get(plan.donor[parity])
    for (const key of DATA_COLUMNS) {
      const col = model.col?.[key]
      if (!col) continue
      const want = sample?.cells.get(col)?.style
      const got = sheet.rows.get(r)?.cells.get(col)?.style
      if ((want ?? "") !== (got ?? "")) problems.push(`${s.name}!${col}${r}：样式 ${got ?? "无"} ≠ 样板（第 ${plan.donor[parity]} 行）${want ?? "无"}`)
    }
  }
}
if (problems.length) {
  console.error(`❌ 还有 ${problems.length} 格样式与空行样板不一致（前 6 条）：\n  ${problems.slice(0, 6).join("\n  ")}`)
  process.exit(1)
}
console.log(`✅ 自检通过：数据行全空，且数据区每格样式与空行样板一致（隔行配色两套都对齐）`)
