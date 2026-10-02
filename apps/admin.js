/**
 * 管理类指令：#清空（主人）
 *
 * 报名 / 退队 / 改备注已经移到本地编辑器（tools/editor.mjs）里填，
 * 聊天端只保留查询与这条清空指令。
 */
import { config } from "../components/config.js"
import { CLEAR_CONTEXT, PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { resolveSheet, sheetChoices } from "../lib/router.js"
import { AppBase } from "./_base.js"

export class AbyssQueueAdmin extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [{ reg: "^#清空(\\s+\\S+)?$", fnc: "clearAsk", permission: config.permission.clear }],
    })
  }
  async clearAsk() {
    return this.safe(async () => {
      const arg = /^#清空(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
      const models = await this.models()
      const sheet = resolveSheet(arg, models) ?? resolveSheet(config.default_sheet, models)
      if (!sheet) return this.reply(`没找到这个榜，现有：${sheetChoices(models).join("、")}`, true)

      const count = models.get(sheet).rows.length
      this.setContext(CLEAR_CONTEXT, this.isGroup(), 60)
      return this.reply(
        [`将清空「${sheet}」全部 ${count} 行排队数据（保留序号公式与格式）`, `确认请回复：确认清空 ${sheet}`, "60 秒内有效"].join("\n"),
        true,
      )
    })
  }

  async clearStep() {
    return this.safe(async () => {
      const models = await this.models()
      const arg = /^确认清空\s+(\S+)$/.exec(String(this.e.msg ?? "").trim())?.[1]
      const sheet = resolveSheet(arg, models)
      this.finish(CLEAR_CONTEXT, this.isGroup())
      if (!sheet) return this.reply("格式不对，已取消", true)

      const cleared = await this.table().mutate(ctx => {
        const model = ctx.model(sheet)
        const rows = model.rows.map(i => i.row)
        for (const row of rows) ctx.clearRow(sheet, row)
        return rows.length
      })
      return this.reply(`已清空「${sheet}」${cleared} 行`, true)
    })
  }
}
