/** 直播入口解析（纯函数，不联网） */


const clean = s => String(s ?? "").trim()

const URL_RE = /https?:\/\/[^\s<>"'、，,]+/i

const trimUrl = url => url.replace(/[)\]）】。；;]+$/, "")

export function parseEntry(raw) {
  const text = clean(raw)
  const url = trimUrl(URL_RE.exec(text)?.[0] ?? "")
  const out = { text, platform: "", url, kind: "other", roomId: "", uid: "" }
  let hostPlatform = ""
  if (url) {
    let u = null
    try {
      u = new URL(url)
    } catch {
      u = null
    }
    if (u) {
      const host = u.hostname.toLowerCase()
      const segs = u.pathname.split("/").filter(Boolean)
      if (host === "live.bilibili.com") {
        out.kind = "bili-live"
        hostPlatform = "B站"
        out.roomId = [...segs].reverse().find(s => /^\d+$/.test(s)) ?? ""
      } else if (host === "space.bilibili.com") {
        out.kind = "bili-space"
        hostPlatform = "B站"
        out.uid = segs.find(s => /^\d+$/.test(s)) ?? ""
      } else if (host === "b23.tv" || host === "bili2233.cn") {
        out.kind = "bili-short"
        hostPlatform = "B站"
      }
    }
  }
  if (hostPlatform) out.platform = hostPlatform
  else if (!url && /b站|bilibili|哔哩/i.test(text)) out.platform = "B站"
  return out
}

export const parseEntries = entries =>
  (Array.isArray(entries) ? entries : [entries]).map(parseEntry).filter(e => e.text)
export const biliKey = e => (e?.roomId ? `room:${e.roomId}` : e?.uid ? `uid:${e.uid}` : "")

export function collectBiliRefs(entries) {
  const seen = new Map()
  for (const entry of parseEntries(entries)) {
    const key = biliKey(entry)
    if (!key || seen.has(key)) continue
    seen.set(key, { key, roomId: entry.roomId, uid: entry.uid, entry })
  }
  return [...seen.values()]
}
