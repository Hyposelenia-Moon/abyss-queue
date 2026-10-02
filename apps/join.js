/**
 * 报名类指令：引导式（多步上下文）与一行式
 */
import { config } from "../components/config.js"
import { JOIN_CONTEXT, JOIN_USAGE, PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { findByNickname, firstEmptyRow, joinCells, matchOption, rowMatches, validateJoin } from "../lib/queue.js"
import { renderJoinSummary } from "../lib/render.js"
import { ValidationError, normalizeChoice, optionNotice, optionPrompt, resolveSheet, sheetChoices, tokenize } from "../lib/router.js"
import { drafts } from "../model/drafts.js"
import { AppBase } from "./_base.js"

export class AbyssQueueJoin extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        { reg: "^#深渊报名\\s*$", fnc: "joinGuide", permission: config.permission.join },
        { reg: "^#深渊报名\\s+\\S[\\s\\S]*$", fnc: "joinInline", permission: config.permission.join },
      ],
    })
  }

  async joinGuide() {
    return this.safe(async () => {
      const models = await this.models()
      const choices = sheetChoices(models)
      drafts.set(this.draftKey(), { step: "sheet", data: {} })
      this.armJoin()
      return this.reply(
        [
          "请选择要报名的榜（回复序号或榜名）：",
          ...choices.map((n, i) => `${i + 1}. ${n}（当前 ${models.get(n).rows.length} 人）`),
          "",
          "随时回复「取消」可退出报名",
        ].join("\n"),
        true,
      )
    })
  }

  async joinStep() {
    return this.safe(async () => {
      const key = this.draftKey()
      const draft = drafts.get(key)
      if (!draft) {
        this.finish(JOIN_CONTEXT, this.isGroup())
        return this.reply("会话已过期，请重新发送 #深渊报名", true)
      }

      const msg = String(this.e.msg ?? "").trim()
      if (/^(取消|退出|结束|q)$/i.test(msg)) {
        drafts.delete(key)
        this.finish(JOIN_CONTEXT, this.isGroup())
        return this.reply("已取消报名", true)
      }

      const models = await this.models()
      const { data } = draft
      data.nickname = this.nickname()

      switch (draft.step) {
        case "sheet": {
          const sheet = resolveSheet(msg, models)
          if (!sheet) return this.reply(`没听清是哪个榜，请回复序号或榜名：\n${sheetChoices(models).join(" / ")}`, true)
          data.sheet = sheet
          draft.step = "gameName"
          this.armJoin()
          return this.reply("请发送你的原神游戏名（表格 C 列，可直接复制游戏内昵称）", true)
        }
        case "gameName": {
          if (!msg) return this.reply("游戏名不能为空，请重新发送", true)
          if (msg.length > 40) return this.reply("游戏名太长了（≤40 字），请重新发送", true)
          data.gameName = msg
          draft.step = "anchor"
          this.armJoin()
          const options = models.get(data.sheet).options.anchor ?? []
          return this.reply(options.length ? optionPrompt("帮帮主播", options) : "请发送帮帮主播名称", true)
        }
        case "anchor": {
          const options = models.get(data.sheet).options.anchor ?? []
          const value = options.length ? matchOption(msg, options) : msg
          if (!value) return this.reply(`没匹配到主播，请回复序号或完整名称：\n${options.join(" / ")}`, true)
          data.anchor = value
          draft.step = "goal"
          this.armJoin()
          const goals = models.get(data.sheet).options.goal ?? []
          return this.reply(goals.length ? optionPrompt("难度及目标", goals) : "请发送难度及目标", true)
        }
        case "goal": {
          const options = models.get(data.sheet).options.goal ?? []
          const value = options.length ? matchOption(msg, options) : msg
          if (!value) return this.reply(`没匹配到难度，请回复序号或完整名称：\n${options.join(" / ")}`, true)
          data.goal = value
          draft.step = "strength"
          this.armJoin()
          const strengths = models.get(data.sheet).options.strength ?? []
          return this.reply(strengths.length ? optionPrompt("账号强度", strengths) : "请发送账号强度", true)
        }
        case "strength": {
          const options = models.get(data.sheet).options.strength ?? []
          const value = options.length ? matchOption(msg, options) : msg
          if (!value) return this.reply(`没匹配到强度，请回复序号或完整名称：\n${options.join(" / ")}`, true)
          data.strength = value
          draft.step = "note"
          this.armJoin()
          return this.reply("请发送备注（没有就回复「无」）", true)
        }
        case "note": {
          data.note = /^(无|没有|跳过|skip)$/i.test(msg) ? "" : msg
          draft.step = "confirm"
          this.armJoin()
          const model = models.get(data.sheet)
          const row = model.rows.find(i => i.nickname === data.nickname)?.row ?? firstEmptyRow(model)
          return this.reply(renderJoinSummary(data.sheet, data, row ?? model.dataStart), true)
        }
        case "confirm": {
          if (!/^(1|y|yes|确认|是|好)$/i.test(msg)) {
            if (/^(0|n|no|取消)$/i.test(msg)) {
              drafts.delete(key)
              this.finish(JOIN_CONTEXT, this.isGroup())
              return this.reply("已取消报名", true)
            }
            return this.reply("请回复 1 确认提交，或回复 0 取消", true)
          }
          drafts.delete(key)
          this.finish(JOIN_CONTEXT, this.isGroup())
          return this.reply(await this.writeJoin(data), true)
        }
        default:
          drafts.delete(key)
          this.finish(JOIN_CONTEXT, this.isGroup())
          return this.reply("会话状态异常，请重新发送 #深渊报名", true)
      }
    })
  }

  /** 一行式：#深渊报名 <榜> <游戏名> <主播> <难度> <强度> [备注] */
  async joinInline() {
    return this.safe(async () => {
      const models = await this.models()
      const args = tokenize(this.e.msg.replace(/^#深渊报名\s+/, ""))
      if (args.length < 5) return this.reply([JOIN_USAGE, "也可以只发 #深渊报名 跟着引导一步步填"].join("\n"), true)

      const sheet = resolveSheet(args[0], models)
      if (!sheet)
        return this.reply(`第一个参数要写榜名，现有：${sheetChoices(models).join("、")}`, true)

      const model = models.get(sheet)
      const [gameName, anchor, goal, strength, ...rest] = args.slice(1)
      const data = {
        sheet,
        nickname: this.nickname(),
        gameName,
        anchor,
        goal,
        strength,
        note: rest.join(" "),
      }

      /* 三个下拉列先归一到选项（唯一命中才算数），避免用户还得手打 "(N5)" 这类后缀 */
      for (const [key, label] of [
        ["anchor", "选择主播"],
        ["goal", "难度及目标"],
        ["strength", "账号强度"],
      ]) {
        const raw = String(data[key] ?? "").trim()
        if (!raw) return this.reply(`${label}不能为空，${JOIN_USAGE}`, true)
        const options = model.options[key] ?? []
        const value = normalizeChoice(raw, options)
        if (options.length && !value) return this.reply(optionNotice(label, raw, options), true)
        data[key] = value
      }

      return this.reply(await this.writeJoin(data), true)
    })
  }

  /** 落地写表 + 记绑定（引导式与一行式共用） */
  async writeJoin(data) {
    const qq = this.e.user_id
    const store = await this.store()
    const defaultStatus = config.sheets?.[data.sheet]?.default_status

    const result = await this.table().mutate(ctx => {
      const model = ctx.model(data.sheet)
      const errors = validateJoin(model, data)
      if (errors.length) throw new ValidationError(`报名信息没通过校验：${errors.join("；")}`)

      const cells = joinCells(model, data, defaultStatus)
      const bind = store.get(data.sheet, qq)
      let row, mode

      if (bind && rowMatches(model, bind.row, bind.nickname)) {
        row = bind.row
        mode = "更新你原有的报名"
      } else {
        const same = findByNickname(model, cells.nickname)
        if (same.length) {
          if (config.join_existing_nickname === "reject")
            throw new ValidationError(
              `表格里已有昵称「${cells.nickname}」的记录（第 ${same[0].row} 行）。那是你的话请让主人清理，否则请改名后重试`,
            )
          row = same[0].row
          mode = "更新表格中同昵称的行"
        } else {
          const empty = firstEmptyRow(model)
          if (!empty) throw new ValidationError(`「${data.sheet}」排队区已满（到第 ${model.dataEnd} 行）`)
          row = empty
          mode = "新增一行"
        }
      }

      for (const [key, value] of Object.entries(cells)) ctx.setCell(data.sheet, row, key, value)
      return { row, mode, cells, seq: row - model.dataStart + 1 }
    })

    store.set(data.sheet, qq, { row: result.row, nickname: result.cells.nickname })
    await store.save()

    return [
      `报名成功（${result.mode}）`,
      "————————————",
      `榜：${data.sheet}`,
      `昵称：${result.cells.nickname}`,
      `游戏名：${result.cells.gameName}`,
      `主播：${result.cells.anchor}`,
      `难度：${result.cells.goal}`,
      `强度：${result.cells.strength}`,
      `备注：${result.cells.note || "无"}`,
      `序号：第 ${result.seq} 位　表格第 ${result.row} 行`,
      "",
      "退队请发送 #深渊退队",
    ].join("\n")
  }
}
