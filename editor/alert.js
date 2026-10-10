/**
 * 越界告警：把"有人在越界"这件事**私聊告诉主人**
 *
 * ## 为什么是私聊，为什么由宿主发
 *
 * 编辑器可能独立跑（`node editor/editor.mjs`），手里没有 `Bot`，**发不出任何消息**；
 * 它只负责回答三个问题："该告警了 / 告给谁 / 说什么"。真正的发送由宿主注入
 * （`editor/injected.js` 的 `injectOwnerAlert`，宿主实现见 `modules/editor-host.js` 的
 * `sendOwnerAlert`）。独立模式下这条缝是空的 ⇒ 退化成**记一行日志**，不影响任何判定。
 *
 * ## 限频的两档
 *
 * - **硬红线**（清空别人的行、改别人那一行的群昵称）：`force: true`，**每次都发**——
 *   那是不可逆或改身份的动作，主人必须立刻知道；
 * - **其他越界**（额度超限等）：**同一个 QQ 在一个窗口内只发一条**，并把这一窗口里触发了几次
 *   累进下一条（"他在 14:02–14:05 试了 3 次"）。恶意与否看的是趋势，不是被刷屏。
 *
 * 告警**永远不影响保存的判定**：拒绝早就在服务端落实完了，这里发不出去只记日志。
 */

/** 同一 QQ 的非强制告警多久合并一次（默认 5 分钟） */
export const ALERT_WINDOW_MS = 5 * 60 * 1000

/**
 * @param {object} deps
 * @param {(payload: {text: string, kind: string, qq: string}) => any} [deps.send] 发送出口（宿主注入；没有就只记日志）
 * @param {(level: string, msg: string) => void} [deps.log] 日志出口
 * @param {number} [deps.windowMs] 非强制告警的合并窗口
 */
export function createAlerts({ send = null, log = line => console.log(line), windowMs = ALERT_WINDOW_MS } = {}) {
  /** 每个 QQ 的非强制告警状态：`{ lastSentAt, pending }`（`pending` = 这段时间里触发了几次） */
  const state = new Map()

  /**
   * @param {object} item
   * @param {string} item.qq 越界的人
   * @param {string} [item.nick] 他的群昵称（只用来写文案）
   * @param {string} item.kind 哪一类（`redline` / `quota` / `roster`…）
   * @param {string} item.text 要说的话
   * @param {boolean} [item.force] 硬红线：跳过限频，每次都发
   * @param {number} [item.now] 判定时刻（套件注入）
   * @returns {{sent: boolean, pending: number, reason: string}} `reason` 说明"发了 / 为什么没发"
   */
  const alert = ({ qq = "", nick = "", kind = "", text = "", force = false, now = Date.now() } = {}) => {
    const who = `${nick || "（无名）"}（${qq || "?"}）`
    const line = `[editor] 越界告警（${kind}）：${who} ${text}`
    try {
      log("warn", line)
    } catch {
      /* 日志出口自己出错不影响业务 */
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

  /** 这个 QQ 现在挂着几次没发出去的触发（套件断言用） */
  const pendingOf = qq => state.get(String(qq))?.pending ?? 0

  return { alert, pendingOf }
}
