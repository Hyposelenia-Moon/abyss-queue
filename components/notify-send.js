/**
 * 群消息发送侧：通知群号、@ 人、按群发消息
 *
 * 抽出来的原因：`tick()` 的四件事都要"把一批名字变成一条能 @ 到人的消息并发到几个群"，
 * 这段与具体是"开榜提醒"还是"月末催办"无关，混在 apps/queue.js 里会让入口文件持续膨胀。
 */
import { config } from "./config.js"
import { listMembers } from "../model/roster.js"
import { log } from "./logger.js"

/**
 * 通知发给哪些群：`notify.groups`，`notify.enable === false` 时一律为空（= 通知全关）
 *
 * 群名单同步**不看这里**：它由 `roster.group` 决定（见 model/roster.js 的 pushRoster），
 * 所以关掉通知不会连带停掉名单同步。
 */
export const notifyGroups = () => {
  if (config.notify?.enable === false) return []
  return [...new Set((config.notify?.groups ?? []).map(Number).filter(Boolean))]
}

/** @ 一个人；拿不到 segment（测试环境）时退化成纯文本 */
export const at = qq => (typeof segment !== "undefined" && segment?.at ? segment.at(Number(qq)) : `@${qq} `)

/**
 * 把一个名字变成消息片段数组：能对上 QQ 就 @ 他（后面再括上昵称，避免客户端不显示 @ 对象）
 *
 * 消息必须按片段数组发，不能把 @ 对象拼进字符串——那样只会发出 "[object Object]"。
 */
export const mentionParts = (nickname, dir) => {
  const name = String(nickname).trim()
  const qq = dir.get(name)
  return qq ? [at(qq), `（${name}）`] : [name]
}

/** 多行片段拼成一条消息（行间换行） */
export const joinLines = lines => {
  const msg = []
  for (const line of lines) {
    if (msg.length) msg.push("\n")
    msg.push(...line)
  }
  return msg
}

/**
 * 群成员名单：群名片 / 昵称 → QQ
 *
 * 表里只有群昵称，要 @ 人就得把它映射回 QQ，只能靠群成员名单。
 * 对不上的名字（改了名片、不在群里）就只发文字，不 @。
 * 取成员走 `listMembers()`：真实框架给的是"以 QQ 为键的普通对象"，直接 `[...map.values()]` 会炸。
 */
export async function memberDirectory(gid) {
  const dir = new Map()
  try {
    const group = Bot.pickGroup(Number(gid))
    const list = await listMembers(group)
    for (const m of list) {
      const qq = String(m?.user_id ?? m?.qq ?? "")
      if (!qq) continue
      for (const name of [m?.card, m?.nickname]) {
        const key = String(name ?? "").trim()
        if (key && !dir.has(key)) dir.set(key, qq)
      }
    }
  } catch (err) {
    log("error", `[abyss-queue] 取群 ${gid} 成员名单失败：${err.message}`)
  }
  return dir
}

/** 逐群发同一条消息；单个群失败不影响其余群 */
export async function sendToGroups(groups, msg) {
  for (const gid of groups) {
    try {
      await Bot.pickGroup(gid).sendMsg(msg)
    } catch (err) {
      log("error", `[abyss-queue] 发往群 ${gid} 失败：${err.message}`)
    }
  }
}
