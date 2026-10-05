/**
 * 空模板：结构在、数据不在、样式规范
 *
 * 换月/新部署都从 `resources/空模板.xlsx` 起一份干净的表，所以它必须：
 *   1. 三个榜都在、表头与序号列认得出来、主播区与下拉还在、**一行成员数据都没有**
 *   2. 数据区里"原本填过人的行"的样式要和"下方从没填过的空行"**一模一样**
 *      （表是隔行配色的，清空时若把格子删掉就会变成没样式，和下面空行对不上）
 *
 * 用法：node test/template.test.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { Paths, createChecker, isRealTable, requireSource } from "./_helper.mjs"
import { Table } from "../model/table.js"
import { openWorkbook, parseSheet } from "../lib/xlsx.js"
import { DATA_COLUMNS, buildModel } from "../lib/schema.js"

const { check, finish } = createChecker("空模板")

const file = path.join(Paths.root, "resources", "空模板.xlsx")
if (!fs.existsSync(file)) {
  console.log(`⏭ 没有空模板（${file}）：它是随源码入库的（resources/空模板.xlsx），从仓库里取回来再跑`)
  process.exit(0)
}

const table = new Table({ file, backup: false })
const info = await table.read(({ models, names }) => ({
  names,
  sheets: [...models.values()].map(m => ({
    name: m.name,
    headerRow: m.headerRow,
    dataStart: m.dataStart,
    rows: m.rows.length,
    anchors: m.anchors.length,
    hasSeq: Boolean(m.col?.seq),
    hasNickname: Boolean(m.col?.nickname),
    statusOptions: m.options?.status?.length ?? 0,
  })),
}))

check("三个榜都在", () => {
  if (info.names.length !== 3) throw new Error(`工作表有 ${info.names.length} 个：${info.names.join(" / ")}`)
  for (const want of ["幻想真境剧诗", "幽境危战", "深境螺旋"])
    if (!info.names.includes(want)) throw new Error(`缺少「${want}」：${info.names.join(" / ")}`)
})

check("每个榜都认得表头与序号列", () => {
  for (const s of info.sheets) {
    if (!s.headerRow) throw new Error(`${s.name} 没认出表头行`)
    if (!s.hasSeq) throw new Error(`${s.name} 没认出序号列`)
    if (!s.hasNickname) throw new Error(`${s.name} 没认出群昵称列`)
  }
})

check("成员数据一行都没有", () => {
  const left = info.sheets.filter(s => s.rows > 0)
  if (left.length) throw new Error(left.map(s => `${s.name} 还有 ${s.rows} 行`).join("、"))
})

check("主播区与下拉选项保留着", () => {
  for (const s of info.sheets) {
    if (!s.anchors) throw new Error(`${s.name} 的主播区没了（模板要保留结构）`)
    if (!s.statusOptions) throw new Error(`${s.name} 的完成情况下拉没了`)
  }
})

/**
 * 样式规范化：拿"源表里那些填过人的行"去比对模板里"下方空行"的样式
 *
 * 这条只有**真实数据**才成立：合成样本是照着空模板现生成的，它的行样式本来就是"空行那种"，
 * 拿它比等于自己跟自己比，看不出任何问题。
 * 源表用 `requireSource()`：真实表不在时会退到合成样本 —— 那时明确说明这条没被验到
 * （不是"整套跳过"，套件其余断言照跑）。
 */
const SRC = process.argv[2] ?? (await requireSource())
if (!fs.existsSync(SRC)) {
  console.log(`⏭ 没有源表（${SRC}），跳过样式比对：可用 XLSX_PATH 指一份 xlsx`)
} else if (!isRealTable(SRC)) {
  console.log(`⏭ 源表是合成样本（${SRC}），样式比对需要真实数据才说明问题，跳过这一条：可用 XLSX_PATH 指一份真实表`)
} else {
  await check("数据区样式与下方空行一致（隔行配色对齐）", async () => {
    const srcWb = await openWorkbook(fs.readFileSync(SRC))
    const outWb = await openWorkbook(fs.readFileSync(file))
    const bad = []
    for (const sheet of srcWb.sheets) {
      const srcModel = buildModel({ name: sheet.name, xml: await srcWb.sheetXml(sheet.name), shared: srcWb.shared })
      const used = new Set(srcModel.rows.map(r => r.row))
      if (!used.size) continue
      const outSheet = parseSheet(await outWb.sheetXml(sheet.name), outWb.shared)
      /** 样板 = 紧挨数据区下面、从没填过人的那一行（奇偶各一行） */
      const donor = {}
      for (let r = srcModel.dataStart; r <= srcModel.dataEnd; r++) {
        if (used.has(r)) continue
        if (donor[r % 2] === undefined) donor[r % 2] = r
      }
      for (const r of used) {
        const sample = outSheet.rows.get(donor[r % 2])
        for (const key of DATA_COLUMNS) {
          const col = srcModel.col?.[key]
          if (!col) continue
          const want = sample?.cells.get(col)?.style ?? ""
          const got = outSheet.rows.get(r)?.cells.get(col)?.style ?? ""
          if (want !== got) bad.push(`${sheet.name}!${col}${r}（${got || "无"}≠${want || "无"}）`)
        }
      }
    }
    if (bad.length) throw new Error(`这些格子的样式和空行不一致：${bad.slice(0, 8).join("、")}${bad.length > 8 ? ` …共 ${bad.length} 格` : ""}`)
  })
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
