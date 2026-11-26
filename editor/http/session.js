/** 管理员会话 cookie：**窗口刚验过的那一刻种下，24 小时内免带窗口** */
import crypto from "node:crypto"

export const ADMIN_SESSION_COOKIE = "abyss_admin_ok"
export const ADMIN_SESSION_MS = 24 * 60 * 60 * 1000

export function createSession({ signKey }) {
  const isHttps = req =>
    Boolean(req?.socket?.encrypted) ||
    String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https"
  const cookieOf = (req, name) => {
    let value = ""
    for (const part of String(req?.headers?.cookie ?? "").split(";")) {
      const at = part.indexOf("=")
      if (at < 0) continue
      if (part.slice(0, at).trim() === name) value = part.slice(at + 1).trim()
    }
    return value
  }
  const adminSessionToken = (qq, expires = Date.now() + ADMIN_SESSION_MS) =>
    `${String(qq ?? "").trim()}.${expires}.${crypto
      .createHmac("sha256", signKey)
      .update(`admin-session|${String(qq ?? "").trim()}|${expires}`)
      .digest("hex")}`
  const adminSessionOf = req => {
    const parts = cookieOf(req, ADMIN_SESSION_COOKIE).split(".")
    if (parts.length !== 3) return null
    const [qq, exp, mac] = parts
    const expires = Number(exp)
    if (!qq || !mac || !Number.isFinite(expires) || expires <= Date.now()) return null
    const want = crypto.createHmac("sha256", signKey).update(`admin-session|${qq}|${expires}`).digest("hex")
    if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null
    return { qq, expires }
  }
  const adminSessionOk = (req, qq) => {
    const id = String(qq ?? "").trim()
    const session = adminSessionOf(req)
    return Boolean(session && id) && session.qq === id
  }
  const setAdminSession = (req, res, qq) => {
    const attrs = [
      `${ADMIN_SESSION_COOKIE}=${adminSessionToken(qq)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}`,
    ]
    if (isHttps(req)) attrs.push("Secure")
    const previous = res.getHeader("set-cookie")
    const list = Array.isArray(previous) ? previous : previous ? [previous] : []
    res.setHeader("set-cookie", [...list, attrs.join("; ")])
  }
  return { isHttps, cookieOf, adminSessionToken, adminSessionOf, adminSessionOk, setAdminSession }
}
