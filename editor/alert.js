/** 越界告警：把"有人在越界"这件事**私聊告诉主人** */

export const ALERT_WINDOW_MS = 5 * 60 * 1000

export function createAlerts({ send = null, log = line => console.log(line), windowMs = ALERT_WINDOW_MS } = {}) {
  const state = new Map()
  const alert = ({ qq = "", nick = "", kind = "", text = "", force = false, now = Date.now() } = {}) => {
    const who = `${nick || "（无名）"}（${qq || "?"}）`
    const line = `[editor] 越界告警（${kind}）：${who} ${text}`
    try {
      log("warn", line)
    } catch {
    }
    if (!send) return { sent: false, pending: 0, reason: "没有发送出口（独立模式），只记了日志" }
    const prev = state.get(qq) ?? { lastSentAt: 0, pending: 0 }
    if (!force && prev.lastSentAt && now - prev.lastSentAt < windowMs) {
      prev.pending++
      state.set(qq, prev)
      return { sent: false, pending: prev.pending, reason: `同一个人的上一条告警还在合并窗口里（第 ${prev.pending} 次触发）` }
    }
    const repeat = force ? 0 : prev.pending
    state.set(qq, { lastSentAt: now, pending: 0 })
    const body = repeat
      ? `${text}\n\n（这是 ${Math.round(windowMs / 60000)} 分钟内的第 ${repeat + 1} 次同类触发）`
      : text
    try {
      Promise.resolve(send({ text: body, kind, qq })).catch(err =>
        log("warn", `[editor] 越界告警发不出去（qq=${qq}）：${err?.message ?? err}`),
      )
    } catch (err) {
      log("warn", `[editor] 越界告警发不出去（qq=${qq}）：${err?.message ?? err}`)
      return { sent: false, pending: 0, reason: String(err?.message ?? err) }
    }
    return { sent: true, pending: 0, reason: "" }
  }
  const pendingOf = qq => state.get(String(qq))?.pending ?? 0
  return { alert, pendingOf }
}
