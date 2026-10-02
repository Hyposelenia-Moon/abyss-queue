/**
 * 查询类指令：菜单 / 单榜队列 / 主播列表 / 我的报名
 *
 * 这里同时承载定时推送任务（pushQueue），因为它的输出就是队列概览。
 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME, SHEET_ALIASES_KEYS, SHEETS } from "../components/constants.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderAnchorsImg, renderMenuImg, renderMineImg, renderQueueImg } from "../components/render-html.js"
import { rowMatches } from "../lib/queue.js"
import { renderQueue } from "../lib/render.js"
import { resolveSheet, sheetChoices } from "../lib/router.js"
import { AppBase, log } from "./_base.js"

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
   *   - `#排队`                → 三榜总览菜单
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
        return renderMenuImg(this, this.e, choices, {
          defaultSheet: config.default_sheet,
          version: versionFooter(PLUGIN_NAME),
        })
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
      const bind = store.get(sheet, this.e.user_id)
      const model = models.get(sheet)
      const myRow = bind && rowMatches(model, bind.row, bind.nickname) ? bind.row : 0
      return renderQueueImg(this, this.e, model, { limit: all ? 0 : config.list_limit, myRow })
    })
  }

  async anchors() {
    return this.safe(async () => {
      const arg = /^#主播(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
      const models = await this.models()
      const sheet = resolveSheet(arg, models) ?? resolveSheet(config.default_sheet, models)
      if (!sheet) return this.reply(`没找到这个榜，现有：${sheetChoices(models).join("、")}`)
      return renderAnchorsImg(this, this.e, models.get(sheet))
    })
  }

  async mine() {
    return this.safe(async () => {
      const store = await this.store()
      const bound = store.sheetsOf(this.e.user_id)
      if (!bound.length) return this.reply("你还没有报名记录，发送 #报名 加入排队", true)

      const models = await this.models()
      /* 图片优先；渲染不可用时 renderMineImg 内部回退文本 */
      return renderMineImg(this, this.e, models, store, this.e.user_id)
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
