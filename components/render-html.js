/**
 * HTML 渲染（图片消息）
 *
 * 走框架的渲染链：this.renderImg(插件目录名, 模板路径, 数据) → art-template → 截图后端。
 * 模板里的 `{{ }}` 默认 HTML 转义，昵称 / 备注里的尖括号不会破坏版式。
 *
 * 设计取舍：
 *   - 模板自包含（样式内联、不引用外部图片字体），因此不依赖 miao-plugin 的资源，
 *     也不受框架渲染目录相对路径规则的影响
 *   - 渲染失败一律返回文本，由调用方兜底发送，避免出现「机器人没反应」
 *   - 图与"填报入口"那几行文案合成**一条消息**发出（渲染时取 retType=base64 不让框架自己发），
 *     免得同一件事在群里刷成两条
 */
import { config } from "./config.js"
import { fontUrls } from "./font.js"
import { log } from "../lib/logger.js"
import { anchorsAllView, anchorsView, menuView, queueView, renderAnchors, renderAnchorsAll, renderMenu, renderMine, renderQueue } from "../lib/render.js"

/** 插件目录名（框架按 plugins/<名字>/resources/... 找模板，必须用目录名而不是插件显示名） */
const PLUGIN = "abyss-queue"

/** 名单超过 list_limit 时的统一措辞（不给精确人数） */
export const OVER_LIMIT_HINT = "还有较多成员排队，请耐心等待"

/** 模板路径（相对 resources/，不含扩展名） */
const TPL = {
  queue: "queue/queue",
  anchors: "queue/anchors",
  /** 榜单总览 + 本人的排队信息，同一张图 */
  menu: "queue/menu",
}

const imgEnabled = () => config.render_image !== false

/**
 * 出图分辨率倍数（设备像素比）
 * 由截图后端按 `data.sys.scale` 落实：2 表示两倍宽高的高清图，CSS 布局与字号不变。
 * 截图后端不支持时该值被忽略，出图仍是 1 倍，不影响功能。
 */
const imgScale = () => (Number(config.render_scale) > 0 ? Number(config.render_scale) : 1)

/**
 * 渲染后端返回的裸数据 → 消息片段
 *
 * 框架的截图后端一般直接给 `segment.image(...)`，个别版本给纯 base64 / Buffer，
 * 认不出来就返回 null（宁可回退文本，也不发一条看不懂的消息）。
 */
const asImage = img => {
  if (!img) return null
  /** 已经是消息片段（框架常见返回） */
  if (typeof img === "object" && !Buffer.isBuffer(img)) return img
  const image = typeof segment !== "undefined" ? segment?.image : null
  if (!image) return null
  if (Buffer.isBuffer(img)) return image(img)
  const s = String(img).trim()
  if (/^(base64:\/\/|data:image\/)/.test(s)) return image(s)
  /** 又长又没有路径分隔符 = 纯 base64；否则当文件路径 */
  if (s.length > 256 && !/[/\\]/.test(s)) return image(`base64://${s}`)
  return image(s)
}

/**
 * 渲染成图片（**不发送**），交给调用方拼进消息
 *
 * 框架的 render 默认「截好图就自己发出去」，这样图与文案必然分成两条消息；
 * 传 `retType: "base64"` 只取图片数据（框架不发送），这里再和图一起回一条。
 * @param ctx 插件实例（真实渲染入口 this.e.runtime.render 会截好图）
 * @returns {Promise<object|boolean|null>} 图片片段 / true（后端已自行发出）/ null（没渲染）
 */
async function renderImage(ctx, e, tpl, data) {
  if (!imgEnabled()) return null
  /** 框架优先把运行时挂在事件对象上；插件基类也自带 renderImg，二者取其一 */
  const render = e?.runtime?.render?.bind(e.runtime) ?? ctx.renderImg.bind(ctx)
  const img = await render(PLUGIN, tpl, data, { e, scale: imgScale(), retType: "base64" })
  if (!img) return null
  /** 后端没认 retType：它已经把图发出去了，调用方只补文案 */
  if (img === true) return true
  return asImage(img)
}

/**
 * 渲染并发送：失败时用文本回退
 * @param ctx 插件实例（用它的 reply，与其它回复同一出口）
 * @param e 事件对象（框架渲染需要 e.runtime）
 * @param text 回退文本（与图片同一份数据口径）
 * @param makeData 模板数据工厂
 * @param extra 附在图下面的文案（填报入口那两行）：与图**同一条消息**发出
 */
async function renderOrFallback(ctx, e, tpl, makeData, text, extra = "") {
  const tail = String(extra ?? "").trim()
  let sent = false
  try {
    const img = await renderImage(ctx, e, tpl, makeData())
    if (img === true) {
      /** 老框架把图自己发了：文案只能另起一条，至少不丢 */
      if (tail) await ctx.reply(tail, true)
      sent = true
    } else if (img) {
      await ctx.reply(tail ? [img, "\n", tail] : [img])
      sent = true
    }
  } catch (err) {
    globalThis.logger?.error?.(`[abyss-queue] 出图失败（${tpl}），改用文本：${err?.message ?? err}`)
  }
  if (!sent) await ctx.reply([text, tail].filter(Boolean).join("\n"), true)
  return sent
}

/**
 * 模板共用数据：字体（首次渲染时从云端拉取并缓存到 data/fonts，不入库）
 * 拉取失败时返回空串，模板自动回落系统字体，不影响出图
 */
const themeData = async () => {
  const fonts = await fontUrls({ log })
  return fonts
}

/**
 * 队列概览
 * @param link 附在图下面的文案（填写情况 + 填报入口），与图同一条消息
 */
export async function renderQueueImg(ctx, e, model, { limit = 20, myRow = 0, link = "" } = {}) {
  const text = renderQueue(model, { limit, myRow })
  const over = model.rows.length > limit
  const theme = await themeData()
  const makeData = () => ({
    ...queueView(model, {
      limit,
      myRow,
      nameMax: config.render_name_max,
      statusMax: config.render_status_max,
    }),
    ...theme,
    /** 超过 list_limit：只给「还得等」的措辞，不给精确人数 */
    moreTotal: over,
    waitHint: OVER_LIMIT_HINT,
    limit,
    plist: [],
  })
  return renderOrFallback(ctx, e, TPL.queue, makeData, text, link)
}

/** 主播列表（全部榜合并） */
export async function renderAnchorsImg(ctx, e, models) {
  const view = anchorsAllView(models)
  const text = renderAnchorsAll(view)
  const theme = await themeData()
  const makeData = () => ({ ...view, ...theme, plist: [] })
  return renderOrFallback(ctx, e, TPL.anchors, makeData, text)
}

/**
 * 总菜单：榜单总览 + 本人的排队信息，合成一张图（常用指令在页脚）
 * @param mine 本人的排队信息（mineView().active），空数组表示表里没有这个人
 * @param link 附在图下面的文案（填写情况 + 填报入口），与图同一条消息
 */
export async function renderMenuImg(
  ctx,
  e,
  models,
  { defaultSheet = "", version = "", mine = [], link = "" } = {},
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
  return renderOrFallback(ctx, e, TPL.menu, makeData, text, link)
}
