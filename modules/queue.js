/** 排队业务逻辑（纯函数，不依赖 Yunzai / 文件系统，可独立测试） */
import { DATA_COLUMNS } from "../model/schema.js"

const clean = s => String(s ?? "").trim()

export function matchOption(input, options = []) {
  const text = clean(input)
  if (!text || !options.length) return null
  const exact = options.find(o => o === text)
  if (exact) return exact
  const idx = Number(text)
  if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return options[idx - 1]
  const hits = options.filter(o => o.includes(text) || text.includes(o))
  if (hits.length === 1) return hits[0]
  return null
}

export function firstEmptyRow(model) {
  for (let r = model.dataStart; r <= model.dataEnd; r++) {
    const item = model.rows.find(i => i.row === r)
    if (!item) return r
    if (!DATA_COLUMNS.some(k => clean(item[k]))) return r
  }
  return null
}

export function matchInsertCommand(msg) {
  const m = /^#插队(?:\s+([\s\S]*))?$/.exec(String(msg ?? "").trim())
  if (!m) return null
  return { rest: String(m[1] ?? "").trim() }
}

export function findByNickname(model, nickname) {
  const text = clean(nickname)
  return model.rows.filter(i => clean(i.nickname) === text)
}

export function insertTargetRow(model, store, sheet, qq, nick, selfNick = "", { ignoreBind = false } = {}) {
  const id = clean(qq)
  const want = clean(nick)
  const miss = { ok: false, row: 0, source: "none", ambiguous: false, nickname: want }
  if (!model) return miss
  if (want) {
    const rows = findByNickname(model, want)
    if (rows.length !== 1) return { ...miss, ambiguous: rows.length > 1 }
    const at = rows[0].row
    const owners = typeof store?.qqsOf === "function" ? store.qqsOf(sheet, at) : []
    if (owners.length && id && !owners.includes(id)) return miss
    return { ok: true, row: at, source: "nickname", ambiguous: false, nickname: clean(rows[0].nickname) }
  }
  const mine = clean(selfNick)
  if (mine) {
    const byName = claimableRow(model, store, sheet, id, mine)
    if (byName) return { ok: true, row: byName.row, source: "nickname", ambiguous: false, nickname: clean(byName.nickname) }
  }
  if (ignoreBind) {
    const twins = mine ? findByNickname(model, mine) : []
    return { ...miss, ambiguous: twins.length > 1 }
  }
  const hit = locateSelf(model, store, sheet, id, mine)
  const item = hit.row ? model.rows.find(r => r.row === hit.row) : null
  if (item) return { ok: true, row: hit.row, source: hit.source, ambiguous: false, nickname: clean(item.nickname) }
  if (!mine) return miss
  const rows = findByNickname(model, mine)
  if (rows.length === 1) return { ok: true, row: rows[0].row, source: "nickname", ambiguous: false, nickname: clean(rows[0].nickname) }
  return { ...miss, ambiguous: rows.length > 1 }
}

const otherOwners = (model, store, sheet, row, qq) => {
  const current = clean(model.rows.find(r => r.row === Number(row))?.nickname)
  if (!current) return []
  if (typeof store?.qqsOf !== "function" || typeof store?.get !== "function") return []
  return store
    .qqsOf(sheet, row)
    .filter(id => String(id) !== String(qq))
    .filter(id => clean(store.get(sheet, id)?.nickname) === current)
}

const claimableRow = (model, store, sheet, qq, nick) => {
  const hit = model.rows.filter(r => clean(r.nickname) === nick)
  if (hit.length !== 1) return null
  const row = hit[0]
  return otherOwners(model, store, sheet, row.row, qq).length === 0 ? row : null
}

export function locateSelf(model, store, sheet, qq, nickname = "", { ignoreBind = false } = {}) {
  const nick = clean(nickname)
  const none = { row: 0, source: "none", nick }
  if (!model) return none
  const bind = ignoreBind ? null : store?.get?.(sheet, qq)
  if (bind) {
    const item = model.rows.find(r => r.row === Number(bind.row))
    const current = item ? clean(item.nickname) : ""
    const others = item ? otherOwners(model, store, sheet, bind.row, qq) : []
    if (!item || others.length) {
      const hit = nick ? claimableRow(model, store, sheet, qq, nick) : null
      return hit
        ? { row: hit.row, source: "nickname", nick, stale: true, bind: { row: hit.row, nickname: clean(hit.nickname) } }
        : { ...none, stale: true }
    }
    if (current === nick) return { row: item.row, source: "bind", nick, boundNick: clean(bind.nickname) }
    const bindNick = clean(bind.nickname)
    if (nick && bindNick === nick && current !== bindNick) {
      const hit = nick ? claimableRow(model, store, sheet, qq, nick) : null
      return hit
        ? { row: hit.row, source: "nickname", nick, stale: true, bind: { row: hit.row, nickname: clean(hit.nickname) } }
        : { ...none, stale: true }
    }
    if (!nick) return { row: item.row, source: "bind", nick, boundNick: clean(bind.nickname) }
    return { row: item.row, source: "bind", nick, renamedFrom: current, boundNick: clean(bind.nickname) }
  }
  if (!nick) return none
  const hit = claimableRow(model, store, sheet, qq, nick)
  return hit
    ? { row: hit.row, source: "nickname", nick, bind: { row: hit.row, nickname: clean(hit.nickname) } }
    : none
}

export function myRowOf(model, store, sheet, qq, nickname) {
  return locateSelf(model, store, sheet, qq, nickname).row
}

export function listQueue(model, { limit = 0, status = "" } = {}) {
  let list = model.rows.filter(i => clean(i.nickname))
  if (status) list = list.filter(i => i.status === status)
  return limit > 0 ? list.slice(0, limit) : list
}
