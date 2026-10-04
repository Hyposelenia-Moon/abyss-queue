/**
 * 合成快照夹具：AQ-09 / AQ-10 两套回归共用
 *
 * 这两套需要"内容可控、能建出业务模型"的 xlsx：
 *   - AQ-09（缓存键）要一对 **工作表 XML 一字不动、只有 sharedStrings 变** 的对照文件
 *   - AQ-10（有效备份）要一份"是合法 ZIP、但表结构建不出模型"的异常快照
 * 真实表格做不到这两点（随便一改整个二进制都不同），所以这里用 jszip 现搭一个最小 xlsx。
 *
 * 文本一律走共享字符串（`t="s"` + `<v>下标</v>`），与真实表格和 WPS/Excel 的产出一致：
 * 只比工作表 XML 的缓存判断会在这里露馅。下标固定为
 * 0 序号 / 1 群昵称 / 2 原神游戏名 / 3 帮帮完成情况 / 4 游戏名 / 5 昵称 / 6 完成情况。
 */
import JSZip from "jszip"

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c])

/** 正常表体：第 1 行表头、第 2 行一名成员，全部走共享字符串 */
const NORMAL_SHEET = `<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" t="s"><v>4</v></c><c r="D2" t="s"><v>6</v></c></row>
</sheetData>`

/** 表结构异常：三张表名对得上，但 A 列没有「序号」表头 → buildModel() 会抛错 */
const HEADERLESS_SHEET = `<sheetData>
<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="s"><v>1</v></c></row>
</sheetData>`

/** 下标的含义固定，改内容只改这张表 */
export const sharedItems = ({ nickname = "审核昵称", status = "排队中", gameName = "审核游戏名" } = {}) => [
  "序号",
  "群昵称",
  "原神游戏名",
  "帮帮完成情况",
  gameName,
  nickname,
  status,
]

const sharedXml = items =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${items.length}" uniqueCount="${items.length}">` +
  items.map(t => `<si><t>${esc(t)}</t></si>`).join("") +
  `</sst>`

/**
 * 打一个最小可用的 xlsx
 *
 * 只放 openWorkbook() 真正会读的四个部件：workbook.xml、它的 rels、工作表、共享字符串。
 *
 * @param {object} [opts]
 * @param {string} [opts.sheetName] 工作表名（默认与真实表一致的「幽境危战」）
 * @param {string[]} [opts.items] 共享字符串表内容（下标见文件头）
 * @param {string} [opts.sheetBody] 覆盖 sheetData（造"表结构异常"用）
 * @returns {Promise<Buffer>}
 */
export async function zipSnapshot({ sheetName = "幽境危战", items = sharedItems(), sheetBody = NORMAL_SHEET } = {}) {
  const zip = new JSZip()
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
  )
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetBody}</worksheet>`,
  )
  zip.file("xl/sharedStrings.xml", sharedXml(items))
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

/** 表结构异常的快照：合法 ZIP、表名也对，但没有业务表头 */
export const headerlessSnapshot = (opts = {}) => zipSnapshot({ ...opts, sheetBody: HEADERLESS_SHEET })
