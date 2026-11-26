/** 极简 xlsx 容器读写 */
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
export const colToIndex = letters =>
  [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)
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
    const seen = rows.get(r)
    if (seen) for (const [col, cell] of cells) seen.cells.set(col, cell)
    else rows.set(r, { r, cells })
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

export function setCellText(xml, ref, text, style) {
  const pos = splitRef(ref)
  if (!pos) throw new Error(`非法单元格引用: ${ref}`)
  const block = findRowBlock(xml, pos.row)
  if (block?.selfClosing) {
    const rowXml = buildRowXml(xml, pos.row, buildCellXml(ref, text, style))
    return xml.slice(0, block.start) + rowXml + xml.slice(block.end)
  }
  if (!block) {
    const rowXml = buildRowXml(xml, pos.row, buildCellXml(ref, text, style))
    return insertRow(xml, pos.row, rowXml)
  }
  const cell = findCell(block.inner, ref)
  if (cell) {
    const cellXml = buildCellXml(ref, text, style != null && style !== "" ? style : cell.style)
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

export function setValidationList(xml, column, values, { errorStyle = "warning" } = {}) {
  const list = [...new Set(values.map(v => String(v ?? "").replace(/["\r\n]/g, "")).filter(Boolean))]
  if (!list.length) return { xml, updated: 0 }
  const text = `"${list.join(",")},"`
  let updated = 0
  const out = xml.replace(VALIDATION_RE, (whole, attrs, inner) => {
    if (inner === undefined) return whole
    if (!/type="list"/.test(attrs)) return whole
    const cols = (attr(attrs, "sqref") ?? "")
      .split(/\s+/)
      .map(r => splitRef(r.split(":")[0])?.col)
      .filter(Boolean)
    if (!cols.includes(String(column).toUpperCase())) return whole
    let nextAttrs = attrs
    const style = errorStyle || "warning"
    nextAttrs = /errorStyle="/.test(attrs)
      ? attrs.replace(/errorStyle="[^"]*"/, `errorStyle="${style}"`)
      : `${attrs} errorStyle="${style}"`
    if (!/showErrorMessage="/.test(nextAttrs)) nextAttrs += ' showErrorMessage="1"'
    const next = inner.replace(/<formula1>([\s\S]*?)<\/formula1>/, (m, body) => {
      if (!unescapeXml(body).trim().startsWith('"')) return m
      updated++
      return `<formula1>${escapeXml(text)}</formula1>`
    })
    return next === inner && nextAttrs === attrs ? whole : `<dataValidation${nextAttrs}>${next}</dataValidation>`
  })
  return { xml: out, updated }
}

const attrRe = name => new RegExp(`\\s${name}="[^"]*"`, "g")

const VALUE_PARTS = [
  /<v(?=[\s/>])(?:[^>]*?\/>|[^>]*?>[\s\S]*?<\/v>)/g,
  /<is(?=[\s/>])(?:[^>]*?\/>|[^>]*?>[\s\S]*?<\/is>)/g,
  /<f(?=[\s/>])(?:[^>]*?\/>|[^>]*?>[\s\S]*?<\/f>)/g,
]

function clearCellXml(attrs, inner) {
  const kept = String(attrs).replace(attrRe("t"), "")
  const body = inner == null ? "" : VALUE_PARTS.reduce((s, re) => s.replace(re, ""), inner)
  return body.trim() ? `<c${kept}>${body}</c>` : `<c${kept}/>`
}

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
    const found = []
    for (const ref of list) {
      const cell = findCell(block.inner, ref)
      if (cell) found.push(cell)
    }
    let inner = block.inner
    for (const cell of found.sort((a, b) => b.start - a.start))
      inner = inner.slice(0, cell.start) + clearCellXml(cell.attrs, cell.inner) + inner.slice(cell.end)
    if (inner !== block.inner)
      out = out.slice(0, block.innerStart) + inner + out.slice(block.innerEnd)
  }
  return out
}

const withRow = (ref, row) => {
  const pos = splitRef(ref)
  return pos ? `${pos.col}${row}` : ref
}

const MAX_ROW = 1048576

const shiftSqref = (body, at, count) => {
  const move = ref => {
    const pos = splitRef(ref)
    if (!pos) return ref
    return `${pos.col}${pos.row >= at ? Math.min(pos.row + count, MAX_ROW) : pos.row}`
  }
  return String(body)
    .split(/\s+/)
    .filter(Boolean)
    .map(part => {
      const [from, to] = part.split(":")
      return to ? `${move(from)}:${move(to)}` : move(from)
    })
    .join(" ")
}

const shiftFormulaRows = (body, at, count) =>
  String(body).replace(
    /"([^"]*)"|(?<![A-Za-z0-9_])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![0-9(])/g,
    (whole, quoted, lead, col, tail, row) => {
      if (quoted !== undefined) return whole
      return Number(row) >= at ? `${lead}${col}${tail}${Number(row) + count}` : whole
    },
  )
export function insertRowsAndShift(xml, rowNum, count = 1, { mergeTemplateRow = 0 } = {}) {
  const at = Math.trunc(Number(rowNum) || 0)
  const added = Math.trunc(Number(count) || 0)
  if (at < 1 || added < 1) return xml
  const shift = row => (row >= at ? row + added : row)
  let out = xml
  out = out.replace(/(<c r="[A-Z]+(\d+)"[^>]*>\s*<f[^>]*>=?)ROW\(\)-(\d+)(<\/f>)/g, (whole, head, row, k, tail) =>
    Number(row) >= at ? `${head}ROW()-${Number(k) + added}${tail}` : whole,
  )
  out = out.replace(/<row r="(\d+)"|<c r="([A-Z]+)(\d+)"/g, (whole, row, col, cellRow) => {
    if (row !== undefined) return `<row r="${shift(Number(row))}"`
    return Number(cellRow) >= at ? `<c r="${col}${Number(cellRow) + added}"` : whole
  })
  out = out.replace(/(<mergeCell ref="|<hyperlink ref=")([A-Z]+\d+)(?::([A-Z]+\d+))?/g, (whole, head, from, to) => {
    const move = ref => withRow(ref, shift(splitRef(ref)?.row ?? 0))
    return head + move(from) + (to ? ":" + move(to) : "")
  })
  out = out.replace(/(sqref=")([^"]*)(")/g, (whole, head, body, tail) => head + shiftSqref(body, at, added) + tail)
  out = out.replace(/(<cfRule(?=[\s/>])[^>]*>)([\s\S]*?)(<\/cfRule>)/g, (whole, head, body, tail) =>
    head + body.replace(/(<formula(?=[\s/>])[^>]*>)([\s\S]*?)(<\/formula>)/g, (w, h, formula, t) => h + shiftFormulaRows(formula, at, added) + t) + tail,
  )
  out = out.replace(/(<dimension ref=")([A-Z]+\d+)(?::([A-Z]+\d+))?(")/g, (whole, head, from, to, tail) => {
    const move = ref => withRow(ref, shift(splitRef(ref)?.row ?? 0))
    return head + move(from) + (to ? ":" + move(to) : "") + tail
  })
  out = out.replace(/<pane(?=[\s/>])([^>]*?)\/>/g, (whole, attrs) => {
    const split = Number(attr(attrs, "ySplit"))
    const top = splitRef(attr(attrs, "topLeftCell") ?? "")
    let next = attrs
    if (Number.isFinite(split) && split >= at) next = next.replace(/(\bySplit=")\d+(")/, `$1${split + added}$2`)
    if (top) next = next.replace(/(\btopLeftCell=")[A-Z]+\d+(")/, `$1${top.col}${shift(top.row)}$2`)
    return next === attrs ? whole : `<pane${next}/>`
  })
  if (Number(mergeTemplateRow)) {
    const template = []
    for (const m of out.matchAll(/<mergeCell ref="([^"]*)"/g))
      if (splitRef(m[1].split(":")[0])?.row === Number(mergeTemplateRow)) template.push(m[1])
    if (template.length) {
      let cells = ""
      for (let i = 0; i < added; i++)
        for (const ref of template) {
          const [from, to] = ref.split(":")
          cells += `<mergeCell ref="${withRow(from, at + i)}:${withRow(to, at + i)}"/>`
        }
      const listed = (out.match(/<mergeCell /g) ?? []).length
      out = out.replace(/<mergeCells([^>]*)>/, (whole, attrs) => {
        const cur = Number(attr(attrs, "count"))
        const total = (Number.isFinite(cur) ? cur : listed) + added * template.length
        const next = /\bcount="/.test(attrs) ? attrs.replace(/(\bcount=")\d+(")/, `$1${total}$2`) : ` count="${total}"${attrs}`
        return `<mergeCells${next}>`
      })
      out = out.replace("</mergeCells>", cells + "</mergeCells>")
    }
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

const entryPath = (target, base = "xl/") => {
  if (!target) return null
  let t = String(target).replace(/^\//, "")
  if (!t.startsWith("xl/")) t = base + t
  return t
}

const MAX_UNZIPPED_BYTES = 256 * 1024 * 1024

const MAX_ENTRIES = 2048
const mb = bytes => `${Math.round(bytes / 1024 / 1024)} MB`

export async function openWorkbook(buffer) {  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files)
  if (names.length > MAX_ENTRIES)
    throw new Error(`xlsx 里的条目太多（${names.length} 个，上限 ${MAX_ENTRIES} 个），拒绝读取`)
  if (!zip.file("xl/workbook.xml")) throw new Error("不是有效的 xlsx：缺少 xl/workbook.xml")
  let left = MAX_UNZIPPED_BYTES
  const readText = path =>
    new Promise((resolve, reject) => {
      const entry = zip.file(path)
      if (!entry) return resolve(null)
      const chunks = []
      let total = 0
      const stream = entry.nodeStream()
      stream.on("data", chunk => {
        total += chunk.length
        if (total > left) {
          stream.pause()
          reject(new Error(`xlsx 解压后超过 ${mb(MAX_UNZIPPED_BYTES)}，拒绝读取（压缩比过高的文件按攻击对待）`))
          return
        }
        chunks.push(chunk)
      })
      stream.on("error", reject)
      stream.on("end", () => {
        left -= total
        resolve(Buffer.concat(chunks).toString("utf8"))
      })
    })
  const wbXml = await readText("xl/workbook.xml")
  const relsXml = (await readText("xl/_rels/workbook.xml.rels")) ?? ""
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
  const ssXml = await readText("xl/sharedStrings.xml")
  if (ssXml !== null) {
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
      const text = await readText(sheet.path)
      if (text === null) throw new Error(`工作表内容缺失：${sheet.path}`)
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

export async function oneSheetBuffer(buffer, sheetName) {
  const wb = await openWorkbook(buffer)
  const name = String(sheetName ?? "").trim()
  if (!wb.hasSheet(name)) throw new Error(`工作表不存在：${name}`)
  const { rows } = parseSheet(await wb.sheetXml(name), wb.shared)
  const cellXml = cell => {
    const text = String(cell?.value ?? "")
    if (!text) return ""
    return `<c r="${cell.ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
  }
  const rowXml = [...rows.values()]
    .sort((a, b) => a.r - b.r)
    .map(row => {
      const cells = [...row.cells.values()]
        .sort((a, b) => colToIndex(a.col) - colToIndex(b.col))
        .map(cellXml)
        .filter(Boolean)
        .join("")
      if (!cells) return ""
      return `<row r="${row.r}">${cells}</row>`
    })
    .filter(Boolean)
    .join("")
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowXml}</sheetData></worksheet>`
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`,
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  )
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
  )
  zip.file("xl/worksheets/sheet1.xml", xml)
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" })
}
