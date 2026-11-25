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
import { messageHandlesOf, messageIdsOf, messageIdOf } from "../components/message-id.js"

/** group_id -> 最近一条机器人排队输出的撤回句柄列表 */
const lastByGroup = new Map()

/** 回执 → 撤回句柄 / message id：实现在 `components/message-id.js`，这里转出去给老调用方 */
export { messageHandlesOf, messageIdsOf, messageIdOf }

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
