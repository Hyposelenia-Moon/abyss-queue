/** 个人链接的身份签名（机器人签发、编辑器验签） */
import crypto from "node:crypto"

export const IDENTITY_TTL = 30 * 24 * 60 * 60 * 1000

const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const unb64url = str => Buffer.from(String(str ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64")

const secretOf = token => String(token ?? "").trim()

const hmac = (payload, secret) => crypto.createHmac("sha256", secret).update(String(payload)).digest()

export const WINDOW_SIG_CHARS = 20
const WINDOW_SIG_MIN_BYTES = 15

const sameMac = (want, gotRaw) => {
  const got = Buffer.from(gotRaw)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

const sameMacPrefix = (want, gotRaw) => {
  const got = Buffer.from(gotRaw)
  if (got.length < WINDOW_SIG_MIN_BYTES || got.length > want.length) return false
  return crypto.timingSafeEqual(want.subarray(0, got.length), got)
}

export function signIdentity({ qq = "", nick = "" } = {}, token, now = Date.now()) {
  const secret = secretOf(token)
  if (!secret) return null
  const u = b64url(JSON.stringify({ q: String(qq), n: String(nick), t: Number(now) || Date.now() }))
  return { u, s: b64url(hmac(u, secret)) }
}

export function decodeIdentity(u) {
  try {
    const obj = JSON.parse(unb64url(u).toString("utf8"))
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    return { qq: String(obj.q ?? ""), nick: String(obj.n ?? ""), issuedAt: Number(obj.t) || 0 }
  } catch {
    return null
  }
}

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

export const WINDOW_MS = 5 * 60 * 1000

export const windowEpoch = (now = Date.now()) => Math.floor(Number(now) / WINDOW_MS)

export function signWindow({ qq = "" } = {}, secret, now = Date.now()) {
  const key = secretOf(secret)
  const id = String(qq ?? "").trim()
  if (!key || !/^\d{1,12}$/.test(id)) return null
  const w = String(windowEpoch(now))
  return { w, ws: b64url(hmac(`abyss-window.${w}.${id}`, key)) }
}

export function verifyWindow(w, ws, { qq = "" } = {}, secret, { now = Date.now(), windows = 2 } = {}) {
  const key = secretOf(secret)
  const id = String(qq ?? "").trim()
  if (!key || !id) return null
  const at = Number(String(w ?? "").trim())
  if (!/^\d{1,12}$/.test(String(w ?? "").trim()) || !Number.isSafeInteger(at)) return null
  const current = windowEpoch(now)
  if (at > current || at < current - (Math.max(1, Number(windows) || 1) - 1)) return null
  if (!sameMacPrefix(hmac(`abyss-window.${at}.${id}`, key), unb64url(ws))) return null
  return { window: at }
}
