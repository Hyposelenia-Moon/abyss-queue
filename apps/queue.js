/**
 * 查询类指令：菜单 / 单榜队列 / 主播列表 / 我的报名
 *
 * 这里同时承载定时推送任务（pushQueue），因为它的输出就是队列概览。
 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME, SHEETS } from "../components/constants.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderAnchorsImg, renderMenuImg, renderQueueImg } from "../components/render-html.js"
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
        { reg: "^#(排队|三路深渊|深渊菜单|深渊帮助)$", fnc: "menu" },
        { reg: "^#深渊我的$", fnc: "mine" },
        { reg: "^#深渊主播(\\s+\\S+)?$", fnc: "anchors" },
        { reg: `^#(${SHEETS.join("|")})(排队|列表)?(\\s+全部)?$`, fnc: "showSheet" },
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

  async menu() {
    return this.safe(async () => {
      const models = await this.models()
      const choices = sheetChoices(models).map(n => models.get(n))
      /* 图片优先；渲染不可用时 renderMenuImg 内部回退文本（带版本页脚） */
      return renderMenuImg(this, this.e, choices, {
        defaultSheet: config.default_sheet,
        version: versionFooter(PLUGIN_NAME),
      })
    })
  }

  async showSheet() {
    return this.safe(async () => {
      const m = /^#(\S+?)(?:排队|列表)?(?:\s+(全部))?$/.exec(this.e.msg.trim())
      const models = await this.models()
      const sheet = resolveSheet(m?.[1], models)
      if (!sheet) return this.reply(`没找到这个榜，现有：${sheetChoices(models).join("、")}`)

      const store = await this.store()
      const bind = store.get(sheet, this.e.user_id)
      const model = models.get(sheet)
      const myRow = bind && rowMatches(model, bind.row, bind.nickname) ? bind.row : 0
      const limit = m?.[2] ? 0 : config.list_limit
      return renderQueueImg(this, this.e, model, { limit, myRow })
    })
  }

  async anchors() {
    return this.safe(async () => {
      const arg = /^#深渊主播(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
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
      if (!bound.length) return this.reply("你还没有报名记录，发送 #深渊报名 加入排队", true)

      const models = await this.models()
      const lines = bound.map(sheet => {
        const bind = store.get(sheet, this.e.user_id)
        const model = models.get(sheet)
        const item = model?.rows.find(i => i.row === bind.row)
        const ok = item && rowMatches(model, bind.row, bind.nickname)
        return ok
          ? `· ${sheet}：第 ${item.seq || item.row} 位（表格第 ${item.row} 行）｜${[item.anchor, item.goal, item.strength].filter(Boolean).join(" ｜ ")}`
          : `· ${sheet}：绑定已失效（表格第 ${bind.row} 行已被改动），可重新 #深渊报名`
      })
      return this.reply(["你的报名记录：", ...lines].join("\n"), true)
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
