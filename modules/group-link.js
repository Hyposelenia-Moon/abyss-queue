/** 群内 `#排队` 输出的「只留最新一条」 */
import { log } from "../components/logger.js"
import { messageHandlesOf, messageIdsOf, messageIdOf } from "../components/message-id.js"

const lastByGroup = new Map()

export { messageHandlesOf, messageIdsOf, messageIdOf }

export function resetGroupLinks() {
  lastByGroup.clear()
}

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
        await e.bot.recallMsg(String(e?.channel_id ?? gid), handle)
      } else {
        throw new Error("当前适配器没有 recallMsg")
      }
    } catch (err) {
      log("warn", `[abyss-queue] 撤回群 ${gid} 上一条排队输出失败（handle=${label}）：${err?.message ?? err}`)
    }
  }
}

export const replaceGroupLink = replaceGroupOutput
