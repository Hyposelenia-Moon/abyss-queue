/**
 * 极简 xlsx 容器读写
 *
 * 只做两件事：读单元格、外科手术式改单元格。
 *
 * 为什么不用 exceljs / SheetJS：
 *   这类库把整个工作簿解析后重新序列化，人工维护表格里的
 *   条件格式（如 H 列"排队中"高亮）、数据验证（下拉）、合并单元格、
 *   超链接等会被丢弃或改写。
 *   本模块只替换目标 <c> 节点的文本，其余 XML 原样写回，
 *   写入用 inlineStr 从而完全不动 sharedStrings。
 */
import JSZip from "jszip"

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }

export const escapeXml = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c])

export const unescapeXml = s =>
  String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

/** A→1, B→2, AA→27 */
export const colToIndex = letters =>
  [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)

export const indexToCol = n => {
  let s = ""
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = (n - m - 1) / 26
  }
  return s
}

/** "B12" → { col:"B", row:12 } */
export const splitRef = ref => {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref).toUpperCase())
  return m ? { col: m[1], row: Number(m[2]) } : null
}

const ROW_RE = /<row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
const CELL_RE = /<c(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
const VALIDATION_RE = /<dataValidation(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g

const attr = (s, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s || "")
  return m ? m[1] : undefined
}

/** 取出 <t> 文本（支持富文本多段 <r><t>） */
const collectText = inner => {
  let out = ""
  const re = /<t(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/t>)/g
  let m
  while ((m = re.exec(inner))) out += unescapeXml(m[2] ?? "")
  return out
}

export function cellValue(inner, attrs, shared) {
  if (inner == null) return ""
  const t = attr(attrs, "t")
  if (t === "inlineStr") {
    const is = /<is(?=[\s/>])[^>]*>([\s\S]*?)<\/is>/.exec(inner)
    return is ? collectText(is[1]) : ""
  }
  const v = /<v(?=[\s/>])[^>]*>([\s\S]*?)<\/v>/.exec(inner)
  if (!v) return ""
  const raw = unescapeXml(v[1])
  if (t === "s") return shared[Number(raw)] ?? ""
  return raw
}

/** 扫描工作表 XML：行、单元格、下拉验证 */
export function parseSheet(xml, shared = []) {
  const rows = new Map()
  const validations = new Map()

  ROW_RE.lastIndex = 0
  let rm
  while ((rm = ROW_RE.exec(xml))) {
    const r = Number(attr(rm[1], "r"))
    if (!Number.isFinite(r)) continue
    const cells = new Map()
    const inner = rm[2] ?? ""
    CELL_RE.lastIndex = 0
    let cm
    while ((cm = CELL_RE.exec(inner))) {
      const ref = attr(cm[1], "r")
      const pos = splitRef(ref)
      if (!pos) continue
      cells.set(pos.col, {
        ref,
        row: pos.row,
        col: pos.col,
        style: attr(cm[1], "s"),
        type: attr(cm[1], "t"),
        formula: /<f(?=[\s/>])/.test(cm[2] ?? "") ? true : false,
        value: cellValue(cm[2], cm[1], shared),
      })
    }
    rows.set(r, { r, cells })
  }

  VALIDATION_RE.lastIndex = 0
  let vm
  while ((vm = VALIDATION_RE.exec(xml))) {
    const sqref = attr(vm[1], "sqref") || ""
    const f1 = /<formula1(?=[\s/>])[^>]*>([\s\S]*?)<\/formula1>/.exec(vm[2] ?? "")
    if (!f1) continue
    let list = unescapeXml(f1[1]).trim()
    if (list.startsWith('"') && list.endsWith('"')) list = list.slice(1, -1)
    const options = list.split(",").map(i => i.trim()).filter(Boolean)
    for (const range of sqref.split(/\s+/)) {
      const col = /^([A-Z]+)/.exec(range)?.[1]
      if (col && options.length) validations.set(col, options)
    }
  }

  const dimension = /<dimension(?=[\s/>])[^>]*ref="([^"]*)"/.exec(xml)?.[1] ?? null
  return { rows, validations, dimension }
}

const rowText = (rowData, col) => rowData?.cells.get(col)?.value?.trim() ?? ""

export { rowText }

function findRowBlock(xml, rowNum) {
  ROW_RE.lastIndex = 0
  let m
  while ((m = ROW_RE.exec(xml))) {
    if (Number(attr(m[1], "r")) !== rowNum) continue
    const start = m.index
    const end = m.index + m[0].length
    if (m[2] === undefined) return { start, end, innerStart: end, innerEnd: end, inner: "", attrs: m[1], selfClosing: true }
    const innerStart = start + m[0].indexOf(">") + 1
    return { start, end, innerStart, innerEnd: end - "</row>".length, inner: m[2], attrs: m[1], selfClosing: false }
  }
  return null
}

function findCell(inner, ref) {
  CELL_RE.lastIndex = 0
  let m
  while ((m = CELL_RE.exec(inner))) {
    if (attr(m[1], "r") !== ref) continue
    return {
      start: m.index,
      end: m.index + m[0].length,
      attrs: m[1],
      inner: m[2],
      style: attr(m[1], "s"),
      selfClosing: m[2] === undefined,
    }
  }
  return null
}

function buildCellXml(ref, text, style) {
  const s = style != null && style !== "" ? ` s="${style}"` : ""
  const value = String(text)
  const space = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : ""
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${escapeXml(value)}</t></is></c>`
}

/** 新行：沿用相邻行的属性（行高、样式），只改 r */
function buildRowXml(xml, rowNum, cellXml) {
  const block = findRowBlock(xml, rowNum)
  let attrs = block ? block.attrs : null
  if (!attrs) {
    for (const delta of [-1, 1, -2, 2, -3, 3]) {
      const near = findRowBlock(xml, rowNum + delta)
      if (near) {
        attrs = near.attrs
        break
      }
    }
  }
  const clean = (attrs || "").replace(/\br="\d+"/, "").trim()
  return `<row r="${rowNum}"${clean ? " " + clean : ""}>${cellXml}</row>`
}

/**
 * 写入单元格文本；返回新的工作表 XML
 * @param style 单元格不存在时使用的样式索引（同列已有单元格的 s）
 */
export function setCellText(xml, ref, text, style) {
  const pos = splitRef(ref)
  if (!pos) throw new Error(`非法单元格引用: ${ref}`)

  const block = findRowBlock(xml, pos.row)
  if (!block || block.selfClosing) {
    const rowXml = buildRowXml(xml, pos.row, buildCellXml(ref, text, style))
    return insertRow(xml, pos.row, rowXml)
  }

  const cell = findCell(block.inner, ref)
  if (cell) {
    const cellXml = buildCellXml(ref, text, cell.style ?? style)
    return xml.slice(0, block.innerStart + cell.start) + cellXml + xml.slice(block.innerStart + cell.end)
  }

  const cellXml = buildCellXml(ref, text, style)
  const colIndex = colToIndex(pos.col)
  let insertAt = block.inner.length
  CELL_RE.lastIndex = 0
  let m
  while ((m = CELL_RE.exec(block.inner))) {
    const other = splitRef(attr(m[1], "r"))
    if (other && colToIndex(other.col) > colIndex) {
      insertAt = m.index
      break
    }
  }
  const inner = block.inner.slice(0, insertAt) + cellXml + block.inner.slice(insertAt)
  return xml.slice(0, block.innerStart) + inner + xml.slice(block.innerEnd)
}

/**
 * 改写某一列的「下拉列表」验证里的内联选项
 *
 * 表里的「选择主播」下拉是一串写死在 <formula1>"a,b,c,"</formula1> 里的名字，
 * 主播区增删人之后它不会自己变，于是出现"主播列表与下拉菜单不一致"。
 * 这里只动指定列、且必须是内联列表的那一条验证；引用别的单元格区域的列表（$J$2:$J$9）不动，
 * 其余 XML 原样返回。
 *
 * @param {string} xml 工作表 XML
 * @param {string} column 列字母（如 "D"）
 * @param {string[]} values 新的选项（写进表里时会自动加上结尾逗号，与 Excel 的习惯一致）
 * @returns {{xml: string, updated: number}} updated = 实际改了几条验证
 */
export function setValidationList(xml, column, values) {
  const list = [...new Set(values.map(v => String(v ?? "").replace(/["\r\n]/g, "")).filter(Boolean))]
  if (!list.length) return { xml, updated: 0 }
  const text = `"${list.join(",")},"`
  let updated = 0

  const out = xml.replace(VALIDATION_RE, (whole, attrs, inner) => {
    if (inner === undefined) return whole
    if (!/type="list"/.test(attrs)) return whole
    /** sqref 可能是 "D10:D1048576" 或 "D10 D12:D20"，取每段的起始列 */
    const cols = (attr(attrs, "sqref") ?? "")
      .split(/\s+/)
      .map(r => splitRef(r.split(":")[0])?.col)
      .filter(Boolean)
    if (!cols.includes(String(column).toUpperCase())) return whole

    const next = inner.replace(/<formula1>([\s\S]*?)<\/formula1>/, (m, body) => {
      if (!unescapeXml(body).trim().startsWith('"')) return m
      updated++
      return `<formula1>${escapeXml(text)}</formula1>`
    })
    return next === inner ? whole : `<dataValidation${attrs}>${next}</dataValidation>`
  })
  return { xml: out, updated }
}

/** 删除指定单元格（清空行数据用；行属性与 A 列序号公式不在 refs 里，不受影响） */
export function removeCells(xml, refs) {
  let out = xml
  const byRow = new Map()
  for (const ref of refs) {
    const pos = splitRef(ref)
    if (!pos) continue
    if (!byRow.has(pos.row)) byRow.set(pos.row, [])
    byRow.get(pos.row).push(ref)
  }
  for (const [rowNum, list] of byRow) {
    const block = findRowBlock(out, rowNum)
    if (!block || block.selfClosing) continue
    const found = list
      .map(ref => findCell(block.inner, ref))
      .filter(Boolean)
      .sort((a, b) => b.start - a.start)
    let inner = block.inner
    for (const cell of found) inner = inner.slice(0, cell.start) + inner.slice(cell.end)
    if (inner !== block.inner)
      out = out.slice(0, block.innerStart) + inner + out.slice(block.innerEnd)
  }
  return out
}

function insertRow(xml, rowNum, rowXml) {
  const dataTag = /<sheetData(?=[\s/>])([^>]*?)(\/>|>)/.exec(xml)
  if (!dataTag) throw new Error("工作表缺少 sheetData")

  if (dataTag[2] === "/>") {
    const head = xml.slice(0, dataTag.index)
    const tail = xml.slice(dataTag.index + dataTag[0].length)
    return `${head}<sheetData>${rowXml}</sheetData>${tail}`
  }

  const bodyStart = dataTag.index + dataTag[0].length
  const bodyEnd = xml.indexOf("</sheetData>", bodyStart)
  if (bodyEnd < 0) throw new Error("工作表 sheetData 未闭合")
  const body = xml.slice(bodyStart, bodyEnd)

  ROW_RE.lastIndex = 0
  let m
  let insertAt = body.length
  while ((m = ROW_RE.exec(body))) {
    const r = Number(attr(m[1], "r"))
    if (Number.isFinite(r) && r > rowNum) {
      insertAt = m.index
      break
    }
  }
  const next = body.slice(0, insertAt) + rowXml + body.slice(insertAt)
  return xml.slice(0, bodyStart) + next + xml.slice(bodyEnd)
}

/* ------------------------------ 容器 ------------------------------ */

const entryPath = (target, base = "xl/") => {
  if (!target) return null
  let t = String(target).replace(/^\//, "")
  if (!t.startsWith("xl/")) t = base + t
  return t
}

export async function openWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  if (!zip.file("xl/workbook.xml")) throw new Error("不是有效的 xlsx：缺少 xl/workbook.xml")

  const wbXml = await zip.file("xl/workbook.xml").async("string")
  const relsFile = zip.file("xl/_rels/workbook.xml.rels")
  const relsXml = relsFile ? await relsFile.async("string") : ""
  const rels = new Map()
  for (const m of relsXml.matchAll(/<Relationship(?=[\s/>])([^>]*?)\/?>/g)) {
    const id = attr(m[1], "Id")
    const target = attr(m[1], "Target")
    if (id && target) rels.set(id, entryPath(target))
  }

  const sheets = []
  for (const m of wbXml.matchAll(/<sheet(?=[\s/>])([^>]*?)\/?>/g)) {
    const name = unescapeXml(attr(m[1], "name") ?? "")
    const rid = attr(m[1], "r:id") ?? attr(m[1], "id")
    const path = rels.get(rid)
    if (name && path) sheets.push({ name, path })
  }
  if (!sheets.length) {
    sheets.push(
      ...Object.keys(zip.files)
        .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .sort()
        .map((path, i) => ({ name: `Sheet${i + 1}`, path })),
    )
  }

  let shared = []
  const ssFile = zip.file("xl/sharedStrings.xml")
  if (ssFile) {
    const ssXml = await ssFile.async("string")
    for (const m of ssXml.matchAll(/<si(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/si>)/g))
      shared.push(m[2] === undefined ? "" : collectText(m[2]))
  }

  const cache = new Map()
  const dirty = new Set()

  const api = {
    sheets,
    shared,
    hasSheet: name => sheets.some(s => s.name === name),
    async sheetXml(name) {
      const sheet = sheets.find(s => s.name === name)
      if (!sheet) throw new Error(`工作表不存在：${name}`)
      if (cache.has(name)) return cache.get(name)
      const text = await zip.file(sheet.path).async("string")
      cache.set(name, text)
      return text
    },
    setSheetXml(name, xml) {
      const sheet = sheets.find(s => s.name === name)
      if (!sheet) throw new Error(`工作表不存在：${name}`)
      cache.set(name, xml)
      dirty.add(name)
    },
    async toBuffer() {
      for (const name of dirty) {
        const sheet = sheets.find(s => s.name === name)
        zip.file(sheet.path, cache.get(name))
      }
      return zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
        platform: "DOS",
      })
    },
  }
  return api
}
