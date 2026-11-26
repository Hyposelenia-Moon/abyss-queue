/** 群内 `#排队` 输出：同群只留最新一条，带填表链接的那条 30 秒后自动撤回 */
import { log } from "../components/logger.js"
import { messageHandlesOf, messageIdsOf, messageIdOf } from "../components/message-id.js"

/**
 * 群内链接消息的存活时间（写死，不做配置键）。
 * 管理员 / 主人拿的是私聊链接，真落到群里也不排这个定时器（`keep: true`）。
 */
export const AUTO_RECALL_MS = 30 * 1000

const lastByGroup = new Map()
/** handle 键 → 定时器；点别处撤回、被新消息顶掉、`resetGroupLinks()` 都要能清掉 */
const autoTimers = new Map()

export { messageHandlesOf, messageIdsOf, messageIdOf }

const keyOf = handle => (handle && typeof handle === "object" ? JSON.stringify(handle) : String(handle))
const labelOf = handle => (typeof handle === "object" ? JSON.stringify(handle) : String(handle))

function cancelAuto(key) {
  const timer = autoTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  autoTimers.delete(key)
}

async function recallOne(e, gid, handle) {
  const group = globalThis.Bot?.pickGroup?.(gid) ?? e?.group
  try {
    if (group?.recallMsg) {
      await group.recallMsg(handle)
    } else if (typeof e?.bot?.recallMsg === "function") {
      await e.bot.recallMsg(String(e?.channel_id ?? gid), handle)
    } else {
      throw new Error("当前适配器没有 recallMsg")
    }
    return true
  } catch (err) {
    log("warn", `[abyss-queue] 撤回群 ${gid} 上一条排队输出失败（handle=${labelOf(handle)}）：${err?.message ?? err}`)
    return false
  }
}

/** 到点撤回，并把这条从「最新一条」里摘掉——否则下一条到达时还会再撤一次、刷一条 warn */
function armAutoRecall(e, gid, handle) {
  const key = keyOf(handle)
  cancelAuto(key)
  const timer = setTimeout(async () => {
    autoTimers.delete(key)
    if (!(await recallOne(e, gid, handle))) return
    const left = (lastByGroup.get(gid) ?? []).filter(one => keyOf(one) !== key)
    if (left.length) lastByGroup.set(gid, left)
    else lastByGroup.delete(gid)
  }, AUTO_RECALL_MS)
  timer?.unref?.()
  autoTimers.set(key, timer)
}

export function resetGroupLinks() {
  for (const timer of autoTimers.values()) clearTimeout(timer)
  autoTimers.clear()
  lastByGroup.clear()
}

/**
 * @param e 事件（要 `isGroup` / `group_id`）
 * @param messageHandles 回执里的 handle（数组或单个）
 * @param keep 管理员 / 主人给 `true`：不排 30 秒撤回（「同群只留最新一条」照旧）
 */
export async function replaceGroupOutput(e, messageHandles, { keep = false } = {}) {
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
  const nextKeys = new Set(unique.map(keyOf))
  const oldHandles = old.filter(handle => !nextKeys.has(keyOf(handle)))
  lastByGroup.set(gid, unique)
  if (!keep) for (const handle of unique) armAutoRecall(e, gid, handle)
  if (!oldHandles.length) return
  for (const handle of oldHandles) {
    cancelAuto(keyOf(handle))
    await recallOne(e, gid, handle)
  }
}

export const replaceGroupLink = replaceGroupOutput