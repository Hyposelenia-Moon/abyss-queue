/**
 * 工作表结构解析：定位表头、数据区、下拉选项、主播区
 *
 * 表格是人工维护的，各表表头行号不同（幽境危战是第 10 行，另两张是第 7 行），
 * 因此一切位置都靠内容识别，不写死行号。
 */
import { parseSheet } from "./xlsx.js"

/** 逻辑列 → 表头关键字（先匹配到的优先，顺序即优先级） */
const COLUMN_KEYS = [
  ["seq", ["序号"]],
  ["nickname", ["群昵称", "昵称"]],
  ["gameName", ["原神游戏名", "游戏名"]],
  ["anchor", ["选择主播"]],
  ["goal", ["难度"]],
  ["strength", ["账号强度", "强度"]],
  ["status", ["帮帮完成情况", "完成情况"]],
  ["note", ["备注"]],
]

export const DATA_COLUMNS = ["nickname", "gameName", "anchor", "goal", "strength", "note", "status"]

const clean = s => String(s ?? "").trim()

/** 从表头行识别各逻辑列所在的列字母 */
function detectColumns(sheet, headerRow) {
  const row = sheet.rows.get(headerRow)
  const col = {}
  if (!row) return col
  for (const [cellCol, cell] of row.cells) {
    const text = clean(cell.value)
    if (!text) continue
    for (const [key, keys] of COLUMN_KEYS) {
      if (col[key]) continue
      if (keys.some(k => text.includes(k))) {
        col[key] = cellCol
        break
      }
    }
  }
  return col
}

/** 找表头行：某行 A 列恰好是"序号" */
function detectHeaderRow(sheet) {
  const candidates = [...sheet.rows.keys()].sort((a, b) => a - b)
  for (const r of candidates) {
    const row = sheet.rows.get(r)
    const a = clean(row.cells.get("A")?.value)
    if (a === "序号") return r
  }
  return null
}

function detectDataEnd(sheet, headerRow, col) {
  const rows = [...sheet.rows.keys()].filter(r => r > headerRow)
  let end = headerRow
  for (const r of rows) {
    const row = sheet.rows.get(r)
    const seq = col.seq ? row.cells.get(col.seq) : null
    const hasData = DATA_COLUMNS.some(k => col[k] && clean(row.cells.get(col[k])?.value))
    if (seq?.formula || hasData) end = Math.max(end, r)
  }
  return end
}

/**
 * 主播区（表头上方）：A 列主播名、C 列强项、G/H 列直播入口
 *
 * 「专职」是新增的可填列，放在 **D 列**：A/C/G/H 都被占用，而 D 位于 C:F 合并区内，
 * 平时是空的，因此填在这里既不与强项/入口抢格，也完全不用改合并单元格。
 * 填的内容是这位主播专职打的深渊（如「幽境危战」），用于 #主播 的合并视图。
 */
function detectAnchors(sheet, headerRow) {
  const anchors = []
  for (let r = 2; r < headerRow; r++) {
    const row = sheet.rows.get(r)
    if (!row) continue
    const nameCell = row.cells.get("A")
    let name = clean(nameCell?.value)
    if (!name) continue
    if (name === "主播列表") continue
    if (name.startsWith("📢") || name.length > 40) continue // 招募公告行

    let recommend = ""
    const m = /【([^】]*)】/.exec(name)
    if (m) {
      recommend = m[1]
      name = clean(name.replace(m[0], ""))
    }
    anchors.push({
      row: r,
      name,
      recommend,
      skills: clean(row.cells.get("C")?.value),
      /** D 列：专职（手填，可为空） */
      duty: clean(row.cells.get("D")?.value),
      entry: [clean(row.cells.get("G")?.value), clean(row.cells.get("H")?.value)].filter(Boolean).join(" / "),
    })
  }
  return anchors
}

/** 样式索引采样：同列数据行已有的 s，用于给空行新建单元格时套用格式 */
function detectStyles(sheet, headerRow, col) {
  const samples = {}
  const rows = [...sheet.rows.keys()].filter(r => r > headerRow).sort((a, b) => a - b)
  for (const key of ["seq", ...DATA_COLUMNS]) {
    const c = col[key]
    if (!c) continue
    for (const r of rows) {
      const style = sheet.rows.get(r)?.cells.get(c)?.style
      if (style != null) {
        samples[key] = style
        break
      }
    }
  }
  return samples
}

function detectOptions(sheet, col) {
  const map = { anchor: col.anchor, goal: col.goal, strength: col.strength, status: col.status }
  const options = {}
  for (const [key, letter] of Object.entries(map))
    if (letter && sheet.validations.has(letter)) options[key] = sheet.validations.get(letter)
  return options
}

/**
 * 构建工作表模型
 * @returns {object} 见 README「模型字段」一节
 */
export function buildModel({ name, xml, shared }) {
  const sheet = parseSheet(xml, shared)
  const headerRow = detectHeaderRow(sheet)
  if (!headerRow) throw new Error(`工作表「${name}」找不到表头行（A 列应为「序号」）`)

  const col = detectColumns(sheet, headerRow)
  if (!col.nickname) throw new Error(`工作表「${name}」表头缺少「群昵称」列`)

  const dataStart = headerRow + 1
  const dataEnd = detectDataEnd(sheet, headerRow, col)

  const rows = []
  for (let r = dataStart; r <= dataEnd; r++) {
    const sheetRow = sheet.rows.get(r)
    if (!sheetRow) continue
    const item = { row: r }
    for (const key of ["seq", ...DATA_COLUMNS])
      item[key] = col[key] ? clean(sheetRow.cells.get(col[key])?.value) : ""
    if (DATA_COLUMNS.some(k => item[k])) rows.push(item)
  }

  return {
    name,
    title: clean(sheet.rows.get(1)?.cells.get("A")?.value),
    headerRow,
    dataStart,
    dataEnd,
    col,
    options: detectOptions(sheet, col),
    styles: detectStyles(sheet, headerRow, col),
    anchors: detectAnchors(sheet, headerRow),
    rows,
  }
}
