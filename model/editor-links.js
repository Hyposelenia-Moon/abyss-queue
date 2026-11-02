/**
 * 个人链接的**登记簿**：每个 QQ 当前"最新那一条"的标记（`v`）
 *
 * ## 为什么需要它
 *
 * 长链接里的身份签名是 30 天有效的**确定性凭证**——同一个人在同一窗口里发多少次，
 * 身份字节完全一样。于是"专属链接"实际上是一把**30 天不变的钥匙**：转发出去、截图存下来，
 * 一个月内一直有效，而且分不出新旧。
 *
 * 所以机器人每发一次 `#排队` 就额外生成一个随机标记 `v`（放在链接的 `?v=` 上），
 * 并在这里记下"这个 QQ 现在最新的是哪一个"。编辑器只认最新那一条可写，其余的**只读浏览**——
 * 本人发现链接被私下转发时，**重发一次 `#排队` 就等于把它作废**。
 *
 * ## 口径
 *
 * - **单写者**：只有插件写这个文件，编辑器只读（两边都在 `<插件根>/data` 下，见 `AGENTS.md` 的数据约束）。
 * - 每个 QQ 只留**一条**记录（最新那条），文件因此很小；读不出来一律当"没登记过"
 *   （调用方那时不做"新旧"判定，见 `editor/editor.mjs` 的 `linkStateOf`——**不据此拒人**）。
 * - 落盘走 `model/queue-state.js` 的 `writeJson`（临时文件 + rename 原子替换）。
 */
import crypto from "node:crypto"
import { readJson, writeJson } from "./queue-state.js"
import { config } from "../components/config.js"

/** 标记长度：6 字节 → base64url 8 个字符（链接要短，够用：这是"哪一条"的编号，不是凭证） */
const NONCE_BYTES = 6

/** 这个 QQ 现在的**最新链接标记**（没登记过返回空串） */
export const latestLinkOf = qq => {
  const id = String(qq ?? "").trim()
  if (!id) return ""
  const all = readJson(config.editorLinksPath)
  return String(all?.[id]?.v ?? "").trim()
}

/**
 * 发一条新链接：生成标记、记下"它现在是最新的"，返回标记
 *
 * 写盘失败**不影响发链接**（返回的标记照样可用，只是编辑器那边比不出新旧 ⇒ 退回"不据此拒人"）：
 * 一次链接发不出去比"这一条链接暂时判不出新旧"严重得多。
 *
 * @param {string|number} qq 这条链接属于谁
 * @param {number} [now] 签发时刻（套件注入）
 * @returns {{v: string, at: number}} `v` 为空 = 没生成（QQ 不合法 / 生成失败）
 */
export const issueLink = (qq, now = Date.now()) => {
  const id = String(qq ?? "").trim()
  if (!id) return { v: "", at: 0 }
  const v = crypto.randomBytes(NONCE_BYTES).toString("base64url")
  const at = Number(now) || Date.now()
  try {
    const all = readJson(config.editorLinksPath) ?? {}
    all[id] = { v, at }
    writeJson(config.editorLinksPath, all)
  } catch {
    /* 记不上就记不上：这次的标记照样签进链接（只是编辑器比不出新旧，见上面） */
  }
  return { v, at }
}

/**
 * 把刚签好的完整链接记到这一条 `v` 上，给固定入口页的「填表口令」用
 *
 * 固定入口页只让用户输入 8 位口令（就是 `v`），编辑器按口令反查出完整链接再跳转；
 * 完整链接不放进群消息，避免 QQ 对每条新 URL 重新判定。
 *
 * 只在 `v` 仍是这个 QQ 当前最新标记时写入：如果这一瞬间又发了新链接，旧链接不该覆盖新记录。
 * @param {string|number} qq
 * @param {string} v 链接标记
 * @param {string} link 完整长链接
 * @returns {boolean} 是否写成功
 */
export function recordLinkTarget(qq, v, link) {
  const id = String(qq ?? "").trim()
  const mark = String(v ?? "").trim()
  const url = String(link ?? "").trim()
  if (!id || !mark || !url) return false
  try {
    const all = readJson(config.editorLinksPath) ?? {}
    if (String(all?.[id]?.v ?? "").trim() !== mark) return false
    all[id] = { ...all[id], link: url }
    writeJson(config.editorLinksPath, all)
    return true
  } catch {
    return false
  }
}
