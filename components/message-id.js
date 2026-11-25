/**
 * 发送回执 → 撤回句柄 / message id（各适配器形状不一，统一在这里认）
 *
 * 这几个函数原来长在 `modules/group-link.js` 里，`modules/manager-link.js` 又自己写了一份
 * 只认第一层 `message_id` 的版本——两边认得的形状不一样，其中一处漏认就会"以为发出去了"。
 * 现在只有这一份，两个模块 import 之后再 re-export，调用方不用改。
 *
 * 为什么 `messageHandlesOf` 不能无限递归：回执里可能把请求体也带回来，深挖会取到不相干的 id；
 * 这里只按明确优先级取，实在拆不出来就把原对象当句柄交给适配器。
 */

/**
 * 从框架的发送回执里取全部撤回句柄
 *
 * 不同适配器返回的形状不一样：`message_id`、`data.message_id`、`data.message_seq`，
 * 有的 Milky 回执是 `{ status, retcode, data: 123 }`，data 本身就是序号；
 * Satori 的 `message.create` 回执是规范 Message 对象，主键叫 `id`。
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
 * 兼容旧调用方：只取第一条 message id（拿不到就返回空串）
 * @param {any} res 发送回执
 * @returns {string}
 */
export function messageIdOf(res) {
  return messageIdsOf(res)[0] ?? ""
}