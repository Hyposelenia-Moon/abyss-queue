/**
 * 退队 / 改备注 / 清空（主人）类指令
 */
import { config } from "../components/config.js"
import { CLEAR_CONTEXT, PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { rowMatches } from "../lib/queue.js"
import { resolveSheet, sheetChoices } from "../lib/router.js"
import { AppBase } from "./_base.js"

export class AbyssQueueManage extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        { reg: "^#退队(\\s+\\S+)?$", fnc: "leave", permission: config.permission.leave },
        { reg: "^#改备注\\s*\\S[\\s\\S]*$", fnc: "setNote", permission: config.permission.note },
        { reg: "^#清空(\\s+\\S+)?$", fnc: "clearAsk", permission: config.permission.clear },
      ],
    })
  }

  async leave() {
    return this.safe(async () => {
      const qq = this.e.user_id
      const store = await this.store()
      const bound = store.sheetsOf(qq)
      if (!bound.length) return this.reply("你还没有报名记录，发送 #报名 加入排队", true)

      const arg = /^#退队(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
      const models = await this.models()
      let sheet = resolveSheet(arg, models)
      if (!sheet) {
        if (bound.length === 1) sheet = bound[0]
        else if (bound.includes(config.default_sheet)) sheet = config.default_sheet
        else
          return this.reply(
            `你在多个榜都有报名，请指定：#退队 <榜>\n现有：${sheetChoices(models).join("、")}`,
            true,
          )
      }
      if (!bound.includes(sheet)) return this.reply(`你在「${sheet}」没有报名记录`, true)

      const bind = store.get(sheet, qq)
      const model = models.get(sheet)
      if (!model || !rowMatches(model, bind.row, bind.nickname)) {
        store.del(sheet, qq)
        await store.save()
        return this.reply(`表格第 ${bind.row} 行已不是你的记录（可能被人工修改过），已解除绑定。如仍需排队请重新 #报名`, true)
      }

      const { row } = await this.table().mutate(ctx => {
        const fresh = ctx.model(sheet)
        if (!rowMatches(fresh, bind.row, bind.nickname)) throw new Error("表格刚刚被改动，请重试")
        ctx.clearRow(sheet, bind.row)
        return { row: bind.row }
      })

      store.del(sheet, qq)
      await store.save()
      return this.reply(`已退出「${sheet}」排队，表格第 ${row} 行已清空`, true)
    })
  }

  async setNote() {
    return this.safe(async () => {
      const qq = this.e.user_id
      const store = await this.store()
      const text = this.e.msg.replace(/^#改备注\s*/, "").trim()
      if (!text) return this.reply("用法：#改备注 <内容>", true)
      if (text.length > 120) return this.reply("备注太长了（≤120 字）", true)

      const bound = store.sheetsOf(qq)
      if (!bound.length) return this.reply("你还没有报名记录，发送 #报名 加入排队", true)

      const models = await this.models()
      const sheet = bound.includes(config.default_sheet) ? config.default_sheet : bound[0]
      const bind = store.get(sheet, qq)
      const model = models.get(sheet)
      if (!model || !rowMatches(model, bind.row, bind.nickname)) {
        store.del(sheet, qq)
        await store.save()
        return this.reply(`表格第 ${bind.row} 行已不是你的记录，已解除绑定。如仍需排队请重新 #报名`, true)
      }

      await this.table().mutate(ctx => {
        const fresh = ctx.model(sheet)
        if (!rowMatches(fresh, bind.row, bind.nickname)) throw new Error("表格刚刚被改动，请重试")
        ctx.setCell(sheet, bind.row, "note", text)
      })
      return this.reply(`已更新「${sheet}」第 ${bind.row} 行的备注：${text}`, true)
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
