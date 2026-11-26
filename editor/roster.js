/** 群成员名单（机器人推来的）：群昵称候选 + 按 QQ 取当前名片 + **本群守卫**（谁能改表） */
import { readJson, writeJson } from "./util.js"

export const ROSTER_TRUST_MS = 48 * 60 * 60 * 1000

export function createRoster({ rosterFile, store, trustMs = ROSTER_TRUST_MS }) {
  const loadRoster = () => {
    const r = readJson(rosterFile) ?? { group: "", updatedAt: 0, members: [] }
    for (const m of r.members ?? []) if (m && typeof m.nick === "string") m.nick = m.nick.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    return r
  }
  const trusted = (now = Date.now()) => {
    const r = loadRoster()
    if (!r.updatedAt || !(r.members ?? []).length) return false
    return now - Number(r.updatedAt) <= Math.max(0, Number(trustMs) || 0)
  }
  const isMember = (qq, now = Date.now()) => {
    const id = String(qq ?? "").trim()
    if (!id || !trusted(now)) return null
    return (loadRoster().members ?? []).some(m => String(m?.qq ?? "").trim() === id)
  }
  const avatarOf = qq => {
    const id = String(qq ?? "").trim()
    if (!id) return ""
    const url = String((loadRoster().members ?? []).find(m => String(m?.qq ?? "").trim() === id)?.avatar ?? "").trim()
    return /^https?:\/\//i.test(url) ? url : ""
  }
  const ageMs = (now = Date.now()) => {
    const r = loadRoster()
    return r.updatedAt ? now - Number(r.updatedAt) : Infinity
  }
  const nickCandidates = () => {
    const set = new Set()
    for (const m of loadRoster().members ?? []) {
      const n = String(m?.nick ?? "").trim()
      if (n) set.add(n)
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"))
  }
  const nickOf = async qq => {
    const id = String(qq ?? "").trim()
    if (!id) return ""
    const fromRoster = String((loadRoster().members ?? []).find(m => String(m?.qq ?? "").trim() === id)?.nick ?? "").trim()
    if (fromRoster) return fromRoster
    const bindStore = await store()
    for (const sheet of bindStore.sheetsOf(id)) {
      const nick = String(bindStore.get(sheet, id)?.nickname ?? "").trim()
      if (nick) return nick
    }
    return ""
  }
  const saveRoster = ({ group = "", members = [] } = {}) => {
    writeJson(rosterFile, {
      group: String(group ?? "").trim(),
      updatedAt: Date.now(),
      members: members
        .map(m => {
          const qq = String(m?.qq ?? "").trim()
          const nick = String(m?.nick ?? "").trim()
          const avatar = String(m?.avatar ?? "").trim()
          return avatar ? { qq, nick, avatar } : { qq, nick }
        })
        .filter(m => m.qq),
    })
  }
  return { loadRoster, saveRoster, nickCandidates, nickOf, avatarOf, trusted, isMember, ageMs }
}
