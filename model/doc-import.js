/** xlsx → 状态文档（导入） */
import { openWorkbook, parseSheet } from "./xlsx.js"
import { STATE_FORMAT, ROW_FIELDS } from "./queue-doc.js"

const COLUMN_KEYS = [
  ["seq", ["序号"]],
  ["nickname", ["群昵称", "昵称"]],
  ["gameName", ["原神游戏名", "游戏名"]],
  ["anchor", ["选择主播"]],
  ["goal", ["难度"]],
  ["status", ["帮帮完成情况", "完成情况"]],
  ["note", ["备注"]],
]

const CANONICAL_HEADER = {
  seq: "序号",
  nickname: "群昵称（保持最新）",
  gameName: "原神游戏名",
  anchor: "选择主播",
  goal: "难度及目标",
  note: "备注",
  status: "帮帮完成情况",
}

const FIELD_COLUMN = { nickname: "B", gameName: "C", anchor: "D", goal: "E", note: "F", status: "G" }

const clean = s => String(s ?? "").trim()
const flat = s => clean(s).replace(/\s+/g, "")

function columnsOf(headerCells) {
  const col = {}
  for (const [letter, text] of headerCells) {
    const flatText = flat(text)
    if (!flatText) continue
    for (const [key, keywords] of COLUMN_KEYS) {
      if (col[key]) continue
      if (keywords.some(word => flatText.includes(word))) {
        col[key] = letter
        break
      }
    }
  }
  return col
}

const kindOf = name => (/攻炼|绝境/.test(name) ? "attack" : /螺旋/.test(name) ? "spiral" : /危战/.test(name) ? "abyss" : "theater")

function cellsOf(row) {
  const cells = new Map()
  if (!row) return cells
  for (const [letter, cell] of row.cells) {
    const text = clean(cell.value)
    if (text) cells.set(letter, text)
  }
  return cells
}

export async function importWorkbook(buffer) {
  const wb = await openWorkbook(buffer)
  const sheets = []
  for (const entry of wb.sheets) {
    const sheet = parseSheet(await wb.sheetXml(entry.name), wb.shared)
    let headerRow = null
    for (const r of [...sheet.rows.keys()].sort((a, b) => a - b)) {
      if (clean(sheet.rows.get(r)?.cells.get("A")?.value) === "序号") {
        headerRow = r
        break
      }
    }
    if (!headerRow) throw new Error(`工作表「${entry.name}」找不到表头行（A 列应为「序号」）`)
    const headerCells = cellsOf(sheet.rows.get(headerRow))
    const col = columnsOf(headerCells)
    if (!col.nickname) throw new Error(`工作表「${entry.name}」表头缺少「群昵称」列`)
    const header = { A: CANONICAL_HEADER.seq }
    for (const key of ["nickname", "gameName", "anchor", "goal", "note", "status"]) {
      const letter = FIELD_COLUMN[key]
      header[letter] = col[key] ? clean(headerCells.get(col[key])) : CANONICAL_HEADER[key]
    }
    const top = []
    for (let r = 1; r < headerRow; r++) {
      const rec = {}
      for (const [letter, text] of cellsOf(sheet.rows.get(r))) {
        if (letter !== "F") rec[letter] = text
      }
      top.push(rec)
    }
    if (top[0]) top[0].A = entry.name
    const options = {}
    for (const [key, letter] of [["anchor", col.anchor], ["goal", col.goal], ["status", col.status]]) {
      if (!letter) continue
      const list = sheet.validations.get(letter)
      if (Array.isArray(list) && list.length) options[key] = [...list]
    }
    const dataStart = headerRow + 1
    let last = headerRow
    for (const [r, row] of sheet.rows) {
      if (r < dataStart) continue
      if (ROW_FIELDS.some(key => col[key] && clean(row.cells.get(col[key])?.value))) last = Math.max(last, r)
    }
    const rows = []
    for (let r = dataStart; r <= last; r++) {
      const cells = cellsOf(sheet.rows.get(r))
      const rec = {}
      let filled = false
      for (const key of ROW_FIELDS) {
        const text = col[key] ? clean(cells.get(col[key])) : ""
        rec[key] = text
        if (text) filled = true
      }
      rows.push(filled ? rec : { blank: true })
    }
    sheets.push({ name: entry.name, kind: kindOf(entry.name), header, options, prefill: 100, top, rows })
  }
  return { format: STATE_FORMAT, revision: 0, updatedAt: new Date().toISOString(), sheets }
}
