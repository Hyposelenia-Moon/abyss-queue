/** 填表口令的**防枚举**：按来源 IP 限流、连续失败冷却 */

export const LINK_FAIL_LIMIT = 10

export const LINK_FAIL_WINDOW_MS = 10 * 60 * 1000

export const LINK_COOLDOWN_MS = 5 * 60 * 1000

export const clientIpOf = req => {
  const raw = String(req?.headers?.["x-forwarded-for"] ?? "")
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean)
  if (parts.length) return parts[parts.length - 1]
  return String(req?.socket?.remoteAddress ?? "").trim() || "-"
}

export function createLinkGuard({
  failLimit = LINK_FAIL_LIMIT,
  windowMs = LINK_FAIL_WINDOW_MS,
  cooldownMs = LINK_COOLDOWN_MS,
  now = Date.now,
} = {}) {
  const clients = new Map()
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
  const allow = ip => {
    const at = now()
    prune(at)
    return recOf(ip).until <= at
  }
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
  const retryAfterMs = ip => {
    const at = now()
    const until = recOf(ip).until
    return until > at ? until - at : 0
  }
  const succeed = ip => {
    const rec = recOf(ip)
    rec.fails = []
    rec.until = 0
  }
  return { allow, fail, succeed, retryAfterMs, clientIpOf }
}
