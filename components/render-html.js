/** HTML 渲染（图片消息） */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { config, pluginRoot } from "./config.js"
import { fontUrls } from "./font.js"
import { anchorsAllView, menuView, queueView, renderAnchorsAll, renderMenu, renderMine, renderQueue } from "./render.js"

const PLUGIN = "abyss-queue"

export const OVER_LIMIT_HINT = "还有较多成员排队，请耐心等待"

const TPL = {
  queue: "queue/queue",
  anchors: "queue/anchors",
  menu: "queue/menu",
}

const imgEnabled = () => config.render_image !== false

const imgScale = () => {
  const n = Number(config.render_scale)
  return Number.isFinite(n) && n > 6 ? n : 6
}

const asImage = img => {
  if (!img) return null
  if (typeof img === "object" && !Buffer.isBuffer(img)) return img
  const image = typeof segment !== "undefined" ? segment?.image : null
  if (!image) return null
  if (Buffer.isBuffer(img)) return image(img)
  const s = String(img).trim()
  if (/^(base64:\/\/|data:image\/)/.test(s)) return image(s)
  if (s.length > 256 && !/[/\\]/.test(s)) return image(`base64://${s}`)
  return image(s)
}

async function renderImage(ctx, e, tpl, data) {
  if (!imgEnabled()) return null
  const render = e?.runtime?.render?.bind(e.runtime) ?? ctx.renderImg.bind(ctx)
  const scale = imgScale()
  const payload = { ...(data ?? {}), sys: { ...(data?.sys ?? {}), scale } }
  const img = await render(PLUGIN, tpl, payload, { e, scale, retType: "base64" })
  if (!img) return null
  if (img === true) return true
  return asImage(img)
}

const sendFailed = res => Boolean(res && typeof res === "object" && !Array.isArray(res) && res.error)

async function send(ctx, msg, via = null) {
  const res = await (via ? via(msg) : ctx.reply(msg))
  if (sendFailed(res)) throw new Error(String(res.error?.[0]?.message ?? res.error))
  return res
}

async function renderOrFallback(ctx, e, tpl, makeData, text, { entry = null, send: via = null, onSent = null } = {}) {
  const head = String(entry?.head ?? "").trim()
  const link = String(entry?.link ?? "").trim()
  let sent = false
  let delivered = false
  let result = null
  try {
    const img = await renderImage(ctx, e, tpl, makeData())
    const parts = img === true ? (head ? [head] : []) : img ? [img, ...(head ? [head] : [])] : null
    if (parts) {
      const afterHead = head ? ["\n"] : []
      const msg = [...parts, ...(link ? [...afterHead, link] : [])]
      if (msg.length) result = await send(ctx, msg, via)
      sent = true
      delivered = true
    }
  } catch (err) {
    globalThis.logger?.error?.(`[abyss-queue] 出图失败（${tpl}），改用文本：${err?.message ?? err}`)
  }
  if (!sent) {
    try {
      result = await send(ctx, [text, head, link].filter(Boolean).join("\n"), via)
      delivered = true
    } catch (err) {
      globalThis.logger?.error?.(`[abyss-queue] 纯文本兜底也发不出去（${tpl}）：${err?.message ?? err}`)
    }
  }
  if (delivered && onSent) {
    try {
      await onSent(result)
    } catch (err) {
      globalThis.logger?.warn?.(`[abyss-queue] 发送回执处理失败（${tpl}）：${err?.message ?? err}`)
    }
  }
  return sent
}

/** 四张图的背景底图：云雾图随源码分发（resources/queue/theme/），缺失时给空串，模板退回纯色画布 */
export const THEME_BG = path.join(pluginRoot, "resources", "queue", "theme", "bg-frost.jpg")

const themeBgUrl = () => {
  try {
    return fs.statSync(THEME_BG).isFile() ? pathToFileURL(THEME_BG).href : ""
  } catch {
    return ""
  }
}

const themeData = async () => ({ ...(await fontUrls()), themeBg: themeBgUrl() })

export async function renderQueueImg(
  ctx,
  e,
  model,
  { limit = 20, myRow = 0, own = null, entry = null, moreHint = "", send = null, version = "", onSent = null } = {},
) {
  const text = [renderQueue(model, { limit, myRow, moreHint }), version].filter(Boolean).join("\n")
  const theme = await themeData()
  const view = queueView(model, {
    limit,
    myRow,
    nameMax: config.render_max,
    statusMax: config.render_max,
  })
  const over = view.listed > limit || view.total > 6
  const makeData = () => ({
    ...view,
    own: own ?? view.own,
    ...theme,
    moreTotal: over,
    waitHint: OVER_LIMIT_HINT,
    limit,
    version,
    plist: [],
  })
  return renderOrFallback(ctx, e, TPL.queue, makeData, text, { entry, send, onSent })
}

export async function renderAnchorsImg(ctx, e, models, { version = "", liveLookup = null } = {}) {
  const view = anchorsAllView(models, { liveLookup })
  const text = [renderAnchorsAll(view), version].filter(Boolean).join("\n")
  const theme = await themeData()
  const makeData = () => ({ ...view, ...theme, version, plist: [] })
  return renderOrFallback(ctx, e, TPL.anchors, makeData, text)
}

export function renderHelpText(cfg = {}, groups = []) {
  const lines = [cfg.title || "帮助"]
  if (cfg.subTitle) lines.push(cfg.subTitle)
  for (const g of groups) {
    lines.push("", `【${g.group}】`)
    for (const item of g.list ?? []) lines.push(`· ${item.title}${item.desc ? ` — ${item.desc}` : ""}`)
  }
  if (cfg.note) lines.push("", cfg.note)
  return lines.join("\n")
}

export async function renderHelpImg(ctx, e, { cfg = {}, groups = [], version = "" } = {}) {
  const text = [renderHelpText(cfg, groups), version].filter(Boolean).join("\n")
  const theme = await themeData()
  const makeData = () => ({
    ...cfg,
    helpGroups: groups,
    ...theme,
    version,
    plist: [],
  })
  return renderOrFallback(ctx, e, "queue/help", makeData, text)
}

export async function renderMenuImg(
  ctx,
  e,
  models,
  { defaultSheet = "", version = "", mine = [], entry = null, send = null, onSent = null } = {},
) {
  const mineText = mine.length ? renderMine({ total: mine.length, active: mine }) : ""
  const text = [renderMenu(models, { defaultSheet }), mineText, version].filter(Boolean).join("\n")
  const theme = await themeData()
  const makeData = () => ({
    ...menuView(models, { defaultSheet, version }),
    ...theme,
    mine,
    qq: e?.user_id ?? "",
    plist: [],
  })
  return renderOrFallback(ctx, e, TPL.menu, makeData, text, { entry, send, onSent })
}
