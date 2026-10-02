/**
 * 查询类指令：菜单 / 单榜队列 / 主播列表 / 我的报名
 *
 * 这里同时承载定时推送任务（pushQueue），因为它的输出就是队列概览。
 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME, SHEET_ALIASES_KEYS, SHEETS } from "../components/constants.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderAnchorsImg, renderMenuImg, renderMineImg, renderQueueImg } from "../components/render-html.js"
import { myRowOf } from "../lib/queue.js"
import { anchorDetailView, mineView, renderAnchorDetail, renderQueue } from "../lib/render.js"
import { resolveSheet, sheetChoices } from "../lib/router.js"
import { AppBase, log } from "./_base.js"

/**
 * 菜单图之后补发一条文字：带访问口令的在线编辑器链接
 *
 * 口令只发给群里的人（这条回复本身就在群里），链接被转发出去时对方也拿不到口令时
 * 就打不开——这就是"仅群成员可访问"的实现方式。
 */
async function sendEditorLink(ctx) {
  const base = String(config.editor_url ?? "").trim()
  if (!base) return
  /** 统一成 <base>/?k=<token>：去掉 base 末尾多余的斜杠，避免出现 // 或漏掉 / */
  const clean = base.replace(/\/+$/, "")
  const token = String(config.editor_token ?? "").trim()
  const url = token ? `${clean}/?k=${encodeURIComponent(token)}` : clean
  return ctx.reply([`填报 / 修改排队信息：${url}`, "（手机点开即可，只在群里发放；打开后地址栏不会显示口令）"].join("\n"), true)
}

export class AbyssQueueQuery extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        /**
         * 唯一入口：#排队 看总览，#排队 <榜> 看单榜。
         * 后缀写法（#危战排队 / #螺旋列表）按榜名精确匹配，不再用通配，避免吞掉 #主播列表 之类。
         * 刻意不接收裸榜名（#幽境危战 / #深渊 等），那些归 Axiu-Plugin 等（优先级更低）所有。
         */
        {
          reg: `^(?:#排队|#排队\\s+\\S[\\s\\S]*|#(?:${SHEETS.join("|")}|${SHEET_ALIASES_KEYS.join("|")})(?:排队|列表))$`,
          fnc: "menu",
        },
        { reg: "^#我的$", fnc: "mine" },
        { reg: "^#主播(\\s+\\S+)?$", fnc: "anchors" },
      ],
    })
  }

  /** 定时推送（默认关闭；cron 与群号来自配置） */
  async init() {
    if (config.push.enable && config.push.groups.length)
      this.task = [
        { name: "深渊排队推送", cron: config.push.cron, fnc: () => this.pushQueue(), log: false },
      ]
  }

  /**
   * #排队 的统一入口
   *   - `#排队`                → 三榜总览菜单（图内带在线编辑器地址）+ 带口令的编辑器链接
   *   - `#排队 <榜> [全部]`     → 该榜队列（榜名支持全名/简称/序号）
   *   - `#<榜>排队`（如 #危战排队）→ 同上，保留这套习惯写法的兼容
   */
  async menu() {
    return this.safe(async () => {
      const msg = this.e.msg.trim()
      /** 无参数 → 菜单 */
      if (/^#排队$/.test(msg)) {
        const models = await this.models()
        const choices = sheetChoices(models).map(n => models.get(n))
        /* 图片优先；渲染不可用时 renderMenuImg 内部回退文本（带版本页脚） */
        await renderMenuImg(this, this.e, choices, {
          defaultSheet: config.default_sheet,
          version: versionFooter(PLUGIN_NAME),
          editorUrl: config.editor_url,
        })
        return sendEditorLink(this)
      }

      /* 有参数 → 单榜：`#排队 <榜> [全部]` 或 `#<榜>排队` */
      const m = /^#排队\s+(\S+)(?:\s+(\S+))?$/.exec(msg) ?? /^#(\S+?)排队$/.exec(msg)
      /** `#排队 全部` 视为对默认榜取全量 */
      let arg = m?.[1]
      let all = m?.[2] === "全部"
      if (arg === "全部") {
        all = true
        arg = ""
      }

      const models = await this.models()
      const sheet = resolveSheet(arg, models) ?? (all ? resolveSheet(config.default_sheet, models) : null)
      if (!sheet) return this.reply(`没找到这个榜，发送 #排队 看总览；现有：${sheetChoices(models).join("、")}`)

      const store = await this.store()
      const model = models.get(sheet)
      /** 绑定优先，其次按群昵称兜底（填表已移到编辑器，多数人没有绑定） */
      const myRow = myRowOf(model, store, sheet, this.e.user_id, this.nickname())
      return renderQueueImg(this, this.e, model, { limit: all ? 0 : config.list_limit, myRow })
    })
  }

  /**
   * #主播 —— 三种用法：
   *   `#主播`            三个榜的主播合并成一张表（同一主播只出现一次）
   *   `#主播 <榜>`       只列该榜的主播
   *   `#主播 <名字>`     文本输出这位主播的详情（专职、各榜强项、直播入口）
   *
   * 榜名优先：参数能解析成榜就当榜名用，否则按主播名找。
   */
  async anchors() {
    return this.safe(async () => {
      const arg = /^#主播(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
      const models = await this.models()

      if (arg) {
        const sheet = resolveSheet(arg, models)
        if (sheet) return renderAnchorsImg(this, this.e, [models.get(sheet)])

        const detail = anchorDetailView([...models.values()], arg)
        if (!detail) return this.reply(`没找到「${arg}」这个榜或主播。榜：${sheetChoices(models).join("、")}`, true)
        return this.reply(renderAnchorDetail(detail), true)
      }

      return renderAnchorsImg(this, this.e, sheetChoices(models).map(n => models.get(n)))
    })
  }

  async mine() {
    return this.safe(async () => {
      const store = await this.store()
      const models = await this.models()
      /** 绑定优先，其次按群昵称兜底：填表已移到编辑器，多数人没有绑定 */
      const view = mineView(models, store, this.e.user_id, this.nickname())
      if (!view.total) return this.reply("还没有你的排队记录。报名请用桌面「排队表编辑器」填表。", true)
      /* 图片优先；渲染不可用时 renderMineImg 内部回退文本 */
      return renderMineImg(this, this.e, view, this.e.user_id)
    })
  }

  /** 定时推送各榜概览 */
  async pushQueue() {
    const models = await this.models()
    const sheets = config.push.sheets?.length ? config.push.sheets : sheetChoices(models)
    const text = sheets
      .map(n => models.get(n))
      .filter(Boolean)
      .map(model => renderQueue(model, { limit: config.push.limit }))
      .join("\n\n")

    for (const gid of config.push.groups) {
      try {
        await Bot.pickGroup(Number(gid)).sendMsg(`【三路深渊排队】\n${text}`)
      } catch (err) {
        log("error", `[abyss-queue] 推送到群 ${gid} 失败：${err.message}`)
      }
    }
  }
}
