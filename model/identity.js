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
 * 群昵称在链接里的形态：`?n=` 后面的那段（base64url(UTF-8)）
 *
 * 为什么用 base64url 而不是百分号转义：中文昵称转义后一个字要占 9 个字符，base64url 只占 4 个，
 * 顺手还避免了"链接里一堆 `%E5%B0%8F`"的观感。空 / 全是空白一律当**没带**。
 */
export const encodeLinkNick = nick => {
  const s = String(nick ?? "").trim()
  return s ? Buffer.from(s, "utf8").toString("base64url") : ""
}

/**
 * 把链接里的 `n=` 解回群昵称：解不出来一律空串
 *
 * **这里不看签名**——它只负责"把这段字翻成人话"，"这段字有没有被改过"由 `verifyFreshness` 回答
 * （`n` 与 `t`/`ts` 是同一段签名覆盖的，改一个字就验不过）。所以调用方必须先验签、再用它的返回值。
 */
export const decodeLinkNick = raw => {
  const s = String(raw ?? "").trim()
  /** 只认 base64url 那套字母表：别的写法（含空格、`%`、`!`）一律当没带，不给 Buffer 去"尽力解" */
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return ""
  return Buffer.from(s, "base64url").toString("utf8").trim()
}

/** 新鲜度的签名输入：**带了群昵称 / 链接标记就一起签**；都没带时与旧格式完全相同（旧链接照旧验得过） */
const freshnessInput = (code, mins, nick64, nonce = "") =>
  `abyss-ticket-at.${code}.${mins}${nick64 ? `.${nick64}` : ""}${nonce ? `.${nonce}` : ""}`

/**
 * 新鲜度签名**只留前 12 字节**（96 位）
 *
 * 为什么截断：这段签名与身份签名不同，它护的是"这条链接是不是刚签发的、昵称有没有被改"——
 * 而真正的凭证是短码自己那 56 位 MAC。整段 HMAC 会在链接里占 **43 个字符**（`ts=` 比码还长），
 * 群里那条链接因此要折五行；截到 96 位只占 16 个字符，省下 27 个字符，安全性仍然充足。
 * 验证时按**给多长就比多长**（见 `verifyFreshness`），所以从前那种整段签名的链接照旧验得过。
 */
const FRESH_MAC_BYTES = 12
/** 短于这个长度的签名一律不认：否则空签名（0 字节）会"前缀匹配"任何东西 */
const FRESH_MAC_MIN_BYTES = 8

/**
 * 短链的**新鲜度**标记：`?t=<签发分钟>&ts=<签名>&n=<群昵称>`
 *
 * 为什么需要它：短码本身是 `(QQ, 密钥, 30 天窗口)` 的**确定性函数**——同一窗口内不管什么时候重新发，
 * 字节完全一样，认领层因此分不出"主人刚重新要的那条"和"转发出去几天的旧副本"，表现就是
 * **先点进来的人把主人的写权限占了、主人重新发 `#排队` 也抢不回来**（认领键里也是那个 30 天窗口）。
 *
 * 做法：机器人**发链接那一刻**额外签一个"签发时刻"（分钟粒度足够——接管窗口是 10 分钟量级），
 * 编辑器在短链那条路由上验它，并把**它**写进 `u` 的签发时间；认领层据此允许"**更新且够新**"的
 * 链接**接管认领**（见 `editor/claims.js` 的 `TAKEOVER_GRACE_MS`）。
 *
 * **群昵称跟着一起签**（`n`）：短码里只有 QQ，群名片一向由编辑器按 QQ 从群名单里补
 * （`editor/roster.js` 的 `nickOf`）。但群名单是**每天推一次**的旁路数据——没配群号、那一天没推成功、
 * 或那个人刚进群，名单里就没有他，签出来的身份 `n` 是空串，页面于是认不出"自己那一行"
 * （现场：主人第一次点自己的链接，看到的是"这个链接里没带上你的群昵称"）。而**发链接这一刻**
 * 机器人手里正好有他的群名片（`ctx.nickname()`），所以把它签进去：编辑器**优先用群名单**（那是最新的名字），
 * 名单里查不到这个 QQ 时才用链接里这份兜底。
 *
 * 两段信息（时刻 + 昵称）**共用同一个 HMAC**：`n` 改一个字 `ts` 就对不上，验不过就整段作废
 * （既没有接管能力，昵称也不采信）——不必再加一段签名，链接也不会更长。签名本身**只留前 12 字节**
 * （见 `FRESH_MAC_BYTES`），所以整条链接短得多。
 *
 * **向后兼容**：短码格式一字未动，`?t&ts` 是加在查询串上的；旧链接没有这两段 ⇒ 只退回"先到先得"，
 * 照旧能用（不会变红、也不会被拒）。**没带 `n` 时签名输入与加它之前一字不差**，所以已经发出去的
 * `?t&ts` 链接照旧验得过（截断只是"比前 12 字节"，整段签名照样通过）。
 */
export const signFreshness = (code, secret, now = Date.now(), nick = "", nonce = "") => {
  const key = secretOf(secret)
  const id = String(code ?? "").trim()
  if (!key || !id) return null
  /** 分钟粒度：接管窗口是 10 分钟，分钟足够；数小、链接也短 */
  const t = Math.floor(Number(now) / 60000)
  const n = encodeLinkNick(nick)
  const v = String(nonce ?? "").trim()
  const mac = hmac(freshnessInput(id, t, n, v), key).subarray(0, FRESH_MAC_BYTES)
  return { t, ts: b64url(mac), ...(n ? { n } : {}), ...(v ? { v } : {}) }
}

/**
 * 验新鲜度标记
 *
 * @param {string} [opts.nick] 链接里那段 `n=` **解开之后**的群昵称（`decodeLinkNick` 的结果）。
 *   它参与验签：`n` 被改过 ⇒ 整段验不过（这条链接既没有接管能力，昵称也不采信）。
 * @param {number} [opts.ttl] 这个签发时刻**还算数**的时长，默认 30 天（= 短码自己的窗口）。
 *   **别把它当成"接管窗口"**：接管另有 `editor/claims.js` 的 `TAKEOVER_GRACE_MS`（10 分钟）把关，
 *   这里的返回值只用来回答两件事——"这条链接是哪一刻签的"（写进身份的 `issuedAt`，
 *   进而决定认领键与"谁更新"的比较）与"昵称可不可信"。所以 ttl 放宽到 30 天没有实际影响
 *   （2026-10-09 终审的观察 3）；真要收紧也只会让老链退回"没有新鲜度"、行为与旧版一字不差。
 * @returns {number} 验得过时返回**签发时刻**（ms）；没带 / 验不过 / 太旧 / 是未来时间一律 0
 *   （0 = "这条链接没有可用的新鲜度"，认领层据此不做接管，其余逻辑一律照旧）
 */
export const verifyFreshness = (
  code,
  t,
  ts,
  secret,
  { now = Date.now(), ttl = TICKET_WINDOW_MS, nick = "", nonce = "" } = {},
) => {
  const key = secretOf(secret)
  const id = String(code ?? "").trim()
  const mins = Number(String(t ?? "").trim())
  if (!key || !id || !Number.isSafeInteger(mins) || mins <= 0) return 0
  /**
   * **给多长就比多长**：现在签的是前 12 字节，而从前的链接是整段 32 字节——
   * 拿整段来比，前 12 字节当然也对得上。短于 `FRESH_MAC_MIN_BYTES` 的一律不认（空签名会前缀匹配一切）。
   */
  const got = unb64url(String(ts ?? "").trim())
  if (got.length < FRESH_MAC_MIN_BYTES || got.length > 32) return 0
  const want = hmac(freshnessInput(id, mins, encodeLinkNick(nick), String(nonce ?? "").trim()), key).subarray(0, got.length)
  if (!sameMac(want, got)) return 0
  const at = mins * 60000
  /** 未来的时间不认（时钟漂一点允许 1 分钟），太旧的也不认（那是旧副本，不该有接管能力） */
  if (at > now + 60 * 1000) return 0
  if (now - at > Math.max(0, Number(ttl) || 0)) return 0
  return at
}

/**
 * 验新鲜度**并**回答"链接里带的那段 `v` 有没有被签过"
 *
 * 这是"最新一条有效"那套（见 `model/editor-links.js`）的入口：链接里的 `v` 本身不是凭证
 * （凭证是签名），所以必须先确认它**确实签在这条链接的新鲜度里**，再去比"是不是该 QQ 最新那一条"。
 *
 * **兼容两层**（口径与 `n` 那一段完全一样）：带 `v` 验不过就退回**不带 `v`** 的输入再验一次——
 * 于是从前那种 `?t&ts&n` 的链接照旧验得过，只是 `nonce` 返回空串（调用方据此把这条链接当"老链接：
 * 只读"处理，见 `editor/editor.mjs` 的 `linkStateOf`）。
 *
 * @returns {{at:number, nonce:string}} `at` = 0 表示整段验不过；`nonce` 为空表示"验过了但没带 v"
 */
export const verifyLinkFreshness = (code, { t, ts, nick = "", nonce = "" } = {}, secret, opts = {}) => {
  const v = String(nonce ?? "").trim()
  if (v) {
    const at = verifyFreshness(code, t, ts, secret, { ...opts, nick, nonce: v })
    if (at) return { at, nonce: v }
  }
  const atOld = verifyFreshness(code, t, ts, secret, { ...opts, nick })
  return { at: atOld, nonce: "" }
}

/**
 * 个人链接的**时间窗**（5 分钟一格）：`?w=` 带窗口号，`?ws=` 带窗口签名 *
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

/**
 * 机器人**发给编辑器**的那些请求，查询串就只有这一种拼法：`k=&u=&s=&w=&ws=`
 *
 * 为什么收成一处（而不是各调用点自己拼）：编辑器的路由闸有一条硬口径——**带身份却不带
 * `w/ws` 的请求只放行"认领过那条链接的设备"**（见 `editor/editor.mjs` 的「链接的时间窗」）。
 * 机器人这些推送（名单 / 整理 / 插队）是**无状态的一次性请求**，没有设备可言，所以必须带窗口；
 * 2026-10-08 的复审报告 §2-#1 就是这么炸的：`roster.js` / `tidy.js` 只带了 `k/u/s`，
 * 于是每天的名单同步与每日整理被 410 挡死，而编辑器侧的套件替请求补了 `w/ws`、把坑盖住了。
 * 拼法集中到这里之后，"出站链接带没带窗口"就是一个可以对着编辑器口径写套件的地方
 * （见 `test/outbound-window.test.mjs`）。
 *
 * `k` 与 `u/s` 的口径与以前一字不差；窗口是**新加的一段**，旧编辑器不认它也没关系（它只多看两个参数）。
 *
 * @param {object} opts
 * @param {string|number} opts.qq 身份（机器人用 `ROSTER_QQ`，插队用发起人）
 * @param {string} [opts.nick] 身份里的群昵称
 * @param {string} [opts.token] 访问口令（`remote.token`）
 * @param {string} [opts.signKey] 身份签名密钥（`remote.sign_key`；没配时退回用口令签）
 * @param {number} [opts.now] 签发时刻（套件注入用）
 * @returns {string} 查询串（**不带 `?`**）；签不出身份（没密钥 / QQ 不合法）时返回空串
 */
export function signedEditorQuery({ qq = "", nick = "", token = "", signKey = "", now = Date.now() } = {}) {
  const pass = secretOf(token)
  const key = secretOf(signKey) || pass
  const id = signIdentity({ qq, nick }, key, now)
  if (!id) return ""
  const params = []
  if (pass) params.push(`k=${encodeURIComponent(pass)}`)
  params.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
  const win = signWindow({ qq }, key, now)
  if (win) params.push(`w=${win.w}`, `ws=${encodeURIComponent(win.ws)}`)
  return params.join("&")
}
