/**
 * 第 7 步：探活 —— 没跑也只报告（不重启机器人、不 kill 进程——那些是主人的决定）
 */
import path from "node:path"
import { OK, PROBE_TIMEOUT_MS, SKIP, oneLine } from "./shared.js"

export async function stepHealth(ctx) {
  const { token } = ctx.secrets
  const url = `http://127.0.0.1:${ctx.port}/healthz?k=${encodeURIComponent(token)}`
  let res
  try {
    res = await ctx.fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    return SKIP(
      `编辑器没在跑（${oneLine(err?.message) || "连不上"}）：下一步要么重启机器人（remote.autostart 会把它拉起来），要么双击 data/${path.basename(ctx.paths.startVbs)}`,
    )
  }
  if (!res?.ok) return SKIP(`编辑器有应答但 /healthz 返回 HTTP ${res?.status}：先看一眼它的日志 data/editor.log`)
  let h = {}
  try {
    h = await res.json()
  } catch (err) {
    return SKIP(`/healthz 的响应不是 JSON（${oneLine(err?.message)}）：可能端口上是别的东西`)
  }
  return OK(`编辑器在跑：版本 ${h.version ?? "?"} · mount ${h.mount || "（根目录）"} · 群名单 ${h.roster ?? "?"} 人`)
}
