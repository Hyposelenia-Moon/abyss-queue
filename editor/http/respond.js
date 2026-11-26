/** HTTP 收发的基本动作：回 JSON、读请求体、取口令 */
import zlib from "node:zlib"

export const SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

export const cspForPage = nonce =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
export const CSP_PLAIN =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
export const applySecurityHeaders = (res, { csp = CSP_PLAIN } = {}) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  if (csp) res.setHeader("content-security-policy", csp)
}

export const COMPRESS_MIN_BYTES = 1024

const encodingFor = req => {
  const accept = String(req?.headers?.["accept-encoding"] ?? "").toLowerCase()
  if (/(^|[,\s])br($|[,\s;])/.test(accept)) return "br"
  if (/(^|[,\s])gzip($|[,\s;])/.test(accept)) return "gzip"
  return null
}

const compressBuf = (buf, enc) =>
  enc === "br"
    ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
    : zlib.gzipSync(buf, { level: 6 })
export const sendText = (req, res, code, text, { type = "text/html; charset=utf-8", headers = {} } = {}) => {
  const raw = Buffer.from(String(text), "utf8")
  const enc = raw.length >= COMPRESS_MIN_BYTES ? encodingFor(req) : null
  const buf = enc ? compressBuf(raw, enc) : raw
  res.writeHead(code, {
    "content-type": type,
    "content-length": String(buf.length),
    vary: "accept-encoding",
    ...(enc ? { "content-encoding": enc } : {}),
    ...headers,
  })
  return res.end(buf)
}

export const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body), "utf8")
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  })
  res.end(buf)
}

export const JSON_BODY_LIMIT = 4 * 1024 * 1024

export class BodyTooLarge extends Error {
  constructor(message) {
    super(message)
    this.name = "BodyTooLarge"
  }
}

const collectBody = (req, limit, receive) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on("data", c => {
      if (settled) return
      size += c.length
      if (size > limit) {
        settled = true
        reject(new BodyTooLarge(`请求体过大（>${Math.round(limit / 1024 / 1024)}MB）`))
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      try {
        resolve(receive(chunks))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", err => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
export const readBody = req =>
  collectBody(req, JSON_BODY_LIMIT, chunks => (chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})).catch(
    err => {
      if (err instanceof BodyTooLarge) throw err
      throw new Error(`请求体不是合法 JSON：${err.message}`)
    },
  )
export const readRawBody = (req, limit = 32 * 1024 * 1024) =>
  collectBody(req, limit, chunks => Buffer.concat(chunks))
export const drainRequest = (req, timeout = 5000) =>
  new Promise(resolve => {
    if (!req || req.destroyed || req.readableEnded) return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeout)
    req.once("end", finish)
    req.once("error", finish)
    try {
      req.resume()
    } catch {
      finish()
    }
  })
export const queryOf = req => new URL(req.url, "http://localhost")

export const HEADER_OF = {
  k: "x-abyss-token",
  u: "x-abyss-identity",
  s: "x-abyss-sign",
  a: "x-abyss-admin",
  w: "x-abyss-window",
  ws: "x-abyss-window-sign",
}
export const paramOf = (req, key) => {
  const header = String(req?.headers?.[HEADER_OF[key] ?? ""] ?? "").trim()
  if (header) return header
  return queryOf(req).searchParams.get(key) ?? ""
}

export const tokenOf = req => paramOf(req, "k") || paramOf(req, "token")

export const FEATURES = [
  "identity",
  "acl",
  "status-lock",
  "anchors",
  "anchor-add",
  "anchor-options",
  "alias",
  "multi-select",
  "exclusive-done",
  "self-done-nick",
  "archive-options",
  "warning-validation",
  "fields-status",
  "owner",
  "owner-only",
  "sign-key",
  "versions",
  "archives",
  "upload",
  "roster",
  "required4",
  "auto-status",
  "open-catchup",
  "acl-qq",
  "table-version",
  "replace-transition",
  "upload-validate",
  "lock-owner",
  "anchor-version",
  "reload-keep-drafts",
  "ownership-audit",
  "changes",
  "live-refresh",
  "quota",
  "compress",
  "self-status-2",
  "admin-window",
]
