/**
 * 清空行后重新报名的**格式保全**（AQ-15）
 *
 * 表里数据行是逐行配色的（每行的 B–H 各有自己的 s）。清空若把整段 <c> 删掉，
 * 重新报名时只能套用「同列第一个格子的样式」，行自己的底色就丢了
 * （审核报告：剧诗 B9 清空后重新填入，样式号 30 → 37、底色变成第 8 行的）。
 * 这里对空模板的副本做「报名 → 退队 → 再报名」，逐格比对样式号与条件格式/验证/公式。
 *
 * 用法：node test/clearrow-style.test.mjs（没有空模板时整套跳过）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import fsP from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createChecker, Paths } from "./_helper.mjs"
import { openWorkbook, parseSheet } from "../model/xlsx.js"
import { buildModel } from "../model/schema.js"
import { Table } from "../model/table.js"

const { check, finish } = createChecker("清行样式保全")

const TEMPLATE = path.join(Paths.root, "resources", "空模板.xlsx")
if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 没有空模板（${TEMPLATE}）：它是随源码入库的（resources/空模板.xlsx），从仓库里取回来再跑`)
  process.exit(0)
}

/** 只在临时目录里改动：绝不碰 resources/空模板.xlsx */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-queue-clear-"))
const file = path.join(dir, "queue.xlsx")
await fsP.copyFile(TEMPLATE, file)

const table = new Table({ file, backup: false })
const COLUMNS = ["B", "C", "D", "E", "F", "G", "H"]

/** 取一行 B–H 的样式号（格子在、但 s 为空也记成空串） */
const stylesOf = (sheet, row) => {
  const out = {}
  for (const col of COLUMNS) out[col] = sheet.rows.get(row)?.cells.get(col)?.style ?? null
  return out
}
/** 同一行 B–H 的样式是否逐格一致 */
const sameStyles = (a, b) => COLUMNS.every(col => a[col] === b[col])
const diffOf = (a, b) => COLUMNS.filter(col => a[col] !== b[col]).map(col => `${col}:${a[col] ?? "无"}→${b[col] ?? "无"}`).join("、")

/** 读取某一榜的原始 XML 与解析结果（shared 一并带出：表头等文本在 sharedStrings 里） */
async function snapshot(sheetName) {
  const wb = await openWorkbook(await fsP.readFile(file))
  const xml = await wb.sheetXml(sheetName)
  return { xml, shared: wb.shared, sheet: parseSheet(xml, wb.shared) }
}

/** 结构类要素计数（清空/重填都不该动它们） */
const features = xml => ({
  conditional: xml.split("<conditionalFormatting").length - 1,
  validation: xml.split("<dataValidation").length - 1,
  formula: xml.split("<f").length - 1,
  merge: xml.split("<mergeCell").length - 1,
})

/** 三个榜各自找一行「数据区里有样式的行」做用例（模板里 A 列序号公式 + B–H 有底色） */
const targets = []
{
  const wb = await openWorkbook(await fsP.readFile(file))
  for (const s of wb.sheets) {
    const xml = await wb.sheetXml(s.name)
    const sheet = parseSheet(xml, wb.shared)
    const model = buildModel({ name: s.name, xml, shared: wb.shared })
    let row = 0
    for (let r = model.dataStart; r <= model.dataEnd; r++) {
      const cells = sheet.rows.get(r)?.cells
      if (cells && COLUMNS.some(c => cells.get(c))) {
        row = r
        break
      }
    }
    if (!row) {
      console.log(`⏭ ${s.name} 数据区没有带样式的行，跳过该榜`)
      continue
    }
    targets.push({ name: s.name, row, before: features(xml), styles: stylesOf(sheet, row) })
  }
}

check("模板里选到了带样式的数据行（前置）", () => assert.ok(targets.length > 0, "三个榜都没找到带样式的数据行"))

for (const t of targets) {
  console.log(`\n【${t.name} 第 ${t.row} 行】`)

  /** 1) 报名：写入必填四项（模拟编辑器的一次保存） */
  await table.mutate(ctx => {
    for (const [k, v] of Object.entries({
      nickname: "样式回归",
      gameName: "样式回归游戏",
      anchor: "样式主播",
      goal: "无畏(N5)",
      strength: "低配",
      note: "样式回归备注",
      status: "排队中",
    }))
      ctx.setCell(t.name, t.row, k, v)
  })
  const afterJoin = await snapshot(t.name)
  check("报名后数据已落表", () => {
    const model = buildModel({ name: t.name, xml: afterJoin.xml, shared: afterJoin.shared })
    const row = model.rows.find(r => r.row === t.row)
    assert.ok(row, `第 ${t.row} 行没有数据`)
    assert.equal(row.nickname, "样式回归")
  })
  check("报名写入的样式 = 该行原有样式", () =>
    assert.ok(sameStyles(stylesOf(afterJoin.sheet, t.row), t.styles), diffOf(stylesOf(afterJoin.sheet, t.row), t.styles)),
  )

  /** 2) 退队：清空这一行 */
  await table.mutate(ctx => ctx.clearRow(t.name, t.row))
  const afterClear = await snapshot(t.name)
  const clearedStyles = stylesOf(afterClear.sheet, t.row)
  check("清空后这一行不再是数据行", () => {
    const model = buildModel({ name: t.name, xml: afterClear.xml, shared: afterClear.shared })
    assert.equal(model.rows.find(r => r.row === t.row), undefined, `第 ${t.row} 行仍被当成数据行`)
  })
  check("清空后 B–H 的值确实没了", () => {
    for (const col of COLUMNS) {
      const cell = afterClear.sheet.rows.get(t.row)?.cells.get(col)
      assert.ok(!cell || !cell.value, `${col}${t.row} 还有值「${cell?.value}」`)
    }
  })
  check("清空保留了原行的样式（AQ-15 核心）", () =>
    assert.ok(sameStyles(clearedStyles, t.styles), `样式被改成：${diffOf(clearedStyles, t.styles)}`),
  )
  check("清空没有动条件格式/验证/公式/合并单元格", () =>
    assert.deepEqual(features(afterClear.xml), t.before, "结构类要素数量变化"),
  )

  /** 3) 重新报名：同一行（firstEmptyRow 会回到这一行） */
  await table.mutate(ctx => {
    ctx.setCell(t.name, t.row, "nickname", "样式回归2")
    ctx.setCell(t.name, t.row, "goal", "险恶(N4)")
    ctx.setCell(t.name, t.row, "status", "排队中")
  })
  const afterRejoin = await snapshot(t.name)
  check("重新报名的样式仍等于原行样式（退队→再报名不丢格式）", () => {
    const now = stylesOf(afterRejoin.sheet, t.row)
    assert.ok(sameStyles(now, t.styles), `样式变了：${diffOf(now, t.styles)}`)
  })
  check("重新报名后可正常读取", () => {
    const model = buildModel({ name: t.name, xml: afterRejoin.xml, shared: afterRejoin.shared })
    const row = model.rows.find(r => r.row === t.row)
    assert.ok(row, `第 ${t.row} 行没有数据`)
    assert.equal(row.nickname, "样式回归2")
    assert.equal(row.goal, "险恶(N4)")
  })
  check("重新报名没有动结构类要素", () => assert.deepEqual(features(afterRejoin.xml), t.before))
}

/** 4) 「空行」的判定：清空后保留的空样式格不能被误当成数据（firstEmptyRow 要认它） */
{
  const { firstEmptyRow } = await import("../modules/queue.js")
  const name = targets[0].name
  const row = targets[0].row

  const readModel = async () => {
    const wb = await openWorkbook(await fsP.readFile(file))
    return buildModel({ name, xml: await wb.sheetXml(name), shared: wb.shared })
  }

  await table.mutate(ctx => ctx.clearRow(name, row))
  const cleared = await readModel()
  check("清空后该行重新成为「第一个空行」（空样式格不算数据）", () => {
    assert.equal(firstEmptyRow(cleared), row, `预期第 ${row} 行，实际 ${firstEmptyRow(cleared)}`)
    assert.equal(cleared.rows.find(r => r.row === row), undefined, "清空的行不该出现在 rows 里")
  })

  await table.mutate(ctx => {
    ctx.setCell(name, row, "nickname", "空行判定")
    ctx.setCell(name, row, "goal", "无畏(N5)")
  })
  const rejoined = await readModel()
  check("重新报名后空行顺延到下一行", () =>
    assert.equal(firstEmptyRow(rejoined), row + 1, `预期第 ${row + 1} 行，实际 ${firstEmptyRow(rejoined)}`),
  )
}

console.log(`\n测试产物：${file}`)
await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
