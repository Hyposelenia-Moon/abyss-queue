/**
 * 自闭合 `<row/>` 的写入回归（外部审核列为「未计入 16 项的兼容性验证项」）
 *
 * `<row r="9"/>` 是「有行号、没有格子」的**合法**行：Excel / WPS 对"整行清空但留着行格式"
 * 的空行就是这么写的。改动前 `setCellText` 把它跟"这一行不存在"共用一条 insertRow 分支，
 * 原来自闭合那条留在原地 → 同一行号出现两条 `<row>`；再写第二格时 `findRowBlock` 只认最前面
 * 那条（空的自闭合行），又插一条 —— 值被拆进多条同号行，按行号收拢的读路径只留最后一条，
 * 先前写的值就丢了（改动前的复现：写 B11 → 2 条同号行；再写 C11 → 3 条，回读只剩 C11）。
 *
 * 这里钉三件事：
 *   1) 写进自闭合行 → **就地**变成成对标签（行属性保留），该行号的 `<row>` 始终只有一条；
 *   2) 外部留下的同号行在解析时**合并**（不丢格），而不是后来的整条覆盖前面的；
 *   3) 端到端：被测表格里"空行 → 写入 → 落盘重开"，行数不变、不出现同号行。
 *
 * 用法：node test/xlsx-row-tag.test.mjs
 *   默认用真实表；`ABYSS_TEST_SYNTHETIC=1` 时用合成样本（两者都必须通过）。
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { openWorkbook, parseSheet, removeCells, setCellText } from "../lib/xlsx.js"
import { buildModel } from "../lib/schema.js"
import { createChecker, requireSource } from "./_helper.mjs"

/** 被测表格：真实表（或 ABYSS_TEST_SYNTHETIC=1 时的合成样本），只读，全程在内存里改 */
const SOURCE = await requireSource()
const { check, finish } = createChecker("自闭合 <row/> 回归")

/** 某个行号在 XML 里出现了几条 <row>（自闭合与成对都要算） */
const rowCount = (xml, r) => (xml.match(new RegExp(`<row(?=[\\s/>])[^>]*?\\br="${r}"`, "g")) ?? []).length

/** 某个行号的整段标签 */
const rowTagOf = (xml, r) =>
  new RegExp(`<row(?=[\\s/>])[^>]*?\\br="${r}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`).exec(xml)?.[0] ?? ""

/** 把某一行改写成 Excel/WPS 的"空行"写法（自闭合，属性照留） */
function toSelfClosing(xml, r) {
  const m = new RegExp(`<row(?=[\\s/>])([^>]*?\\br="${r}"[^>]*?)(?:/>|>[\\s\\S]*?</row>)`).exec(xml)
  assert.ok(m, `第 ${r} 行不存在，无法改写成自闭合行`)
  return xml.slice(0, m.index) + `<row${m[1]}/>` + xml.slice(m.index + m[0].length)
}

/** 最小工作表：第 1 行表头、第 9 行是自闭合空行、第 10 行是下一行 */
const mini = () =>
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  '<row r="1" spans="1:8"><c r="A1" t="inlineStr"><is><t>序号</t></is></c></row>' +
  '<row r="9" spans="1:8" ht="21" customHeight="1"/>' +
  '<row r="10" spans="1:8"><c r="A10" t="inlineStr"><is><t>下一行</t></is></c></row>' +
  "</sheetData></worksheet>"

async function main() {
  console.log(`被测表格：${SOURCE}\n`)

  console.log("【1】写进自闭合行：就地成对，不产生同号行")
  check("前置：第 9 行确实是自闭合 <row/>", () => {
    assert.equal(rowCount(mini(), 9), 1)
    assert.match(mini(), /<row r="9"[^>]*\/>/, "样本本身应当是自闭合写法")
  })
  check("写入后同号行只有一条，且是成对标签", () => {
    const xml = setCellText(mini(), "B9", "写入甲")
    assert.equal(rowCount(xml, 9), 1, `第 9 行出现了 ${rowCount(xml, 9)} 条 <row>`)
    assert.ok(!/<row r="9"[^>]*\/>/.test(xml), "原来那条自闭合的应当已被替换掉")
    assert.ok(rowTagOf(xml, 9).endsWith("</row>"), `应当是成对标签：${rowTagOf(xml, 9)}`)
    /** 行自己的属性（行高、自定义行高）必须留着，否则空行格式就丢了 */
    assert.ok(rowTagOf(xml, 9).includes('ht="21"'), `行属性丢了：${rowTagOf(xml, 9)}`)
    assert.ok(rowTagOf(xml, 9).includes('customHeight="1"'), `行属性丢了：${rowTagOf(xml, 9)}`)
    assert.ok(xml.indexOf('<row r="9"') < xml.indexOf('<row r="10"'), "行序不该乱")
  })
  check("连写两格仍只有一条同号行，两格都回读得到", () => {
    let xml = setCellText(mini(), "B9", "写入甲")
    xml = setCellText(xml, "C9", "写入乙")
    assert.equal(rowCount(xml, 9), 1, `第 9 行出现了 ${rowCount(xml, 9)} 条 <row>`)
    const cells = parseSheet(xml).rows.get(9)?.cells ?? new Map()
    assert.equal(cells.get("B")?.value, "写入甲", "先写的那格被后来的写入弄丢了")
    assert.equal(cells.get("C")?.value, "写入乙")
  })
  check("行不存在时仍然新建一行（insertRow 那条路没坏）", () => {
    const xml = setCellText(mini(), "B5", "新行")
    assert.equal(rowCount(xml, 5), 1)
    assert.ok(xml.indexOf('<row r="5"') < xml.indexOf('<row r="9"'), "新行应插在第 9 行之前")
    assert.equal(parseSheet(xml).rows.get(5)?.cells.get("B")?.value, "新行")
  })

  console.log("\n【2】外部留下的同号行：解析时合并（防复发）")
  check("两条同号行各带一格 → 两格都读得出来", () => {
    const xml =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="9" ht="21" customHeight="1"/><row r="9" ht="21" customHeight="1"><c r="B9" t="inlineStr"><is><t>前</t></is></c></row>' +
      '<row r="10"><c r="B10" t="inlineStr"><is><t>别的行</t></is></c></row>' +
      "</sheetData></worksheet>"
    const sheet = parseSheet(xml)
    assert.equal(sheet.rows.size, 2, "同号行应当收拢成一行")
    assert.equal(sheet.rows.get(9)?.cells.get("B")?.value, "前")
  })
  check("同号行各写一列 → 合并后两列都在（不是后来的整条覆盖）", () => {
    const xml =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="9"><c r="B9" t="inlineStr"><is><t>前</t></is></c></row>' +
      '<row r="9"><c r="C9" t="inlineStr"><is><t>后</t></is></c></row>' +
      "</sheetData></worksheet>"
    const cells = parseSheet(xml).rows.get(9)?.cells ?? new Map()
    assert.equal(cells.get("B")?.value, "前")
    assert.equal(cells.get("C")?.value, "后")
  })
  check("同一列冲突时以后出现的那条为准", () => {
    const xml =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="9"><c r="B9" t="inlineStr"><is><t>前</t></is></c></row>' +
      '<row r="9"><c r="B9" t="inlineStr"><is><t>后</t></is></c></row>' +
      "</sheetData></worksheet>"
    assert.equal(parseSheet(xml).rows.get(9)?.cells.get("B")?.value, "后")
  })
  check("改动前的产物（自闭合 + 成对同号）也不会把值读丢", () => {
    const xml =
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="9" ht="21" customHeight="1"/>' +
      '<row r="9" ht="21" customHeight="1"><c r="B9" t="inlineStr"><is><t>写入甲</t></is></c></row>' +
      "</sheetData></worksheet>"
    assert.equal(parseSheet(xml).rows.get(9)?.cells.get("B")?.value, "写入甲")
  })

  console.log("\n【3】端到端：清空一行 → 写入 → 落盘重开")
  let e2e = null
  await check("被测表格里的一行按 Excel 空行写法改写后写两格，重开后行数不变且无同号行", async () => {
    const wb = await openWorkbook(await fs.readFile(SOURCE))
    const name = "幽境危战"
    const before = buildModel({ name, xml: await wb.sheetXml(name), shared: wb.shared })
    const row = before.rows[0]?.row
    assert.ok(row > 0, `「${name}」里应当有数据行`)

    /** 模拟"整行清空但留着行格式"：把这条有数据的行改写成自闭合写法 */
    let xml = toSelfClosing(await wb.sheetXml(name), row)
    assert.equal(rowCount(xml, row), 1, "改写后应当只有一条同号行")

    /** 清空 + 连写两格：改动前这里会滚出 3 条同号行 */
    xml = removeCells(xml, ["B", "C", "D", "E", "F", "G", "H"].map(c => `${c}${row}`))
    xml = setCellText(xml, `B${row}`, "写入甲")
    xml = setCellText(xml, `C${row}`, "写入乙")
    assert.equal(rowCount(xml, row), 1, `第 ${row} 行出现了 ${rowCount(xml, row)} 条 <row>`)

    /** 真的过一遍 zip：写盘路径（toBuffer）再读回来 */
    wb.setSheetXml(name, xml)
    const reopened = await openWorkbook(await wb.toBuffer())
    const xml2 = await reopened.sheetXml(name)
    assert.equal(rowCount(xml2, row), 1, `落盘重开后第 ${row} 行出现了 ${rowCount(xml2, row)} 条 <row>`)
    const after = buildModel({ name, xml: xml2, shared: reopened.shared })
    assert.equal(after.rows.length, before.rows.length, "行数不该因为写入而变")
    const item = after.rows.find(i => i.row === row)
    assert.equal(item?.nickname, "写入甲")
    assert.equal(item?.gameName, "写入乙")
    assert.equal(after.rows.filter(i => i.row === row).length, 1, "同一行号不该在模型里出现两次")
    e2e = { row, rows: after.rows.length }
  })

  await finish()
  if (e2e) console.log(`端到端：第 ${e2e.row} 行（重开后共 ${e2e.rows} 行数据）`)
}

main().catch(err => {
  if (err?.message === "__CHECK_FAILED__") process.exit(1)
  console.error(`\n❌ 自闭合 <row/> 回归异常终止：${err?.message ?? err}`)
  process.exit(1)
})
