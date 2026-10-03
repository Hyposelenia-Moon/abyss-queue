/**
 * 个人链接的身份签名（机器人签发、编辑器验签）
 *
 * 编辑器部署在云服务器上，与机器人分居两地，它无法自己知道"来的人是谁"。做法是
 * 机器人在群里发链接时把发送者的身份**签进链接**，编辑器用同一份密钥验签：
 *
 *   <editor_url>/?k=<访问口令>&u=<身份>&s=<签名>
 *   u = base64url(JSON) = { q: QQ号, n: 群昵称, t: 签发时间 }
 *   s = base64url(HMAC-SHA256(u, 身份签名密钥))
 *
 * **两个密钥，作用不同，正式部署不要用同一个**：
 *   - 访问口令（`k=`）决定"能不能用这个服务"，它出现在每个人的链接里；
 *   - 身份签名密钥（signKey）决定"你是谁、能改哪些行"，只留在机器人与编辑器手里。
 *   两者相同的话，任何拿到链接的人都能用口令**伪造出别人的身份**（包括主人），
 *   所以 signKey 要单独配一份随机串；不配时才退回用口令签名（只适合本机联调）。
 *
 * 权限只认签名：
 *   - 群里的人从 #排队 拿到的链接自带签名，编辑器据此认出他本人
 *   - 链接被转发、或有人直接打开域名时没有签名，只能只读浏览
 *   - 篡改 u（换成别人的 QQ / 昵称）会让签名对不上，编辑器不认
 *
 * 只用 node 内置的 crypto，双方共用本文件。
 */
import crypto from "node:crypto"

/** 身份有效期：超过则由群里重新发一次 #排队 取新链接 */
export const IDENTITY_TTL = 30 * 24 * 60 * 60 * 1000

const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const unb64url = str => Buffer.from(String(str ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64")

const secretOf = token => String(token ?? "").trim()

const hmac = (payload, secret) => crypto.createHmac("sha256", secret).update(String(payload)).digest()

/**
 * 签发身份：返回 `{ u, s }`；没有口令（本机测试、未配置编辑器）时返回 null
 * @param {{qq?: string|number, nick?: string}} who 身份
 * @param {string} token 与编辑器一致的访问口令
 * @param {number} [now] 签发时间（测试用）
 */
export function signIdentity({ qq = "", nick = "" } = {}, token, now = Date.now()) {
  const secret = secretOf(token)
  if (!secret) return null
  const u = b64url(JSON.stringify({ q: String(qq), n: String(nick), t: Number(now) || Date.now() }))
  return { u, s: b64url(hmac(u, secret)) }
}

/** 只解码不看签名：用于"知道他是谁但不能确定真伪"的场景 */
export function decodeIdentity(u) {
  try {
    const obj = JSON.parse(unb64url(u).toString("utf8"))
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    return { qq: String(obj.q ?? ""), nick: String(obj.n ?? ""), issuedAt: Number(obj.t) || 0 }
  } catch {
    return null
  }
}

/**
 * 验签 + 校验时效
 * @returns {{qq: string, nick: string, issuedAt: number}|null} 验不过一律 null
 */
export function verifyIdentity(u, s, token, { ttl = IDENTITY_TTL, now = Date.now() } = {}) {
  const secret = secretOf(token)
  if (!secret || !u || !s) return null
  const want = hmac(u, secret)
  const got = unb64url(s)
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null
  const id = decodeIdentity(u)
  if (!id) return null
  if (ttl > 0 && id.issuedAt && now - id.issuedAt > ttl) return null
  return id
}

/**
 * 拼出编辑器链接：`k=` 带访问口令，`u/s=` 带个人身份
 *
 * @param {string} base 编辑器地址（如 https://yunzai.axiu.uno/queue）
 * @param {{token?: string, signKey?: string, qq?: string|number, nick?: string, now?: number}} who
 *        token  访问口令（进链接，人人可见）
 *        signKey 身份签名密钥（不进链接，只用来算 s；留空则退回用口令签，正式部署务必单独配）
 * @returns {string} 没有 editor_url 时返回空串
 */
export function editorUrl(base, { token = "", signKey = "", qq = "", nick = "", now } = {}) {
  const root = String(base ?? "").trim().replace(/\/+$/, "")
  if (!root) return ""
  const params = []
  const secret = secretOf(token)
  if (secret) params.push(`k=${encodeURIComponent(secret)}`)
  const id = signIdentity({ qq, nick }, secretOf(signKey) || secret, now)
  if (id) params.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
  return params.length ? `${root}/?${params.join("&")}` : root
}
