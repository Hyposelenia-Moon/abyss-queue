/**
 * 个人链接的**口令登记簿**：把 6 位填表口令换成完整链接
 *
 * ## 为什么需要它
 *
 * 群消息里只发「固定入口页 + 6 位数字口令」（`<public_url>/#code=123456`），不发完整长链接：
 * QQ 会对每条新 URL 重新判定，长链接容易被拦。编辑器按口令反查出完整链接再跳转，
 * 完整链接只在**内存与这份登记簿**里传，不进群消息。
 *
 * 口令是**一次一换**的：每次 `#排队` 换一个新的 6 位数字，5 分钟作废；同一条口令在这 5 分钟
 * 内可以被群里多人反复兑换（链接面向所有群成员，不一次性作废）。
 *
 * ## 口径
 *
 * - **单写者**：只有插件写这个文件，编辑器只读（两边都在 `<插件根>/data` 下，见 `AGENTS.md` 的数据约束）。
 * - 每个 QQ 只留**一条**记录（最新那次 `#排队` 的口令），文件因此很小；读不出来一律当"没有这条口令"。
 * - 落盘走 `model/queue-state.js` 的 `writeJson`（临时文件 + rename 原子替换）。
 */
import crypto from "node:crypto"
import { readJson, writeJson } from "./queue-state.js"
import { config } from "../components/config.js"

/** 标记长度：6 字节 → base64url 8 个字符（"哪一条"的编号，不是凭证） */
const NONCE_BYTES = 6

/** 填表口令有效期：与群入口页换链接的 5 分钟窗口一致 */
export const LINK_CODE_TTL_MS = 5 * 60 * 1000

/** 按填表口令取出已登记的完整链接；机器人与编辑器可各传自己的登记簿 */
export function readLinkTarget(code, { file = config.editorLinksPath, now = Date.now() } = {}) {
  const want = String(code ?? "").trim()
  if (!/^\d{6}$/.test(want)) return null
  const all = readJson(file) ?? {}
  for (const item of Object.values(all)) {
    if (String(item?.code ?? "").trim() !== want) continue
    if (!item?.link || !item?.at) continue
    if (now - Number(item.at) > LINK_CODE_TTL_MS) continue
    return String(item.link)
  }
  return null
}

/** 6 位数字口令；避开同窗口内还在有效期里的其它口令 */
const newCode = (all, at) => {
  const live = new Set(
    Object.values(all ?? {})
      .filter(item => Number(item?.at) > 0 && Number(at) - Number(item.at) <= LINK_CODE_TTL_MS)
      .map(item => String(item?.code ?? "")),
  )
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
    if (!live.has(code)) return code
  }
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
}

/**
 * 发一条新链接的口令：生成 6 位数字、记进登记簿，返回它
 *
 * 写盘失败**不影响发链接**（返回的口令照样可用，只是兑换时换不回链接 ⇒ 那次回退成完整链接）：
 * 一次链接发不出去比"这一条口令暂时换不回来"严重得多。
 *
 * @param {string|number} qq 这条链接属于谁
 * @param {number} [now] 签发时刻（套件注入）
 * @returns {{v: string, at: number, code: string}} `code` 是 6 位填表口令；`v` 是这次签发的编号（给 `recordLinkTarget` 用）
 */
export const issueLink = (qq, now = Date.now()) => {
  const id = String(qq ?? "").trim()
  if (!id) return { v: "", at: 0, code: "" }
  const v = crypto.randomBytes(NONCE_BYTES).toString("base64url")
  const at = Number(now) || Date.now()
  let code = ""
  try {
    const all = readJson(config.editorLinksPath) ?? {}
    code = newCode(all, at)
    all[id] = { v, at, code }
    writeJson(config.editorLinksPath, all)
  } catch {
    /* 记不上就记不上：这次的口令换不回链接，`prepareEntry` 会退回完整链接 */
  }
  return { v, at, code }
}

/**
 * 把刚签好的完整链接记到这一条口令上，给固定入口页的「填表口令」用
 *
 * 固定入口页只让用户输入 6 位数字口令，编辑器按口令反查出完整链接再跳转；
 * 完整链接不放进群消息，避免 QQ 对每条新 URL 重新判定。
 *
 * 只在 `v` 仍是这个 QQ 当前那次签发时写入：如果这一瞬间又发了新链接，旧链接不该覆盖新记录。
 * @param {string|number} qq
 * @param {string} v 这次签发的编号（`issueLink()` 返回的 `v`）
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
