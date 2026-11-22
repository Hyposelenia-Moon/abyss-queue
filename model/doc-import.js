/**
 * xlsx → 状态文档（导入）
 *
 * 只认"表头文字"：列位不再写死。7 列导出表、8 列旧表都能读——
 * 旧表多出来的 `账号强度`（F 列）以及它后面的列都会被忽略（m00477：彻底移除）。
 *
 * 顶部区原样保留在 `top` 里（含空行、招募公告、无姓名的孤链接行），
 * 因为主播区、公告、合并文本都是人工排的，靠 anchors 重建会丢格式与顺序。
 */
import { openWorkbook, parseSheet } from "./xlsx.js"
import { STATE_FORMAT, ROW_FIELDS } from "./queue-doc.js"

/** 逻辑列 → 表头关键字（与旧 schema 一致；先匹配到的优先） */
const COLUMN_KEYS = [
  ["seq", ["序号"]],
  ["nickname", ["群昵称", "昵称"]],
  ["gameName", ["原神游戏名", "游戏名"]],
  ["anchor", ["选择主播"]],
  ["goal", ["难度"]],
  ["status", ["帮帮完成情况", "完成情况"]],
  ["note", ["备注"]],
]

/** 导出时的七列表头（源表缺列时兜底） */
const CANONICAL_HEADER = {
  seq: "序号",
  nickname: "群昵称（保持最新）",
  gameName: "原神游戏名",
  anchor: "选择主播",
  goal: "难度及目标",
  note: "备注",
  status: "帮帮完成情况",
}

/** 数据行字段 → 导出列字母 */
const FIELD_COLUMN = { nickname: "B", gameName: "C", anchor: "D", goal: "E", note: "F", status: "G" }

const clean = s => String(s ?? "").trim()
const flat = s => clean(s).replace(/\s+/g, "")

/** 表头行 → `{逻辑列: 列字母}` */
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

/** 把一行解析成 `Map<列字母, 文本>`（只留非空） */
function cellsOf(row) {
  const cells = new Map()
  if (!row) return cells
  for (const [letter, cell] of row.cells) {
    const text = clean(cell.value)
    if (text) cells.set(letter, text)
  }
  return cells
}

/**
 * 导入整本 xlsx
 *
 * @param {Buffer} buffer
 * @returns {Promise<object>} 状态文档（未写盘；`revision` 由 `writeDoc` 递增）
 */
export async function importWorkbook(buffer) {
  const wb = await openWorkbook(buffer)
  const sheets = []

  for (const entry of wb.sheets) {
    const sheet = parseSheet(await wb.sheetXml(entry.name), wb.shared)

    // 表头行：A 列必须是「序号」
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

    // 七列表头：优先用源表文字，缺了再兜底
    const header = { A: CANONICAL_HEADER.seq }
    for (const key of ["nickname", "gameName", "anchor", "goal", "note", "status"]) {
      const letter = FIELD_COLUMN[key]
      header[letter] = col[key] ? clean(headerCells.get(col[key])) : CANONICAL_HEADER[key]
    }

    // 顶部区：第 1 行到表头前一行，原样留（丢 F 列）
    const top = []
    for (let r = 1; r < headerRow; r++) {
      const rec = {}
      for (const [letter, text] of cellsOf(sheet.rows.get(r))) {
        if (letter !== "F") rec[letter] = text
      }
      top.push(rec)
    }
    /**
     * 标题不再沿用旧表里的文字（腾讯文档时期的「2026年10月…排队」带日期与“排队”），
     * 固定用榜名本身；写进第 1 行 A 格，导出时原样写回，导入再跑一遍结果不变。
     */
    if (top[0]) top[0].A = entry.name

    // 下拉选项：只认映射到的三列
    const options = {}
    for (const [key, letter] of [["anchor", col.anchor], ["goal", col.goal], ["status", col.status]]) {
      if (!letter) continue
      const list = sheet.validations.get(letter)
      if (Array.isArray(list) && list.length) options[key] = [...list]
    }

    // 数据区：最后一个有内容的行（A 列公式不算内容）
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
