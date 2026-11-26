/** 群成员名单 → 在线编辑器 */
import { getEditorService } from "../editor/service.js"
import { readJson, writeJson } from "./queue-state.js"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"

export const ROSTER_QQ = "0"

let lastScanSource = ""

export const rosterScanSource = () => lastScanSource

const adapterAvatar = (m, qq) => {
  try {
    const url = typeof m?.getAvatarUrl === "function" ? String(m.getAvatarUrl() ?? "").trim() : ""
    if (/^https?:\/\//i.test(url)) return url
  } catch {
  }
  return ""
}

const qqAvatar = qq => `https://q.qlogo.cn/g?b=qq&s=100&nk=${encodeURIComponent(qq)}`

const toMemberArray = value => {
  if (!value) return []
  const withQq = (v, key) => {
    const qq = String(v?.qq ?? v?.user_id ?? key ?? "").trim()
    return { ...(v ?? {}), qq, avatar: adapterAvatar(v, qq) }
  }
  if (Array.isArray(value)) return value.map(v => withQq(v))
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => withQq(v, k))
  if (typeof value === "object") {
    if (typeof value[Symbol.iterator] === "function") return [...value].map(v => withQq(v))
    return Object.entries(value).map(([k, v]) => withQq(v, k))
  }
  return []
}

const kindOf = value => {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (value instanceof Map) return "Map"
  return typeof value
}

const describeTrace = trace =>
  (trace ?? []).map(t => `${t.from}→${t.error ? `抛错(${t.error})` : `${t.kind}(${t.count})`}`).join("；") || "没有任何可用来源"
export async function listMembers(group, trace = null) {
  if (!group) return []
  const note = (from, value, count, error) =>
    trace?.push({ from, kind: error ? "throw" : kindOf(value), count, ...(error ? { error } : {}) })
  const candidates = [
    ["getMemberMap", () => group.getMemberMap?.()],
    ["getMemberList", () => group.getMemberList?.()],
    ["members", () => group.members],
    ["group.getMemberMap", () => group.group?.getMemberMap?.()],
    ["group.getMemberList", () => group.group?.getMemberList?.()],
    ["group.members", () => group.group?.members],
  ]
  for (const [from, get] of candidates) {
    try {
      const value = await get()
      const list = toMemberArray(value)
      note(from, value, list.length)
      if (list.length) return list
    } catch (err) {
      note(from, null, 0, String(err?.message ?? err))
    }
  }
  return []
}

export async function collectMembers(groupId, Bot = globalThis.Bot) {
  const gid = Number(groupId)
  if (!gid) throw new Error("没配群号")
  const group = Bot?.pickGroup?.(gid)
  if (!group) throw new Error("机器人还没有连上，拿不到群成员")
  const trace = []
  let list = await listMembers(group, trace)
  if (!list.length) {
    for (const [from, get] of [
      ["Bot.getGroupMemberList", () => Bot?.getGroupMemberList?.(gid)],
      ["Bot.gl.get", () => Bot?.gl?.get?.(gid)],
    ]) {
      try {
        const value = await get()
        const sub = value && (typeof value.getMemberMap === "function" || typeof value.getMemberList === "function" || value.members)
          ? await listMembers(value, null)
          : toMemberArray(value)
        trace.push({ from, kind: kindOf(value), count: sub.length })
        if (sub.length) {
          list = sub
          break
        }
      } catch (err) {
        trace.push({ from, kind: "throw", count: 0, error: String(err?.message ?? err) })
      }
    }
  }
  const out = []
  const seen = new Set()
  for (const m of list) {
    const qq = String(m?.user_id ?? m?.qq ?? "").trim()
    if (!qq || seen.has(qq)) continue
    seen.add(qq)
    out.push({
      qq,
      nick: String(m?.card ?? "").trim() || String(m?.nickname ?? "").trim(),
      avatar: String(m?.avatar ?? "").trim() || qqAvatar(qq),
    })
  }
  if (!out.length)
    throw new Error(
      `扫不到群成员（群 ${gid}）：${describeTrace(trace)}——检查机器人是否在这个群里、以及框架有没有缓存成员`,
    )
  lastScanSource = trace.filter(t => t.count > 0).at(-1)?.from ?? ""
  return out
}

let LAST_ROSTER = { group: "", at: 0, members: [] }

let rosterLoaded = false

const normMembers = members =>
  (Array.isArray(members) ? members : [])
    .map(m => ({
      qq: String(m?.qq ?? "").trim(),
      nick: String(m?.nick ?? "").trim(),
      avatar: String(m?.avatar ?? "").trim(),
    }))
    .filter(m => m.qq)
const loadRosterFromDisk = () => {
  if (rosterLoaded) return LAST_ROSTER
  rosterLoaded = true
  const raw = readJson(config.rosterPath)
  const list = normMembers(raw?.members)
  if (!list.length) return LAST_ROSTER
  LAST_ROSTER = { group: String(raw?.group ?? "").trim(), at: Number(raw?.at) || 0, members: list }
  return LAST_ROSTER
}

export const rememberRoster = (groupId, members = []) => {
  const list = normMembers(members)
  if (!list.length) return LAST_ROSTER
  LAST_ROSTER = { group: String(groupId ?? "").trim(), at: Date.now(), members: list }
  rosterLoaded = true
  writeJson(config.rosterPath, LAST_ROSTER)
  return LAST_ROSTER
}

export const cachedRoster = groupId => {
  const gid = String(groupId ?? "").trim()
  const cache = LAST_ROSTER.members.length || rosterLoaded ? LAST_ROSTER : loadRosterFromDisk()
  if (!gid || cache.group !== gid || !cache.members.length) return null
  return cache
}

export const forgetRoster = () => {
  LAST_ROSTER = { group: "", at: 0, members: [] }
  rosterLoaded = true
}

export const reloadRosterFromDisk = () => {
  LAST_ROSTER = { group: "", at: 0, members: [] }
  rosterLoaded = false
}

export async function pushRoster() {
  const group = String(config.roster?.group ?? "").trim()
  if (!group) return { ok: false, skipped: "没配 roster.group（群号）" }
  try {
    const members = await collectMembers(group)
    if (!members.length) throw new Error("取到的成员是空的，先不推（避免被当成全员退群）")
    rememberRoster(group, members)
    const service = getEditorService()
    if (!service?.roster) throw new Error("编辑器没有在进程内挂载（主播库需要它）")
    const out = await service.roster({ qq: ROSTER_QQ, nick: "群成员名单" }, { group, members })
    log(
      "info",
      `[abyss-queue] 群成员名单已同步到编辑器：${members.length} 人（来源 ${rosterScanSource() || "未知"}）` +
        (out.renamed ? `，改名同步 ${out.renamed} 行` : "") +
        (out.removed ? `，退群删除 ${out.removed} 行` : ""),
    )
    return { ok: true, count: members.length, renamed: out.renamed ?? 0, removed: out.removed ?? 0, source: rosterScanSource() }
  } catch (err) {
    log("warn", `[abyss-queue] 推送群成员名单失败：${err?.message ?? err}`)
    return { ok: false, error: err?.message ?? String(err) }
  }
}
