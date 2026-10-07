/**
 * 群消息发送侧：通知群号、@ 人、按群发消息
 *
 * 抽出来的原因：`tick()` 的四件事都要"把一批名字变成一条能 @ 到人的消息并发到几个群"，
 * 这段与具体是"开榜提醒"还是"月末催办"无关，混在 apps/queue.js 里会让入口文件持续膨胀。
 */
import { config } from "./config.js"
import { cachedRoster, listMembers } from "../model/roster.js"
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

/**
 * 「下一位」是谁：优先这一行的绑定（`QQ → 行` 反查），其次群名单按昵称查
 *
 * 为什么先看绑定：群昵称是**展示名**——可以重名、也随时会改，而绑定才是身份
 * （与 `modules/queue.js` 的 `locateSelf` 同一套口径）。绑定里记的昵称与表里这一行现在的昵称
 * 一致才算**有效归属**：对不上的（外部改过表、那一行已经换了人）不能按行号认人，退回按昵称查名单。
 * 两边都拿不到就返回空串——调用方只显示名字、**不发 @**（不瞎 @，更不 @ 全体）。
 *
 * @param {Map<string,string>} dir 群名单：群昵称 → QQ（`memberDirectory`）
 * @param {object} opts
 * @param {object} [opts.store] 绑定库（`model/store.js` 的 BindStore）；不给就只按名单查
 * @param {string} opts.sheet 榜名
 * @param {number} opts.row 这一行
 * @param {string} opts.nickname 表里这一行的群昵称
 * @returns {string} QQ；拿不到返回空串
 */
export const qqOfRow = (dir, { store, sheet, row, nickname } = {}) => {
  const name = String(nickname ?? "").trim()
  const ids = typeof store?.qqsOf === "function" ? store.qqsOf(sheet, row) : []
  const bound = ids.filter(qq => String(store?.get?.(sheet, qq)?.nickname ?? "").trim() === name)
  if (bound.length === 1) return String(bound[0])
  const fromDir = String(dir?.get?.(name) ?? "")
  if (fromDir) return fromDir
  /**
   * 都对不上时**留一条日志**（一个名字一条，info 级）：不然"这次为什么没 @ 到人"只能靠猜——
   * 是名单没取到（`memberDirectory` 那边会有 error/说明），还是这个人改了群名片、表里那行还没同步。
   */
  if (name) log("info", `[abyss-queue] 通知里没法 @ 「${name}」（${sheet} 第 ${row} 行）：绑定与群成员名单都没对上，只写了名字`)
  return ""
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
 *
 * **实时名单 + 最近一次扫成功的缓存**两路并起来（实时优先）：实时那一份拿不到时
 * （机器人刚起来、这一下取成员失败、群里查不动）缓存里还有今天扫过的人，
 * 通知就照样 @ 得动——这正是"艾特功能时好时坏"的根子。
 */
export async function memberDirectory(gid) {
  const dir = new Map()
  for (const m of cachedRoster(gid)?.members ?? []) {
    const key = String(m?.nick ?? "").trim()
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
        /** 实时那一份优先：群里刚改的名片要压过缓存里的旧名 */
        if (key) dir.set(key, qq)
      }
      live++
    }
  } catch (err) {
    log("error", `[abyss-queue] 取群 ${gid} 成员名单失败：${err.message}`)
  }
  /** 实时那份是空的时候说一句：不然"通知里怎么没 @ 到人"看不出是名单这一层的问题 */
  if (!live && cached) log("warn", `[abyss-queue] 群 ${gid} 取不到实时成员名单，@ 这条通知改用扫描缓存（${cached} 人）`)
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
