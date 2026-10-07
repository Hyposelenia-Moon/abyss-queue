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

/** 恒时比较两段签名（长度不同直接 false：`timingSafeEqual` 要求两个等长 buffer，而"长度不同"不泄露内容） */
const sameMac = (want, gotRaw) => {
  const got = Buffer.from(gotRaw)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

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
  if (!sameMac(want, got)) return null
  const id = decodeIdentity(u)
  if (!id) return null
  if (ttl > 0 && id.issuedAt && now - id.issuedAt > ttl) return null
  return id
}

/**
 * 拼出编辑器链接：`k=` 带访问口令，`u/s=` 带个人身份
 *
 * @param {string} base 编辑器地址（如 https://example.com/queue）
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

/**
 * 短链的路径段：完整体是 `<editor_url>/s/<码>`
 *
 * 群里发短链是为了别把一百多字符的 `?k=…&u=…&s=…` 摆在聊天里（QQ 里点得开，但很长）。
 * 编辑器与机器人共用这个常量，免得两头写岔。
 */
export const SHORT_PATH = "s"

/**
 * 短码：**16 个 base64url 字符、单段、看不出结构**（例：`3Kd2mQ9xZ4pL7vBnK`）
 *
 * 码里只有"是谁"，而且是**加密后**的：QQ 走一遍 40 位 Feistel 置换（密钥 = 身份签名密钥），
 * 再配 7 字节 MAC。于是：
 *   - 编辑器拿到码就能直接还原 QQ，**不需要存任何映射**（零部署改动，也不依赖群名单）；
 *   - 看不出码与 QQ 的对应关系（不是"QQ 转 base36 再拼签名"那种能从链接里念出 QQ 号的码）；
 *   - 同一个 30 天窗口里，同一个人的码是**固定的**（重复 #排队 拿到同一条链接）。
 * 有效期按 30 天一个窗口算：编辑器同时认"当期"和"上一期"，所以实际可用 **30~60 天**。
 *
 * 码泄露 = 别人能打开你的编辑界面（与长链接泄露同一个量级），所以别转到别的群。
 */
export const TICKET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** 5 字节密文（QQ）+ 7 字节 MAC = 12 字节 → 16 个 base64url 字符 */
const TICKET_BYTES = 12
const TICKET_QQ_BYTES = 5
const TICKET_MAC_BYTES = 7

const epochOf = (now = Date.now()) => Math.floor(Number(now) / TICKET_WINDOW_MS)

/** QQ ↔ 5 字节（40 位够用：QQ 号最多 10 位） */
const qqToBytes = qq => {
  const buf = Buffer.alloc(TICKET_QQ_BYTES)
  buf.writeUIntBE(Number(qq), 0, TICKET_QQ_BYTES)
  return buf
}
const bytesToQq = buf => String(buf.readUIntBE(0, TICKET_QQ_BYTES))

/**
 * 40 位 Feistel 网络：把 5 字节做一个**可逆**置换（密钥 + 窗口参与轮函数）
 *
 * 轮函数取 HMAC 的 20 位，4 轮足够把"相邻 QQ → 相邻密文"的规律打散。
 * 这样码和 QQ 之间没有可推的代数关系——比"异或一段固定密钥流"稳：
 * 那种做法里，同一个窗口的两个码异或一下就是两个 QQ 的异或。
 */
const permute40 = (buf, secret, epoch, back = false) => {
  let l = ((buf[0] << 12) | (buf[1] << 4) | (buf[2] >> 4)) & 0xfffff
  let r = (((buf[2] & 0x0f) << 16) | (buf[3] << 8) | buf[4]) & 0xfffff
  const round = (i, v) => hmac(`abyss-ticket.${i}.${epoch}.${v}`, secret).readUIntBE(0, 3) & 0xfffff
  if (back) {
    for (let i = 3; i >= 0; i--) {
      const next = r ^ round(i, l)
      r = l
      l = next
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const next = l ^ round(i, r)
      l = r
      r = next
    }
  }
  const out = Buffer.alloc(TICKET_QQ_BYTES)
  out[0] = (l >> 12) & 0xff
  out[1] = (l >> 4) & 0xff
  out[2] = ((l & 0x0f) << 4) | ((r >> 16) & 0x0f)
  out[3] = (r >> 8) & 0xff
  out[4] = r & 0xff
  return out
}

const ticketMac = (body, epoch, secret) =>
  hmac(`abyss-ticket.mac.${epoch}.${body.toString("base64url")}`, secret).subarray(0, TICKET_MAC_BYTES)

/**
 * 签一个短码
 * @param {{qq?: string|number}} who 身份（只用得上 QQ）
 * @param {string} secret 身份签名密钥（留空则退回用口令签）
 * @returns {string} 没有密钥 / QQ 不合法时返回空串
 */
export function signTicket({ qq = "" } = {}, secret, now = Date.now()) {
  const key = secretOf(secret)
  const id = String(qq ?? "").trim()
  if (!key || !/^\d{1,12}$/.test(id)) return ""
  const epoch = epochOf(now)
  const body = permute40(qqToBytes(id), key, epoch)
  return b64url(Buffer.concat([body, ticketMac(body, epoch, key)]))
}

/**
 * 验短码
 * @param {number} opts.windows 认几个窗口（默认 2 = 当期 + 上一期，所以可用 30~60 天）
 * @returns {{qq: string, epoch: number, issuedAt: number}|null} 验不过（格式不对 / 被改过 / 过期）一律 null
 */
export function verifyTicket(code, secret, { now = Date.now(), windows = 2 } = {}) {
  const key = secretOf(secret)
  if (!key) return null
  const raw = unb64url(String(code ?? "").trim())
  if (raw.length !== TICKET_BYTES) return null
  const body = raw.subarray(0, TICKET_QQ_BYTES)
  const mac = raw.subarray(TICKET_QQ_BYTES)
  const epoch = epochOf(now)
  for (let i = 0; i < Math.max(1, Number(windows) || 1); i++) {
    const at = epoch - i
    const want = ticketMac(body, at, key)
    if (!sameMac(want, mac)) continue
    const qq = bytesToQq(permute40(body, key, at, true))
    if (!/^\d{1,12}$/.test(qq)) return null
    return { qq, epoch: at, issuedAt: at * TICKET_WINDOW_MS }
  }
  return null
}

/**
 * 个人链接的**时间窗**（5 分钟一格）：`?w=` 带窗口号，`?ws=` 带窗口签名
 *
 * 身份签名（`u/s`）的有效期是 30 天，太长了——链接一旦转发出去，一张截图就能让人用上一个月。
 * 所以链接上再加一层**短窗口**：签发时把"这是哪 5 分钟"（`windowEpoch`）连同身份一起签，
 * 编辑器**只认当前窗口与上一窗口**，更旧的窗口一律拒绝。于是：
 *   - 链接自带过期时刻，编辑器不需要记任何"这条链接什么时候发的"（无状态、可多实例）；
 *   - 过期由**签名覆盖**：改 `w` 就改不动 `ws`，越过窗口就验不过；
 *   - 与短链的 30~60 天窗口**互不替代**，两层一起用（见 `editor/claims.js`）。
 *
 * 为什么认"当前 + 上一"而不是只认当前：窗口边界上签发的链接，客户端与服务器差几秒、
 * 或请求正好跨过整点，只认当前会让它**刚发出就失效**；上一窗口留着正好覆盖这段抖动。
 */
export const WINDOW_MS = 5 * 60 * 1000

/** 这个时刻落在哪个 5 分钟窗口（对 5 分钟取整的 epoch） */
export const windowEpoch = (now = Date.now()) => Math.floor(Number(now) / WINDOW_MS)

/**
 * 签一个时间窗凭证
 * @param {{qq?: string|number}} who 身份（只用得上 QQ，与身份签名同一份输入）
 * @param {string} secret 身份签名密钥
 * @param {number} [now] 签发时间（测试用）
 * @returns {{w: string, ws: string}|null} 没有密钥 / QQ 不合法时返回 null
 */
export function signWindow({ qq = "" } = {}, secret, now = Date.now()) {
  const key = secretOf(secret)
  const id = String(qq ?? "").trim()
  if (!key || !/^\d{1,12}$/.test(id)) return null
  const w = String(windowEpoch(now))
  return { w, ws: b64url(hmac(`abyss-window.${w}.${id}`, key)) }
}

/**
 * 验时间窗凭证
 * @param {object} opts.now 当前时间（测试用）/ `windows` 认几个窗口（默认 2 = 当期 + 上一期）
 * @returns {{window: number}|null} 验不过（格式不对 / 签名不对 / 窗口更旧 / 来自未来）一律 null
 */
export function verifyWindow(w, ws, { qq = "" } = {}, secret, { now = Date.now(), windows = 2 } = {}) {
  const key = secretOf(secret)
  const id = String(qq ?? "").trim()
  if (!key || !id) return null
  const at = Number(String(w ?? "").trim())
  /** 窗口号必须是十进制整数：`Number("0x10")` / `Number("1e3")` 这类别的写法一律不认 */
  if (!/^\d{1,12}$/.test(String(w ?? "").trim()) || !Number.isSafeInteger(at)) return null
  const current = windowEpoch(now)
  /** 未来的窗口不认（客户端时钟快 / 手改）：只接受 `[current - windows + 1, current]` */
  if (at > current || at < current - (Math.max(1, Number(windows) || 1) - 1)) return null
  if (!sameMac(hmac(`abyss-window.${at}.${id}`, key), unb64url(ws))) return null
  return { window: at }
}
