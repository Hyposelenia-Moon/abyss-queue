/** 完成情况文字：解析、生成、改名 */
import { attackCompletedStatus, attackPendingStatus, attackStatusParts } from "../components/attack.js"
import { phaseOf as cyclePhaseOf } from "../components/cycle.js"
import { QUEUED_STATUS, SELF_DONE, WAITING_STATUS } from "./defs.js"

export const defaultStatusOf = (sheetName, now = new Date()) => {
  const name = String(sheetName ?? "")
  if (/攻炼|绝境/.test(name)) return WAITING_STATUS
  return cyclePhaseOf(name, now) === "queued" ? QUEUED_STATUS : WAITING_STATUS
}

export const statusWithSelfDone = (status, nickname) => {
  const raw = String(status ?? "").trim()
  const parts = raw
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
  if (!parts.includes(SELF_DONE)) return raw
  const nick = String(nickname ?? "").trim()
  if (!nick) return raw
  return [...new Set(parts.map(p => (p === SELF_DONE ? nick : p)))].join(",")
}

export const statusTokens = status =>
  String(status ?? "")
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
export const statusLabels = status => {
  const parts = attackStatusParts(status)
  return parts ? parts.flatMap(part => statusTokens(part.label)) : statusTokens(status)
}

export const statusRenamePlan = (model, { row, from, to, qq = "", binds = null, statusOf = null } = {}) => {
  const statusWords = [WAITING_STATUS, QUEUED_STATUS, SELF_DONE]
  const oldNick = String(from ?? "").trim()
  const newNick = String(to ?? "").trim()
  const at = Number(row) || 0
  const none = { changes: [], skipped: "" }
  if (!model || !at || !oldNick || !newNick || oldNick === newNick) return none
  if (statusWords.includes(oldNick)) return { changes: [], skipped: `「${oldNick}」是状态词、不是人，完成情况没动` }
  if ((model.anchors ?? []).some(a => String(a?.name ?? "").trim() === oldNick))
    return { changes: [], skipped: `「${oldNick}」是这一榜的主播名，完成情况没动` }
  const statusAt = r => String((statusOf ? statusOf(r) : r.status) ?? "")
  const same = (model.rows ?? []).filter(r => String(r.nickname ?? "").trim() === oldNick)
  if (same.length !== 1 || Number(same[0].row) !== at)
    return { changes: [], skipped: `这一榜里有 ${same.length} 行叫「${oldNick}」，分不清完成情况里写的是哪一位，没动` }
  const ids = typeof binds?.qqsOf === "function" ? binds.qqsOf(model.name, at) : []
  const valid = ids.filter(id => String(binds?.get?.(model.name, id)?.nickname ?? "").trim() === oldNick)
  const owner = String(qq ?? "").trim() || (valid.length === 1 ? String(valid[0]) : "")
  const rows = owner ? model.rows ?? [] : same
  const renameStatus = status => {
    const attack = attackStatusParts(status)
    if (attack) {
      let hit = false
      const next = attack.map(p => {
        if (p.kind !== "done" || p.label !== oldNick) return p
        hit = true
        return { ...p, label: newNick }
      })
      return hit ? next.map(p => `${p.versions.join("/")}${p.label}`).join(" ") : ""
    }
    const parts = statusTokens(status)
    if (!parts.includes(oldNick)) return ""
    return parts.map(p => (p === oldNick ? newNick : p)).join(",")
  }
  const statusHasNick = status => {
    const attack = attackStatusParts(status)
    if (attack) return attack.some(p => p.kind === "done" && p.label === oldNick)
    return statusTokens(status).includes(oldNick)
  }
  const changes = []
  for (const r of rows) {
    const next = renameStatus(statusAt(r))
    if (!next) continue
    changes.push({ row: r.row, status: next })
  }
  const others = owner
    ? []
    : (model.rows ?? []).filter(r => Number(r.row) !== at && statusHasNick(statusAt(r)))
  return {
    changes,
    skipped: others.length
      ? `第 ${at} 行没有可依据的 QQ 绑定，只能确认它本人那一格；另外 ${others.length} 行里同样写着「${oldNick}」的没动`
      : "",
  }
}

export const attackDisplayStatus = (sheet, goal, status) => {
  if (!/攻炼|绝境/.test(String(sheet ?? ""))) return status
  const raw = String(status ?? "").trim()
  const parts = attackStatusParts(raw)
  if (parts?.some(part => part.kind === "done")) return attackCompletedStatus(goal, raw)
  if (parts || raw === WAITING_STATUS || raw === QUEUED_STATUS) return attackPendingStatus(goal)
  return raw
}

export const cycleDisplayStatus = (sheet, status) => {
  const raw = String(status ?? "").trim()
  if (raw !== WAITING_STATUS && raw !== QUEUED_STATUS) return status
  if (!/深境|螺旋/.test(String(sheet ?? ""))) return status
  return defaultStatusOf(sheet)
}

export const isDoneStatus = status => {
  const parts = attackStatusParts(status)
  if (parts) return parts.every(part => part.kind === "done")
  const v = String(status ?? "").trim()
  return Boolean(v) && v !== QUEUED_STATUS && v !== WAITING_STATUS
}
