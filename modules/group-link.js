/**
 * 群内 `#排队` 输出的「只留最新一条」
 *
 * 现场：连续发 `#排队` 时旧排队图/链接会堆在群里，还会让人点到已经作废的那条。
 * 这里只做一件事：同一个群成功发出新排队输出后，撤回该群上一条机器人排队消息。
 *
 * 口径：
 *   - **只认群**（`e.isGroup`），私聊不进表、不撤回；
 *   - 只在新消息**发送成功且拿到 message id** 之后才撤回旧消息：新消息没发出去时，
 *     旧消息不能先被撤掉；
 *   - 撤回失败（超时、无权限、适配器不支持）只记 warn，不影响发送；
 *   - 撤回入口按适配器挑：群对象有 `recallMsg` 就用它（OneBotv11 / Milky），
 *     没有就退回 bot 级 `bot.recallMsg(channel_id, id)`（Satori），两条都没有才记 warn；
 *   - 记录在内存里：机器人重启后不追溯重启前的旧消息（重启前的消息 id 也没有了）。
 */
import { log } from "../components/logger.js"

/** group_id -> 最近一条机器人排队输出的撤回句柄列表 */
const lastByGroup = new Map()

/**
 * 从框架的发送回执里取全部撤回句柄
 *
 * 不同适配器返回的形状不一样：`message_id`、`data.message_id`、`data.message_seq`，
 * 有的 Milky 回执是 `{ status, retcode, data: 123 }`，data 本身就是序号；
 * Satori 的 `message.create` 回执是规范 Message 对象，主键叫 `id`。
 * 这里不做无限递归，只按明确优先级取；仍然认不出来时保留原对象，交给适配器自己判断。
 * @param {any} res 发送回执
 * @returns {any[]}
 */
export function messageHandlesOf(res) {
  const list = Array.isArray(res) ? res : [res]
  const out = []
  const add = value => {
    if (value == null || value === "") return
    if (typeof value === "number" && !Number.isFinite(value)) return
    if (out.some(one => Object.is(one, value))) return
    out.push(value)
  }
  for (const one of list) {
    if (one == null) continue
    if (typeof one !== "object") {
      add(one)
      continue
    }
    // Satori 的 `message.create` 回执是规范 Message 对象：主键是 `id`，且一定带 channel/guild/content。
    // 只在这种形状下才认 `id`，避免把别的 `id` 误当消息句柄。
    const looksLikeSatoriMessage = one.channel != null || one.guild != null || one.content != null
    const satoriId = looksLikeSatoriMessage ? (one.id ?? null) : null
    const id = one.message_id ?? one.messageId ?? satoriId
    if (id != null) {
      add(id)
      continue
    }
    const data = one.data
    if (data != null) {
      if (typeof data !== "object") {
        add(data)
        continue
      }
      const nested = data.message_id ?? data.messageId ?? data.message_seq ?? data.messageSeq
      if (nested != null) {
        add(nested)
        continue
      }
      if (data.data != null && typeof data.data !== "object") {
        add(data.data)
        continue
      }
    }
    // 实在拆不出来就把框架原回执当句柄；由 recallMsg/适配器决定是否认识。
    add(one)
  }
  return out
}

/**
 * 从框架的发送回执里取全部 message id（仅用于兼容旧调用方/日志）
 *
 * 对象句柄无法安全转成字符串，这里只返回能字符串化的 id。
 * @param {any} res 发送回执
 * @returns {string[]}
 */
export function messageIdsOf(res) {
  const out = []
  for (const one of messageHandlesOf(res)) {
    if (one && typeof one === "object") continue
    const text = String(one).trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * 兼容旧调用方：只取第一条 message id
 * @param {any} res 发送回执
 * @returns {string}
 */
export function messageIdOf(res) {
  return messageIdsOf(res)[0] ?? ""
}

/** 清空内存记录（只给回归套件用） */
export function resetGroupLinks() {
  lastByGroup.clear()
}

/**
 * 记住这一群的新排队输出，并撤回上一条机器人排队输出
 *
 * 先发新消息成功，再调用这里；句柄可以是字符串、数字或框架原对象，原样交给 recallMsg。
 * 撤回入口按适配器挑：群对象有 `recallMsg` 就用它（OneBotv11 / Milky），
 * 没有就退回 bot 级（Satori：`bot.recallMsg(channel_id, message_id)`）。
 * @param {{isGroup?: boolean, group_id?: string|number, channel_id?: string|number, group?: any, bot?: any, friend?: any}} e 群消息事件
 * @param {any|any[]} messageHandles 新消息的撤回句柄
 */
export async function replaceGroupOutput(e, messageHandles) {
  const gid = String(e?.group_id ?? "").trim()
  const next = (Array.isArray(messageHandles) ? messageHandles : [messageHandles])
    .filter(handle => handle != null && handle !== "")
  const unique = []
  for (const handle of next) {
    if (unique.some(one => Object.is(one, handle))) continue
    unique.push(handle)
  }
  if (e?.isGroup !== true || !gid || !unique.length) return

  const old = lastByGroup.get(gid) ?? []
  const keyOf = handle => (handle && typeof handle === "object" ? JSON.stringify(handle) : String(handle))
  const nextKeys = new Set(unique.map(keyOf))
  const oldHandles = old.filter(handle => !nextKeys.has(keyOf(handle)))
  lastByGroup.set(gid, unique)
  if (!oldHandles.length) return

  const group = globalThis.Bot?.pickGroup?.(gid) ?? e?.group
  for (const handle of oldHandles) {
    const label = typeof handle === "object" ? JSON.stringify(handle) : String(handle)
    try {
      if (group?.recallMsg) {
        await group.recallMsg(handle)
      } else if (typeof e?.bot?.recallMsg === "function") {
        // 有的适配器（Satori）把 recallMsg 挂在 bot 上、并按 channel 撤：group 对象里没有它。
        await e.bot.recallMsg(String(e?.channel_id ?? gid), handle)
      } else {
        throw new Error("当前适配器没有 recallMsg")
      }
    } catch (err) {
      log("warn", `[abyss-queue] 撤回群 ${gid} 上一条排队输出失败（handle=${label}）：${err?.message ?? err}`)
    }
  }
}

/** 兼容旧调用方/回归套件的名字 */
export const replaceGroupLink = replaceGroupOutput
