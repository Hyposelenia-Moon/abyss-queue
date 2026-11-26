/** 把编辑器挂到 bot 自己的 HTTP server 上（**随框架启停**，与锅巴同一形态） */
import path from "node:path"
import { EDITOR_MOUNT } from "../components/constants.js"
import { config, pluginRoot } from "../components/config.js"
import { at } from "../components/notify-send.js"
import { log } from "../components/logger.js"

export { EDITOR_MOUNT }

export const editorTablePath = () => path.join(pluginRoot, "data", "queue.xlsx")

const STANDALONE_PORT = 7788

const PROBE_TIMEOUT_MS = 800

const INTERLOCK_WATCH_MS = 5 * 60_000

export const isEditorPath = (url, mount = EDITOR_MOUNT) => {
  const pathname = String(url ?? "").split("?")[0]
  return pathname === mount || pathname.startsWith(`${mount}/`)
}

export async function standaloneEditorAlive({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${STANDALONE_PORT}${EDITOR_MOUNT}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.status === 200 || res.status === 403
  } catch {
    return false
  }
}

let mounted = false

export async function sendOwnerAlert({ owners = [], text = "", logImpl = log, pickFriend = null } = {}) {
  const pick = pickFriend ?? (qq => globalThis.Bot?.pickFriend?.(Number(qq) || qq))
  const list = [...new Set((owners ?? []).map(q => String(q ?? "").trim()).filter(Boolean))]
  if (!list.length) {
    logImpl("warn", "[abyss-queue] 编辑器要告警主人，但主人名单是空的——这条告警只留在日志里")
    return { sent: 0, failed: 0 }
  }
  let sent = 0
  let failed = 0
  for (const qq of list) {
    try {
      const friend = pick(qq)
      if (!friend?.sendMsg) throw new Error("框架没有 Bot.pickFriend（不能私聊）")
      await friend.sendMsg(text)
      sent++
    } catch (err) {
      failed++
      logImpl("warn", `[abyss-queue] 越界告警发不出去（qq=${qq}）：${err?.message ?? err}`)
    }
  }
  return { sent, failed }
}

export async function sendGroupCall({
  qq,
  nickname = "",
  text = " 主播喊你回家吃饭了",
  sheet = "",
  row = 0,
  groupId = 0,
  pickGroup = null,
  logImpl = log,
} = {}) {
  const target = String(qq ?? "").trim()
  if (!target) throw new Error("缺少要呼叫的 QQ")
  const gid =
    Number(groupId) ||
    Number((config.notify?.groups ?? []).map(Number).filter(Boolean)[0]) ||
    Number(config.roster?.group) ||
    0
  if (!gid) throw new Error("没有配置通知群或群名单群号，无法呼叫")
  const pick = pickGroup ?? (id => globalThis.Bot?.pickGroup?.(id))
  const group = pick(gid)
  if (!group?.sendMsg) throw new Error("框架没有 Bot.pickGroup（不能发群消息）")
  if (typeof group.pickMember === "function") {
    const member = await group.pickMember(Number(target))
    if (!member) throw new Error("对方不在这个群里，无法 @")
  }
  await group.sendMsg([at(target, nickname), text])
  logImpl?.("info", `[abyss-queue] 编辑器呼叫：${sheet || "（未给榜）"} 第 ${row || "?"} 行 → 群 ${gid} @${target}`)
  return { sent: true, group: gid }
}

export function startInterlockWatch({
  fetchImpl = globalThis.fetch,
  logImpl = log,
  intervalMs = INTERLOCK_WATCH_MS,
} = {}) {
  if (!(intervalMs > 0)) return { stop() {} }
  let alarmed = false
  const timer = setInterval(async () => {
    const alive = await standaloneEditorAlive({ fetchImpl })
    if (alive && !alarmed) {
      alarmed = true
      logImpl(
        "error",
        `[abyss-queue] 127.0.0.1:${STANDALONE_PORT} 上出现了独立编辑器：同一张表现在有两个写者` +
          `（宿主里的 + 那个进程）。请停掉它（并清掉拉起它的计划任务 / vbs），再重启机器人。`,
      )
    } else if (!alive && alarmed) {
      alarmed = false
      logImpl("info", `[abyss-queue] 127.0.0.1:${STANDALONE_PORT} 上那个独立编辑器已经没了（互锁恢复常态）`)
    }
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

export async function startEditorHost({
  server = globalThis.Bot?.server,
  express = globalThis.Bot?.express,
  fetchImpl = globalThis.fetch,
  logImpl = log,
  interlockWatchMs = INTERLOCK_WATCH_MS,
} = {}) {
  const mount = EDITOR_MOUNT
  if (mounted) return { mounted: true, reason: "already-mounted", mount }
  if (!server || typeof server.on !== "function") {
    logImpl("warn", "[abyss-queue] 编辑器不挂到 bot 端口（框架没有可共享的 http server）——本次不挂载，/queue 会 404")
    return { mounted: false, reason: "no-shared-server" }
  }
  if (!express || typeof express !== "function") {
    logImpl("warn", "[abyss-queue] 编辑器不挂到 bot 端口（框架没有可共享的 express）——本次不挂载，/queue 会 404")
    return { mounted: false, reason: "no-shared-express" }
  }
  if (await standaloneEditorAlive({ fetchImpl })) {
    logImpl("warn", `[abyss-queue] 127.0.0.1:${STANDALONE_PORT} 上已有独立编辑器在服务，本次不挂到 bot 端口（避免两个写者）——/queue 会 404，先停掉那个进程再重启机器人`)
    return { mounted: false, reason: "standalone-running" }
  }
  const table = editorTablePath()
  let handler
  let applySecurityHeaders = null
  try {
    const { injectEditorConfig, injectEditorLog, injectOwnerAlert, injectGroupCall } = await import(
      "../editor/injected.js"
    )
    injectEditorConfig({
      "--file": table,
      "--token": config.editor?.token ?? "",
      "--sign-key": config.editor?.sign_key ?? "",
      "--admin-token": config.editor?.admin_token ?? "",
      "--mount": mount,
    })
    injectEditorLog(line => logImpl("info", line))
    injectOwnerAlert(({ text, owners }) => sendOwnerAlert({ owners, text, logImpl }))
    injectGroupCall(({ qq, sheet, row, nickname, text }) =>
      sendGroupCall({ qq, nickname, text, sheet, row, logImpl }).then(out => ({ ...out, nickname })),
    )
    ;({ handler } = await import("../editor/editor.mjs"))
    ;({ applySecurityHeaders } = await import("../editor/http/respond.js"))
  } catch (err) {
    const detail = Array.isArray(err?.lines) ? err.lines : [String(err?.message ?? err)]
    logImpl("error", `[abyss-queue] 编辑器没挂上（bot 继续跑）：${detail.join(" / ")}`)
    return { mounted: false, reason: "config-invalid", detail }
  }
  const previous = server.listeners("request")
  if (!previous.length) {
    logImpl("warn", "[abyss-queue] 编辑器不挂到 bot 端口（这个 server 上没有 request 监听器，形态不对）——本次不挂载，/queue 会 404")
    return { mounted: false, reason: "no-request-listener" }
  }
  const dispatchEditor = (req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      logImpl("error", `[abyss-queue] 编辑器请求处理失败：${err?.stack ?? err}`)
      try {
        if (res.headersSent) res.end()
        else {
          applySecurityHeaders?.(res)
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          res.end("editor error")
        }
      } catch {
      }
    })
  }
  server.removeAllListeners("request")
  server.on("request", (req, res) => {
    if (isEditorPath(req.url, mount)) return dispatchEditor(req, res)
    for (const listener of previous) {
      if (res.writableEnded || res.headersSent) break
      listener.call(server, req, res)
    }
  })
  mounted = true
  logImpl("info", `[abyss-queue] 编辑器已挂到 bot 端口：${mount}（表 ${table}）`)
  startInterlockWatch({ fetchImpl, logImpl, intervalMs: interlockWatchMs })
  return { mounted: true, reason: "mounted", mount, table }
}
