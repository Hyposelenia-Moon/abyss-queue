/**
 * 群内填报链接的「只留最新一条」
 *
 * 现场（2026-11-02）：QQ 对普通成员/机器人发的**新链接**做风控，旧链接堆在群里还会让人点到
 * 已经作废的那条。这里只做一件事：同一个群成功发出新链接后，撤回该群上一条机器人链接消息。
 *
 * 口径：
 *   - **只认群**（`e.isGroup`），私聊链接不进表、不撤回；
 *   - 只在新消息**发送成功且拿到 message id** 之后才撤回旧消息：新链接没发出去时，
 *     旧链接不能先被撤掉；
 *   - 撤回失败（超时、无权限、适配器不支持）只记 warn，不影响发送；
 *   - 记录在内存里：机器人重启后不追溯重启前的旧链接（重启前的消息 id 也没有了）。
 */
import { log } from "../components/logger.js"

/** group_id -> 最近一条机器人链接消息的 message id 列表 */
const lastByGroup = new Map()

/**
 * 从框架的发送回执里取全部 message id
 *
 * 图片 + 文字合成一条消息时，不同适配器可能回 `{message_id}`、`[{message_id}, ...]`，
 * 或把图文拆成多条消息。撤回必须把这次**全部**回执都记住，否则只撤图片、文字链接还会留在群里。
 * @param {any} res 发送回执
 * @returns {string[]}
 */
export function messageIdsOf(res) {
  const list = Array.isArray(res) ? res : [res]
  const out = []
  for (const one of list) {
    if (!one || typeof one !== "object") continue
    const id = one.message_id ?? one.messageId ?? one.data?.message_id ?? one.data?.messageId
    const text = id == null ? "" : String(id).trim()
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
 * 记住这一群的新链接消息，并撤回上一条机器人链接消息
 *
 * 先发新消息成功，再调用这里；`oldId === newId`（框架把同一条消息又回了一次）不撤。
 * @param {{isGroup?: boolean, group_id?: string|number}} e 群消息事件
 * @param {string} messageId 新链接消息的 id
 */
export async function replaceGroupLink(e, messageIds) {
  const gid = String(e?.group_id ?? "").trim()
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds])
    .map(id => String(id ?? "").trim())
    .filter(Boolean)
  const next = [...new Set(ids)]
  if (e?.isGroup !== true || !gid || !next.length) return

  const old = lastByGroup.get(gid) ?? []
  const nextSet = new Set(next)
  const oldIds = old.filter(id => !nextSet.has(id))
  lastByGroup.set(gid, next)
  if (!oldIds.length) return

  const group = globalThis.Bot?.pickGroup?.(gid) ?? e?.group
  for (const oldId of oldIds) {
    try {
      if (!group?.recallMsg) throw new Error("当前适配器没有 recallMsg")
      await group.recallMsg(oldId)
    } catch (err) {
      log("warn", `[abyss-queue] 撤回群 ${gid} 上一条链接失败（message=${oldId}）：${err?.message ?? err}`)
    }
  }
}
