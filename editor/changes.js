/** 改动记录（留痕）：谁、什么时候、改了哪个榜哪一行的哪个字段、从什么改成什么 */
import { readJson, writeJson } from "./util.js"

export const CHANGES_KEEP = 2000

export function createChanges({ file, keep = CHANGES_KEEP } = {}) {
  const limit = Number(keep) > 0 ? Math.floor(Number(keep)) : CHANGES_KEEP
  const load = () => {
    const raw = file ? readJson(file) : null
    return { updatedAt: Number(raw?.updatedAt) || 0, rows: Array.isArray(raw?.rows) ? raw.rows : [] }
  }
  const append = (records = []) => {
    const list = (Array.isArray(records) ? records : []).filter(r => r && Number(r.at))
    if (!list.length || !file) return 0
    try {
      const prepared = list.map(r => {
        const out = { ...r }
        if (out.kind === "edit" && out.row && out.current === undefined) out.current = Number(out.row)
        if (out.kind === "reject" && Array.isArray(out.rows) && out.currentRows === undefined) out.currentRows = [...out.rows]
        if (out.kind === "remove" && out.current === undefined) out.current = null
        return out
      })
      const rows = [...load().rows, ...prepared].slice(-limit)
      writeJson(file, { updatedAt: Date.now(), keep: limit, rows })
      return prepared.length
    } catch (err) {
      console.error(`[editor] 记改动记录失败（不影响写表）：${err?.message ?? err}`)
      return 0
    }
  }
  const remap = (sheet, rowMap) => {
    if (!file || !rowMap || typeof rowMap !== "object") return 0
    const name = String(sheet ?? "").trim()
    const map = new Map(
      Object.entries(rowMap)
        .map(([from, to]) => [Number(from), Number(to)])
        .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to)),
    )
    if (!name || !map.size) return 0
    const all = load().rows
    let changed = 0
    const mapRow = row => {
      const next = map.get(Number(row))
      return next === undefined ? null : next
    }
    for (const entry of all) {
      if (String(entry?.sheet ?? "") !== name) continue
      if (entry.current !== undefined && Number(entry.current)) {
        const next = mapRow(entry.current)
        if (next !== null && next !== Number(entry.current)) {
          entry.current = next
          changed++
        }
      }
      if (Array.isArray(entry.currentRows)) {
        entry.currentRows = entry.currentRows.map(row => mapRow(row) ?? Number(row))
        changed++
      }
    }
    if (!changed) return 0
    try {
      writeJson(file, { updatedAt: Date.now(), keep: limit, rows: all })
      return changed
    } catch (err) {
      console.error(`[editor] 搬动改动记录位置失败（不影响写表）：${err?.message ?? err}`)
      return 0
    }
  }
  const hitsMine = (entry, mine) => {
    if (!mine || !mine.size) return false
    const rows = mine.get(String(entry?.sheet ?? ""))
    if (!rows || !rows.size) return false
    const row = entry?.current === undefined ? entry?.row : entry.current
    if (Number(row) && rows.has(Number(row))) return true
    const list = entry?.currentRows === undefined ? entry?.rows : entry.currentRows
    for (const r of Array.isArray(list) ? list : []) if (rows.has(Number(r))) return true
    return false
  }
  const list = ({ limit: take = 200, all = false, qq = "", mine = null } = {}) => {
    const rows = load().rows
    const picked = all ? rows : rows.filter(e => (qq && String(e?.qq ?? "") === String(qq)) || hitsMine(e, mine))
    const n = Number(take) > 0 ? Math.floor(Number(take)) : 200
    return picked.slice(-n).reverse()
  }
  return { file, keep: limit, load, append, remap, list, hitsMine }
}
