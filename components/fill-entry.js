/** 填报入口（填写情况 + 纯文本链接） */
import { config } from "./config.js"
import { editorUrl, signWindow, WINDOW_SIG_CHARS } from "../model/identity.js"
import { isDone, statusOf } from "../modules/progress.js"

export function windowedEditorUrl({ base = "", token = "", signKey = "", qq = "", nick = "", now = Date.now() } = {}) {
  const url = editorUrl(base, { token, signKey, qq, nick, now })
  const win = signWindow({ qq }, String(signKey ?? "").trim() || String(token ?? "").trim(), now)
  if (!url || !win) return ""
  const ws = String(win.ws).slice(0, WINDOW_SIG_CHARS)
  return `${url}&w=${win.w}&ws=${encodeURIComponent(ws)}`
}

export function fillEntry(ctx, sheets, active, { manager = false, now = Date.now(), nick = "" } = {}) {
  const editor = config.editor ?? {}
  const base = String(editor.public_url ?? "").trim().replace(/\/+$/, "")
  const token = String(editor.token ?? "").trim()
  const signKey = String(editor.sign_key ?? "").trim()
  const ready = Boolean(base && token && signKey)
  const qq = String(ctx.e?.user_id ?? "").trim()
  const candidates = [nick, ctx.nickname?.(), ...(typeof ctx.nicknames === "function" ? ctx.nicknames() : [])]
  const selfNick = candidates.map(name => String(name ?? "").trim()).find(name => name && name !== qq) || ""
  const own = name => active.find(a => a.sheet === name)
  const done = sheets.filter(name => isDone(own(name)?.rawStatus))
  const queuing = sheets.filter(name => {
    const item = own(name)
    return Boolean(item) && statusOf(item.rawStatus) === "queued"
  })
  const head = [
    queuing.length ? `未完成：${queuing.join("、")}` : "",
    done.length ? `已完成：${done.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；")
  if (!ready) return { head, link: "暂无链接" }
  const shown = windowedEditorUrl({ base, token, signKey, qq: ctx.e.user_id, nick: selfNick, now })
  if (!shown) return { head, link: "暂无链接" }
  return { head, link: `点此填表：${shown}` }
}
