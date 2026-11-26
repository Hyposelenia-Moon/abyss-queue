/** 个人链接的**口令登记簿**：把 6 位填表口令换成完整链接 */
import crypto from "node:crypto"
import { readJson, writeJson } from "./queue-state.js"
import { config } from "../components/config.js"

const NONCE_BYTES = 6

export const LINK_CODE_TTL_MS = 5 * 60 * 1000

export function readLinkTarget(code, { file = config.editorLinksPath, now = Date.now() } = {}) {
  const want = String(code ?? "").trim()
  if (!/^\d{6}$/.test(want)) return null
  const all = readJson(file) ?? {}
  for (const item of Object.values(all)) {
    if (String(item?.code ?? "").trim() !== want) continue
    if (!item?.link || !item?.at) continue
    if (now - Number(item.at) > LINK_CODE_TTL_MS) continue
    return String(item.link)
  }
  return null
}

const newCode = (all, at) => {
  const live = new Set(
    Object.values(all ?? {})
      .filter(item => Number(item?.at) > 0 && Number(at) - Number(item.at) <= LINK_CODE_TTL_MS)
      .map(item => String(item?.code ?? "")),
  )
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
    if (!live.has(code)) return code
  }
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
}

export const issueLink = (qq, now = Date.now()) => {
  const id = String(qq ?? "").trim()
  if (!id) return { v: "", at: 0, code: "" }
  const v = crypto.randomBytes(NONCE_BYTES).toString("base64url")
  const at = Number(now) || Date.now()
  let code = ""
  try {
    const all = readJson(config.editorLinksPath) ?? {}
    code = newCode(all, at)
    all[id] = { v, at, code }
    writeJson(config.editorLinksPath, all)
  } catch {
  }
  return { v, at, code }
}

export function recordLinkTarget(qq, v, link) {
  const id = String(qq ?? "").trim()
  const mark = String(v ?? "").trim()
  const url = String(link ?? "").trim()
  if (!id || !mark || !url) return false
  try {
    const all = readJson(config.editorLinksPath) ?? {}
    if (String(all?.[id]?.v ?? "").trim() !== mark) return false
    all[id] = { ...all[id], link: url }
    writeJson(config.editorLinksPath, all)
    return true
  } catch {
    return false
  }
}
