/**
 * 填表口令的**防枚举**：按来源 IP 限流、连续失败冷却
 *
 * ## 为什么要它
 *
 * 6 位数字口令只有 100 万种，`/api/link-code` 又是**公开**端点（入口页本身不带口令），
 * 不设防的话，外部可以按顺序把 100 万种试一遍，撞上一条就能拿到某个真实群成员的
 * 完整身份链接（`u/s` 是 30 天签名，等于借到那个人的群成员权限）。
 *
 * 两轮防护：
 *   1. **按来源 IP 限流**：同一 IP 在窗口内失败太多次就进冷却，冷却期内一律 429；
 *   2. **统一错误**：无效 / 过期回同一句 410，不让枚举者从响应里区分"差一点"。
 *
 * ## 为什么不限制成功次数
 *
 * 这条链接是发给**整个群**的：一条口令对应一次 `#排队`，群里多名成员可能先后、甚至反复
 * 点同一条口令（同一个人刷新一下也会再点一次）。所以成功兑换**不计数、不作废**：口令
 * 在 5 分钟有效期内（`model/editor-links.js` 的 `LINK_CODE_TTL_MS`）可以被任意多次兑换，
 * 过期后自然查不到。这里只挡"猜"，不挡"点"。
 *
 * ## 为什么状态在内存里
 *
 * 编辑器是**单进程单写者**（见 `AGENTS.md` §3.9）：口令登记簿 `data/abyss-editor-links.json`
 * 只有插件写、编辑器只读，往那里写失败计数会破坏这条约束。所以限流计数放在本进程内存里；
 * 重启会丢掉计数，但重启后重新攒失败次数同样要成本，不值得为它引入一份跨进程状态。
 *
 * ## 来源 IP 怎么取
 *
 * 部署在 nginx 后面时，`x-forwarded-for` 由代理**追加**真实来源，所以取**最后一段**；
 * 没有这个头就直接用 socket 地址。**不要取第一段**——第一段是客户端自己写的，等于让枚举者
 * 一个请求换一个 IP。
 */

/** 同一 IP 在窗口内允许失败几次 */
export const LINK_FAIL_LIMIT = 10

/** 失败计数的窗口 */
export const LINK_FAIL_WINDOW_MS = 10 * 60 * 1000

/** 触发冷却后要等多久 */
export const LINK_COOLDOWN_MS = 5 * 60 * 1000

/**
 * 请求的来源 IP
 *
 * `x-forwarded-for` 取**最后一段**（由我们自己的代理追加）；没有就退回 socket 地址。
 * @param {import("node:http").IncomingMessage} req
 * @returns {string}
 */
export const clientIpOf = req => {
  const raw = String(req?.headers?.["x-forwarded-for"] ?? "")
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean)
  if (parts.length) return parts[parts.length - 1]
  return String(req?.socket?.remoteAddress ?? "").trim() || "-"
}

/**
 * 口令守卫（内存）
 *
 * @param {object} [opts]
 * @param {number} [opts.failLimit] 窗口内允许失败几次
 * @param {number} [opts.windowMs] 失败计数窗口
 * @param {number} [opts.cooldownMs] 冷却时长
 * @param {() => number} [opts.now] 取当前时刻（套件注入假时钟）
 */
export function createLinkGuard({
  failLimit = LINK_FAIL_LIMIT,
  windowMs = LINK_FAIL_WINDOW_MS,
  cooldownMs = LINK_COOLDOWN_MS,
  now = Date.now,
} = {}) {
  /** ip → { fails: number[], until: number } */
  const clients = new Map()

  /**
   * 惰性清理：不装定时器
   *
   * 宿主模式下定时器属于 bot 的进程，编辑器不该在上面挂自己的心跳；这些表只在请求进来时
   * 顺手扫一遍，量级是"最近几个 IP"，扫一遍的代价可以忽略。
   */
  const prune = at => {
    for (const [ip, rec] of clients) {
      const alive = rec.fails.filter(t => at - t < windowMs)
      if (rec.until > at || alive.length) clients.set(ip, { fails: alive, until: rec.until })
      else clients.delete(ip)
    }
  }

  const recOf = ip => {
    const key = String(ip ?? "") || "-"
    let rec = clients.get(key)
    if (!rec) {
      rec = { fails: [], until: 0 }
      clients.set(key, rec)
    }
    return rec
  }

  /** 现在能不能试：冷却期内返回 false */
  const allow = ip => {
    const at = now()
    prune(at)
    return recOf(ip).until <= at
  }

  /** 记一次失败；窗口内失败够多就进冷却 */
  const fail = ip => {
    const at = now()
    const rec = recOf(ip)
    rec.fails = rec.fails.filter(t => at - t < windowMs)
    rec.fails.push(at)
    if (rec.fails.length >= failLimit) {
      rec.until = at + cooldownMs
      rec.fails = []
    }
  }

  /** 还在冷却里的话，还要等多少毫秒（`allow` 为真时返回 0） */
  const retryAfterMs = ip => {
    const at = now()
    const until = recOf(ip).until
    return until > at ? until - at : 0
  }

  /** 成功一次：清掉这个 IP 的失败计数（不会被历史失败拖进冷却） */
  const succeed = ip => {
    const rec = recOf(ip)
    rec.fails = []
    rec.until = 0
  }

  return { allow, fail, succeed, retryAfterMs, clientIpOf }
}