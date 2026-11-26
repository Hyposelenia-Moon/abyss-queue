/** 状态文档 → xlsx（导出 / 镜像） */
import JSZip from "jszip"
import { escapeXml, colToIndex } from "./xlsx.js"
import { ROW_FIELDS } from "./queue-doc.js"

const FIELD_COLUMN = { nickname: "B", gameName: "C", anchor: "D", goal: "E", note: "F", status: "G" }

const VALIDATION_COLUMN = { anchor: "D", goal: "E", status: "G" }

const clean = s => String(s ?? "").trim()
const withSpace = text => (/^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : "")

const sheetRef = index => `xl/worksheets/sheet${index + 1}.xml`

const cellText = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t${withSpace(text)}>${escapeXml(text)}</t></is></c>`

const cellFormula = (ref, formula, cached) =>
  `<c r="${ref}"><f>${escapeXml(formula)}</f>${cached === undefined ? "" : `<v>${escapeXml(cached)}</v>`}</c>`
const rowXml = (rowNum, cells) => {
  if (!cells.length) return ""
  return `<row r="${rowNum}">${cells.join("")}</row>`
}

function validationXml(column, values, dataStart, dataEnd) {
  const list = [...new Set(values.map(v => String(v ?? "").replace(/["\r\n]/g, "")).filter(Boolean))]
  if (!list.length) return ""
  const sqref = `${column}${dataStart}:${column}${dataEnd}`
  const formula = escapeXml(`"${list.join(",")},"`)
  return `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="warning" sqref="${sqref}"><formula1>${formula}</formula1></dataValidation>`
}

export function sheetXmlOf(sheet) {
  const headerRow = sheet.top.length + 1
  const dataStart = headerRow + 1
  const prefill = Number.isInteger(sheet.prefill) && sheet.prefill >= 0 ? sheet.prefill : 100
  const lastRow = headerRow + Math.max(prefill, sheet.rows.length)
  const rows = []
  sheet.top.forEach((rec, index) => {
    const cells = []
    for (const [letter, text] of Object.entries(rec).sort((a, b) => (colToIndex(a[0]) ?? 0) - (colToIndex(b[0]) ?? 0))) {
      if (letter === "F") continue
      const value = String(text ?? "")
      if (!value) continue
      cells.push(cellText(`${letter}${index + 1}`, value))
    }
    rows.push(rowXml(index + 1, cells))
  })
  const headerCells = []
  for (const letter of ["A", "B", "C", "D", "E", "F", "G"]) {
    const text = String(sheet.header?.[letter] ?? "")
    if (text) headerCells.push(cellText(`${letter}${headerRow}`, text))
  }
  rows.push(rowXml(headerRow, headerCells))
  const seqFormula = `ROW()-${headerRow}`
  for (let i = 0; i < lastRow - dataStart + 1; i++) {
    const rec = sheet.rows[i]
    const cells = [cellFormula(`A${dataStart + i}`, seqFormula, String(i + 1))]
    if (rec && rec.blank !== true) {
      for (const key of ROW_FIELDS) {
        const text = clean(rec[key])
        if (text) cells.push(cellText(`${FIELD_COLUMN[key]}${dataStart + i}`, text))
      }
    }
    rows.push(rowXml(dataStart + i, cells))
  }
  const validations = []
  for (const [key, column] of Object.entries(VALIDATION_COLUMN)) {
    const list = sheet.options?.[key]
    if (!Array.isArray(list) || !list.length) continue
    const xml = validationXml(column, list, dataStart, lastRow)
    if (xml) validations.push(xml)
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:I${lastRow}"/>` +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<sheetData>${rows.join("")}</sheetData>` +
    (validations.length ? `<dataValidations count="${validations.length}">${validations.join("")}</dataValidations>` : "") +
    "</worksheet>"
  )
}

const CONTENT_TYPES = (count) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  Array.from({ length: count }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
  "</Types>"
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>"
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>"
const workbookXml = (sheets) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  "<sheets>" +
  sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
  "</sheets>" +
  '<calcPr calcId="0" fullCalcOnLoad="1"/>' +
  "</workbook>"
const workbookRels = (count) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  Array.from({ length: count }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
  `<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  "</Relationships>"
export async function exportWorkbook(doc) {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", CONTENT_TYPES(doc.sheets.length))
  zip.file("_rels/.rels", ROOT_RELS)
  zip.file("xl/workbook.xml", workbookXml(doc.sheets))
  zip.file("xl/_rels/workbook.xml.rels", workbookRels(doc.sheets.length))
  zip.file("xl/styles.xml", STYLES)
  doc.sheets.forEach((sheet, i) => zip.file(sheetRef(i), sheetXmlOf(sheet)))
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" })
}
