/** 群消息发送侧：通知群号、@ 人、按群发消息 */
import { config } from "./config.js"
import { cachedRoster, listMembers } from "../model/roster.js"
import { groupNameOfAnchor } from "../model/anchor-names.js"
import { log } from "./logger.js"

export const notifyGroups = () => {
  if (config.notify?.enable === false) return []
  return [...new Set((config.notify?.groups ?? []).map(Number).filter(Boolean))]
}

export const at = (qq, name = "") => {
  const target = String(qq ?? "").trim()
  if (!target) return ""
  const seg = globalThis.segment
  if (typeof seg?.at === "function") return seg.at(target, name || undefined)
  log("error", "[abyss-queue] 运行时没有 globalThis.segment.at，@ 退化为 CQ 码")
  return `[CQ:at,qq=${target}]`
}

export const mentionParts = (nickname, dir) => {
  const name = String(nickname).trim()
  const qq = dir.get(name)
  return qq ? [at(qq, name)] : [name]
}

export const qqOfRow = (dir, { store, sheet, row, nickname } = {}) => {
  const name = String(nickname ?? "").trim()
  const ids = typeof store?.qqsOf === "function" ? store.qqsOf(sheet, row) : []
  const bound = ids.filter(qq => String(store?.get?.(sheet, qq)?.nickname ?? "").trim() === name)
  if (bound.length === 1) return String(bound[0])
  const fromDir = String(dir?.get?.(name) ?? "")
  if (fromDir) return fromDir
  if (name) log("info", `[abyss-queue] 通知里没法 @ 「${name}」（${sheet} 第 ${row} 行）：绑定与群成员名单都没对上，只写了名字`)
  return ""
}

export const qqOfAnchor = (dir, name, names = null) => {
  const target = groupNameOfAnchor(name, names)
  if (!target) return ""
  if (/^\d{5,12}$/.test(target)) return target
  return String(dir?.get?.(target) ?? "")
}

export const joinLines = lines => {
  const msg = []
  for (const line of lines) {
    if (msg.length) msg.push("\n")
    msg.push(...line)
  }
  return msg
}

export async function memberDirectory(gid) {
  const dir = new Map()
  const liveEntries = []
  const cachedEntries = []
  for (const m of cachedRoster(gid)?.members ?? []) {
    const key = String(m?.nick ?? "").trim()
    if (key) cachedEntries.push([key, String(m.qq)])
    if (key && !dir.has(key)) dir.set(key, String(m.qq))
  }
  const cached = dir.size
  let live = 0
  try {
    const group = Bot.pickGroup(Number(gid))
    const list = await listMembers(group)
    for (const m of list) {
      const qq = String(m?.user_id ?? m?.qq ?? "")
      if (!qq) continue
      for (const name of [m?.card, m?.nickname]) {
        const key = String(name ?? "").trim()
        if (key) {
          dir.set(key, qq)
          liveEntries.push([key, qq])
        }
      }
      live++
    }
  } catch (err) {
    log("error", `[abyss-queue] 取群 ${gid} 成员名单失败：${err.message}`)
  }
  if (!live && cached) log("warn", `[abyss-queue] 群 ${gid} 取不到实时成员名单，@ 这条通知改用扫描缓存（${cached} 人）`)
  dir.playerEntries = live ? liveEntries : cachedEntries
  return dir
}

export async function sendToGroups(groups, msg) {
  for (const gid of groups) {
    try {
      await Bot.pickGroup(gid).sendMsg(msg)
    } catch (err) {
      log("error", `[abyss-queue] 发往群 ${gid} 失败：${err.message}`)
    }
  }
}
