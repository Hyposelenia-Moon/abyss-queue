/**
 * 三路深渊排队 —— Yunzai 插件入口
 *
 * 数据源是一份人工维护的本地 xlsx 排表（三个工作表 = 三个榜）。
 * 本文件只做「Yunzai 胶水」：命令匹配、上下文流程、消息回复；
 * 表格解析与业务规则都在 lib/ 下，且不依赖 Yunzai，可独立测试。
 */
import { config, configHint } from "./lib/config.js"
import { Table } from "./lib/table.js"
import { BindStore } from "./lib/store.js"
import {
  findByNickname,
  firstEmptyRow,
  joinCells,
  matchOption,
  rowMatches,
  validateJoin,
} from "./lib/queue.js"
import { renderAnchors, renderJoinSummary, renderMenu, renderQueue } from "./lib/render.js"

/** 榜名（顺序即引导菜单顺序） */
const SHEETS = ["幻想真境剧诗", "幽境危战", "深境螺旋"]
const JOIN_CONTEXT = "joinStep"
const CLEAR_CONTEXT = "clearStep"

/** 引导式报名的草稿：key = self_id:user_id */
const drafts = new Map()

const log = (level, ...args) => {
  if (typeof logger !== "undefined" && logger?.[level]) logger[level](...args)
  else console.log(...args)
}

/** 用户输入问题（预期内的失败）：直接回复原因，不当成程序异常 */
class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = "ValidationError"
  }
}

/** 支持 「带空格的内容」/"..." 的单行参数切分 */
function tokenize(text) {
  const out = []
  const re = /「([^」]*)」|"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4])
  return out
}

const sheetChoices = models => {
  const known = SHEETS.filter(n => models.has(n))
  return known.length ? known : [...models.keys()]
}

/** 把用户输入解析成表名：完整名 / 序号 / 唯一的包含匹配 */
function resolveSheet(input, models) {
  const text = String(input ?? "").trim()
  if (!text) return null
  const choices = sheetChoices(models)
  if (models.has(text)) return text
  const idx = Number(text)
  if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) return choices[idx - 1]
  const hit = choices.filter(n => n.includes(text) || text.includes(n))
  return hit.length === 1 ? hit[0] : null
}

const optionPrompt = (label, options) =>
  [`请选择${label}（回复序号或内容）：`, ...options.map((o, i) => `${i + 1}. ${o}`)].join("\n")

/** 未匹配到下拉选项时的提示：只列出与输入相关的候选，避免刷屏 */
function optionNotice(label, input, options) {
  const text = String(input ?? "").trim()
  const related = text ? options.filter(o => o.includes(text) || text.includes(o)) : []
  const shown = related.length ? related : options
  return [
    related.length > 1 ? `${label}「${text}」对应多个选项，请回复序号：` : `${label}「${text}」不在下拉选项中，可选：`,
    ...shown.map(o => `· ${o}`),
    "回复序号或完整内容（多个候选时必须回复序号）",
  ].join("\n")
}

/** 把输入归一到下拉选项：唯一命中才采用；未命中或歧义返回 null */
function normalizeChoice(input, options) {
  if (!options?.length) return String(input ?? "").trim()
  return matchOption(input, options)
}

/** 表格 / 绑定 实例（单例，保证写操作共用同一把互斥锁） */
let TABLE = null
let STORE = null
const getTable = () => {
  if (!config.xlsxPath) throw new Error(configHint())
  return (TABLE ??= new Table({ file: config.xlsxPath, backup: config.backup }))
}
const getStore = () => (STORE ??= new BindStore(config.storePath).load())

export class AbyssQueue extends plugin {
  constructor() {
    super({
      name: "三路深渊排队",
      dsc: "读写本地 xlsx 排表：查队列 / 报名 / 退队 / 改备注",
      event: "message",
      priority: 4000,
      rule: [
        { reg: "^#(三路深渊|深渊帮助|深渊菜单)$", fnc: "menu" },
        { reg: "^#深渊报名\\s*$", fnc: "joinGuide", permission: config.permission.join },
        { reg: "^#深渊报名\\s+\\S[\\s\\S]*$", fnc: "joinInline", permission: config.permission.join },
        { reg: "^#深渊退队(\\s+\\S+)?$", fnc: "leave", permission: config.permission.leave },
        { reg: "^#深渊改备注\\s*\\S[\\s\\S]*$", fnc: "setNote", permission: config.permission.note },
        { reg: "^#深渊我的$", fnc: "mine" },
        { reg: "^#深渊主播(\\s+\\S+)?$", fnc: "anchors" },
        { reg: "^#深渊清空(\\s+\\S+)?$", fnc: "clearAsk", permission: config.permission.clear },
        { reg: `^#(${SHEETS.join("|")})(排队|列表)?(\\s+全部)?$`, fnc: "showSheet" },
      ],
    })

    /** 定时推送（默认关闭，cron 与群号来自配置） */
    if (config.push.enable && config.push.groups.length)
      this.task = [
        { name: "深渊排队推送", cron: config.push.cron, fnc: () => this.pushQueue(), log: false },
      ]
  }

  /* ------------------------------ 工具 ------------------------------ */

  draftKey() {
    return `${this.e.self_id}:${this.e.user_id}`
  }

  nickname() {
    return String(this.e.sender?.card || this.e.sender?.nickname || this.e.user_id)
  }

  isGroup() {
    return Boolean(this.e.isGroup)
  }

  async models() {
    return getTable().read(({ models }) => models)
  }

  /** 统一异常出口：出错不让机器人静默 */
  async safe(fn) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ValidationError) {
        log("mark", `[abyss-queue] ${err.message}`)
        return this.reply(err.message)
      }
      log("error", `[abyss-queue] ${err?.stack || err}`)
      return this.reply(`出错了：${err.message}`)
    }
  }

  armJoin() {
    this.setContext(JOIN_CONTEXT, this.isGroup(), config.context_timeout)
  }

  /* ------------------------------ 查询 ------------------------------ */

  async menu() {
    return this.safe(async () => {
      const models = await this.models()
      return this.reply(
        renderMenu(sheetChoices(models).map(n => models.get(n)), { defaultSheet: config.default_sheet }),
        true,
      )
    })
  }

  async showSheet() {
    return this.safe(async () => {
      const m = /^#(\S+?)(?:排队|列表)?(?:\s+(全部))?$/.exec(this.e.msg.trim())
      const models = await this.models()
      const sheet = resolveSheet(m?.[1], models)
      if (!sheet) return this.reply(`没找到这个榜，现有：${sheetChoices(models).join("、")}`)

      const store = await getStore()
      const bind = store.get(sheet, this.e.user_id)
      const model = models.get(sheet)
      const myRow = bind && rowMatches(model, bind.row, bind.nickname) ? bind.row : 0
      const limit = m?.[2] ? 0 : config.list_limit
      return this.reply(renderQueue(model, { limit, myRow }), true)
    })
  }

  async anchors() {
    return this.safe(async () => {
      const arg = /^#深渊主播(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
      const models = await this.models()
      const sheet = resolveSheet(arg, models) ?? resolveSheet(config.default_sheet, models)
      if (!sheet) return this.reply(`没找到这个榜，现有：${sheetChoices(models).join("、")}`)
      return this.reply(renderAnchors(models.get(sheet)), true)
    })
  }

  async mine() {
    return this.safe(async () => {
      const store = await getStore()
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

  /* ------------------------------ 报名 ------------------------------ */

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
      if (args.length < 5)
        return this.reply(
          [
            "用法：#深渊报名 <榜> <游戏名> <主播> <难度> <强度> [备注]",
            "也可以只发 #深渊报名 跟着引导一步步填",
          ].join("\n"),
          true,
        )

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
        if (!raw) return this.reply(`${label}不能为空，用法：#深渊报名 <榜> <游戏名> <主播> <难度> <强度> [备注]`, true)
        const options = model.options[key] ?? []
        const value = normalizeChoice(raw, options)
        if (options.length && !value) return this.reply(optionNotice(label, raw, options), true)
        data[key] = value
      }

      return this.reply(await this.writeJoin(data), true)
    })
  }

  /** 落地写表 + 记绑定 */
  async writeJoin(data) {
    const qq = this.e.user_id
    const store = await getStore()
    const defaultStatus = config.sheets?.[data.sheet]?.default_status

    const result = await getTable().mutate(ctx => {
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

  /* ------------------------------ 退队 / 改备注 ------------------------------ */

  async leave() {
    return this.safe(async () => {
      const qq = this.e.user_id
      const store = await getStore()
      const bound = store.sheetsOf(qq)
      if (!bound.length) return this.reply("你还没有报名记录，发送 #深渊报名 加入排队", true)

      const arg = /^#深渊退队(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
      const models = await this.models()
      let sheet = resolveSheet(arg, models)
      if (!sheet) {
        if (bound.length === 1) sheet = bound[0]
        else if (bound.includes(config.default_sheet)) sheet = config.default_sheet
        else
          return this.reply(
            `你在多个榜都有报名，请指定：#深渊退队 <榜>\n现有：${sheetChoices(models).join("、")}`,
            true,
          )
      }
      if (!bound.includes(sheet)) return this.reply(`你在「${sheet}」没有报名记录`, true)

      const bind = store.get(sheet, qq)
      const model = models.get(sheet)
      if (!model || !rowMatches(model, bind.row, bind.nickname)) {
        store.del(sheet, qq)
        await store.save()
        return this.reply(`表格第 ${bind.row} 行已不是你的记录（可能被人工修改过），已解除绑定。如仍需排队请重新 #深渊报名`, true)
      }

      const { row } = await getTable().mutate(ctx => {
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
      const store = await getStore()
      const text = this.e.msg.replace(/^#深渊改备注\s*/, "").trim()
      if (!text) return this.reply("用法：#深渊改备注 <内容>", true)
      if (text.length > 120) return this.reply("备注太长了（≤120 字）", true)

      const bound = store.sheetsOf(qq)
      if (!bound.length) return this.reply("你还没有报名记录，发送 #深渊报名 加入排队", true)

      const models = await this.models()
      const sheet = bound.includes(config.default_sheet) ? config.default_sheet : bound[0]
      const bind = store.get(sheet, qq)
      const model = models.get(sheet)
      if (!model || !rowMatches(model, bind.row, bind.nickname)) {
        store.del(sheet, qq)
        await store.save()
        return this.reply(`表格第 ${bind.row} 行已不是你的记录，已解除绑定。如仍需排队请重新 #深渊报名`, true)
      }

      await getTable().mutate(ctx => {
        const fresh = ctx.model(sheet)
        if (!rowMatches(fresh, bind.row, bind.nickname)) throw new Error("表格刚刚被改动，请重试")
        ctx.setCell(sheet, bind.row, "note", text)
      })
      return this.reply(`已更新「${sheet}」第 ${bind.row} 行的备注：${text}`, true)
    })
  }

  /* ------------------------------ 主人清空 ------------------------------ */

  async clearAsk() {
    return this.safe(async () => {
      const arg = /^#深渊清空(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
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

      const cleared = await getTable().mutate(ctx => {
        const model = ctx.model(sheet)
        const rows = model.rows.map(i => i.row)
        for (const row of rows) ctx.clearRow(sheet, row)
        return rows.length
      })
      return this.reply(`已清空「${sheet}」${cleared} 行`, true)
    })
  }

  /* ------------------------------ 定时推送 ------------------------------ */

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
