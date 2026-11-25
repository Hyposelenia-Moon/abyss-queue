/**
 * 管理员会话 cookie：**窗口刚验过的那一刻种下，24 小时内免带窗口**
 *
 * 为什么需要它（2026-10-18 审核 P1）：管理链接是 `?k&u&s&w&ws`，其中 `w/ws` 只有 5 分钟；
 * 而过期之后**把 `w/ws` 删掉**是放行的（"没带窗口的身份链接照旧放行"），身份签名本身又管 30 天
 * ⇒ 拿到过那条链接的人可以一直当管理员。现在改成：**管理员身份只能从"窗口刚验过的那一刻"进门**，
 * 进门时种这枚 cookie；之后不带窗口的管理员请求必须带着它，否则按过期链接处理（410）。
 *
 * 普通群友不受影响（他们的凭据就是链接里的身份签名，30 天有效，没有设备与"链接新旧"这一层）；
 * 管理口令 `?a=` 也不受影响（那是一枚独立的静态凭证，由页面存起来按请求头带，与时间窗无关）。
 *
 * 2026-11-26 从 `editor.mjs` 整块搬出来：这段与表格、成员名单、路由都没有关系，只认签名密钥，
 * 是"身份与权限"这条边界上最干净的一块。
 */
import crypto from "node:crypto"

export const ADMIN_SESSION_COOKIE = "abyss_admin_ok"
export const ADMIN_SESSION_MS = 24 * 60 * 60 * 1000

export function createSession({ signKey }) {
  /** 这次请求是不是 https（cookie 要不要带 `Secure`） */
  const isHttps = req =>
    Boolean(req?.socket?.encrypted) ||
    String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https"

  /** 读一条 cookie：同名多条时取**最后一个** */
  const cookieOf = (req, name) => {
    let value = ""
    for (const part of String(req?.headers?.cookie ?? "").split(";")) {
      const at = part.indexOf("=")
      if (at < 0) continue
      if (part.slice(0, at).trim() === name) value = part.slice(at + 1).trim()
    }
    return value
  }

  /**
   * 管理员会话令牌 `<QQ>.<过期毫秒>.<HMAC>`：签名把 QQ 与过期时刻一起绑进去，改一个字节就验不过。
   * QQ 也放进 cookie，是为了让**没有链接参数**的 `/queue` 也能认出"这台浏览器登录过谁"。
   */
  const adminSessionToken = (qq, expires = Date.now() + ADMIN_SESSION_MS) =>
    `${String(qq ?? "").trim()}.${expires}.${crypto
      .createHmac("sha256", signKey)
      .update(`admin-session|${String(qq ?? "").trim()}|${expires}`)
      .digest("hex")}`

  /** 从 cookie 里解出并校验管理员会话；不合法/过期返回 null */
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

  /** 这条请求的管理员会话是不是**这个 QQ** 的、而且还没过期 */
  const adminSessionOk = (req, qq) => {
    const id = String(qq ?? "").trim()
    const session = adminSessionOf(req)
    if (session) return Boolean(id) && session.qq === id
    /** 兼容旧版 `<过期>.<HMAC>` cookie（没有 QQ，只能在已知 QQ 时校验） */
    const [exp, mac] = cookieOf(req, ADMIN_SESSION_COOKIE).split(".")
    const expires = Number(exp)
    if (!id || !mac || !Number.isFinite(expires) || expires <= Date.now()) return false
    const want = crypto.createHmac("sha256", signKey).update(`admin-session|${id}|${expires}`).digest("hex")
    return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))
  }

  /** 种 / 续期管理员会话（`Path=/`、24 小时；https 才加 `Secure`，本机 http 调试加了就种不下去） */
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
