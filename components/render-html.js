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
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { config, pluginRoot } from "./config.js"
import { anchorsView, menuView, queueView, renderAnchors, renderMenu, renderQueue } from "../lib/render.js"

/** 插件目录名（框架按 plugins/<名字>/resources/... 找模板，必须用目录名而不是插件显示名） */
const PLUGIN = "abyss-queue"

/** 名单超过 list_limit 时的统一措辞（不给精确人数） */
export const OVER_LIMIT_HINT = "还有较多成员排队，请耐心等待"

/** 模板路径（相对 resources/，不含扩展名） */
const TPL = {
  queue: "queue/queue",
  anchors: "queue/anchors",
  menu: "queue/menu",
}

/** 图片模式下是否启用（配置可关） */
const imgEnabled = () => config.render_image !== false

/**
 * 渲染成图片并发送
 * @param ctx 插件实例（真实渲染入口 this.e.runtime.render 会截好图并自动发出）
 * @returns {Promise<boolean>} true = 已发出图片；false = 未渲染，调用方应回退文本
 */
async function sendImage(ctx, e, tpl, data) {
  if (!imgEnabled()) return false
  /** 框架优先把运行时挂在事件对象上；插件基类也自带 renderImg，二者取其一 */
  const render = e?.runtime?.render?.bind(e.runtime) ?? ctx.renderImg.bind(ctx)
  const img = await render(PLUGIN, tpl, data, { e })
  if (!img) return false
  // 渲染后端在部分配置下直接返回图片数据而不自动发送
  if (typeof img === "string") await ctx.reply(img)
  return true
}

/**
 * 渲染并发送：失败时用文本回退
 * @param ctx 插件实例（用它的 reply，与其它回复同一出口）
 * @param e 事件对象（框架渲染需要 e.runtime）
 * @param text 回退文本（与图片同一份数据口径）
 * @param makeData 模板数据工厂
 */
async function renderOrFallback(ctx, e, tpl, makeData, text) {
  try {
    if (await sendImage(ctx, e, tpl, makeData())) return true
  } catch (err) {
    logger?.error?.(`[abyss-queue] 渲染图片失败（${tpl}），回退文本：${err?.message ?? err}`)
  }
  await ctx.reply(text, true)
  return false
}

/**
 * 字体与资源：用绝对 file:// 路径，避免框架的 `_res_path` 相对路径规则（与 cwd 相关）出错
 */
const fontFile = name => pathToFileURL(path.join(pluginRoot, "resources", "fonts", name)).href

/** 模板共用数据：字体与主题 */
const themeData = () => ({
  fontTitle: fontFile("HYWH-65W.ttf"),
  fontBody: fontFile("NZBZ.ttf"),
  fontNumber: fontFile("tttgbnumber.ttf"),
})

/** 队列概览：图片优先，失败回退文本 */
export async function renderQueueImg(ctx, e, model, { limit = 20, myRow = 0 } = {}) {
  const text = renderQueue(model, { limit, myRow })
  const over = model.rows.length > limit
  const makeData = () => ({
    ...queueView(model, {
      limit,
      myRow,
      nameMax: config.render_name_max,
      statusMax: config.render_status_max,
    }),
    ...themeData(),
    /** 超过 list_limit：只给「还得等」的措辞，不给精确人数 */
    moreTotal: over,
    waitHint: OVER_LIMIT_HINT,
    limit,
    plist: [],
  })
  return renderOrFallback(ctx, e, TPL.queue, makeData, text)
}

/** 主播列表：图片优先，失败回退文本 */
export async function renderAnchorsImg(ctx, e, model) {
  const text = renderAnchors(model)
  const makeData = () => ({ ...anchorsView(model), ...themeData(), plist: [] })
  return renderOrFallback(ctx, e, TPL.anchors, makeData, text)
}

/** 总菜单：图片优先，失败回退文本（文本带版本页脚） */
export async function renderMenuImg(ctx, e, models, { defaultSheet = "", version = "" } = {}) {
  const text = [renderMenu(models, { defaultSheet }), version].filter(Boolean).join("\n")
  const makeData = () => ({ ...menuView(models, { defaultSheet, version }), ...themeData(), plist: [] })
  return renderOrFallback(ctx, e, TPL.menu, makeData, text)
}
