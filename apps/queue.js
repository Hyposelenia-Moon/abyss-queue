/**
 * 查询类指令：菜单 / 单榜队列 / 主播列表
 *
 * `#我的` 已并入 `#排队`：发 `#排队` 时按发送者定位账号，一并发出发送者本人的排队信息。
 * 这里同时承载定时任务：队列推送、完成情况轮询（上一位完成就 @ 下一位）、月末催办。
 */
import fs from "node:fs"
import path from "node:path"
import { config, pluginRoot } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME, SHEET_ALIASES_KEYS, SHEETS } from "../components/constants.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderAnchorsImg, renderMenuImg, renderQueueImg } from "../components/render-html.js"
import { canonicalAnchor, compileAliases } from "../lib/aliases.js"
import { detectCompletions, isLastDayOfMonth, nextPending, pendingBySheet, snapshot } from "../lib/progress.js"
import { anchorDetailView, mineView, renderAnchorDetail, renderQueue } from "../lib/render.js"
import { resolveSheet, sheetChoices } from "../lib/router.js"
import { AppBase, log } from "./_base.js"

/** 主播别名（配置里登记的其它写法） */
const aliases = () => compileAliases(config.anchor_aliases)

/** 通知发给哪些群：优先 notify.groups，留空则跟随定时推送的群 */
const notifyGroups = () => {
  const list = config.notify?.groups?.length ? config.notify.groups : config.push.groups
  return [...new Set((list ?? []).map(Number).filter(Boolean))]
}

const statePath = () => {
  const file = config.notify?.state_file || "data/progress.json"
  return path.isAbsolute(file) ? file : path.join(pluginRoot, file)
}
/** 月末催办的"今天发过了"标记，与进度快照放同一个目录 */
const monthlyPath = () => path.join(path.dirname(statePath()), "monthly.json")

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const writeJson = (file, data) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
  } catch (err) {
    log("error", `[abyss-queue] 写状态文件失败 ${file}：${err.message}`)
  }
}

/** @ 一个人；拿不到 segment（测试环境）时退化成纯文本 */
const at = qq => (typeof segment !== "undefined" && segment?.at ? segment.at(Number(qq)) : `@${qq} `)

/**
 * 把一个名字变成消息片段数组：能对上 QQ 就 @ 他（后面再括上昵称，避免客户端不显示 @ 对象）
 *
 * 消息必须按片段数组发，不能把 @ 对象拼进字符串——那样只会发出 "[object Object]"。
 */
const mentionParts = (nickname, dir) => {
  const name = String(nickname).trim()
  const qq = dir.get(name)
  return qq ? [at(qq), `（${name}）`] : [name]
}

/** 多行片段拼成一条消息（行间换行） */
const joinLines = lines => {
  const msg = []
  for (const line of lines) {
    if (msg.length) msg.push("\n")
    msg.push(...line)
  }
  return msg
}

/**
 * 群成员名单：群名片 / 昵称 → QQ
 *
 * 表里只有群昵称，要 @ 人就得把它映射回 QQ，只能靠群成员名单。
 * 对不上的名字（改了名片、不在群里）就只发文字，不 @。
 */
async function memberDirectory(gid) {
  const dir = new Map()
  try {
    const group = Bot.pickGroup(Number(gid))
    const map = typeof group.getMemberMap === "function" ? group.getMemberMap() : null
    const list = map ? [...map.values()] : ((await group.getMemberList?.()) ?? [])
    for (const m of list) {
      const qq = String(m?.user_id ?? m?.qq ?? "")
      if (!qq) continue
      for (const name of [m?.card, m?.nickname]) {
        const key = String(name ?? "").trim()
        if (key && !dir.has(key)) dir.set(key, qq)
      }
    }
  } catch (err) {
    log("error", `[abyss-queue] 取群 ${gid} 成员名单失败：${err.message}`)
  }
  return dir
}

async function sendToGroups(groups, msg) {
  for (const gid of groups) {
    try {
      await Bot.pickGroup(gid).sendMsg(msg)
    } catch (err) {
      log("error", `[abyss-queue] 发往群 ${gid} 失败：${err.message}`)
    }
  }
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
        { reg: "^#主播(\\s+\\S+)?$", fnc: "anchors" },
      ],
    })
  }

  /** 定时任务：队列推送 / 完成情况轮询 / 月末催办（都按配置注册） */
  async init() {
    const tasks = []
    if (config.push.enable && config.push.groups.length)
      tasks.push({ name: "深渊排队推送", cron: config.push.cron, fnc: () => this.pushQueue(), log: false })

    if (config.notify?.enable && notifyGroups().length) {
      tasks.push({
        name: "排队完成情况轮询",
        cron: config.notify.progress_cron || "*/3 * * * *",
        fnc: () => this.watchProgress(),
        log: false,
      })
      if (config.notify.monthly_enable !== false)
        tasks.push({
          name: "月末排队催办",
          cron: config.notify.monthly_cron || "0 12 * * *",
          fnc: () => this.monthlyRemind(),
          log: false,
        })
    }

    if (tasks.length) this.task = tasks
  }

  /**
   * #排队 的统一入口
   *   - `#排队`                → 三榜总览菜单 + **发送者本人的排队信息**（在表里就跟着发）
   *                              + 带口令的编辑器链接
   *   - `#排队 <榜> [全部]`     → 该榜队列（榜名支持全名/简称/序号），图内带本人那一行
   *   - `#<榜>排队`（如 #危战排队）→ 同上，保留这套习惯写法的兼容
   */
  /**
   * 按 QQ 定位账号之后要做的事（见 lib/queue.js 的 locateSelf）：
   *   - 首次按昵称认出来 → 记下 QQ 绑定，以后按 QQ 认人
   *   - 绑定失效（那一行没了或已属于别人）→ 删掉
   *   - 名片与表里昵称不一致 → 只记日志：表由腾讯文档 / 云端编辑器维护，插件一个字也不写
   * 这些都不该影响查询本身：出错只记日志。
   */
  async syncIdentity(store, view) {
    const qq = this.e.user_id

    /** 表是只读的：名片改了就改名片，表里那份要人去腾讯文档里同步 */
    for (const r of view.renames ?? [])
      log(
        "info",
        `[abyss-queue] QQ ${qq} 的群名片与表里昵称不一致：${r.sheet} 第 ${r.row} 行「${r.from}」→「${r.to}」（插件不写表，请到腾讯文档里改）`,
      )

    let dirty = false
    for (const b of view.binds ?? []) {
      store.set(b.sheet, qq, { row: b.row, nickname: b.nickname })
      dirty = true
    }
    for (const d of view.drops ?? []) {
      if (store.del(d.sheet, qq)) dirty = true
    }
    if (dirty) {
      try {
        await store.save()
      } catch (err) {
        log("error", `[abyss-queue] 保存绑定失败：${err.message}`)
      }
    }
  }

  async menu() {
    return this.safe(async () => {
      const msg = this.e.msg.trim()
      if (/^#排队$/.test(msg)) {
        const models = await this.models()

        /** 按 QQ 定位账号（昵称兜底），顺手把改名 / 绑定落实 */
        const store = await this.store()
        const view = mineView(models, store, this.e.user_id, this.nickname(), { aliases: aliases() })
        await this.syncIdentity(store, view)

        /** 一张图：榜单总览 + 本人的排队信息（常用指令在页脚） */
        const choices = sheetChoices(models).map(n => models.get(n))
        return renderMenuImg(this, this.e, choices, {
          defaultSheet: config.default_sheet,
          version: versionFooter(PLUGIN_NAME),
          mine: view.active,
        })
      }

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
      /** 它同时也把改名 / 绑定落实了，单榜查询用同一套口径 */
      const view = mineView(models, store, this.e.user_id, this.nickname(), { aliases: aliases() })
      await this.syncIdentity(store, view)
      const myRow = view.active.find(a => a.sheet === sheet)?.row ?? 0
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

        const detail = anchorDetailView([...models.values()], canonicalAnchor(arg, aliases()))
        if (!detail) return this.reply(`没找到「${arg}」这个榜或主播。榜：${sheetChoices(models).join("、")}`, true)
        return this.reply(renderAnchorDetail(detail), true)
      }

      return renderAnchorsImg(this, this.e, sheetChoices(models).map(n => models.get(n)))
    })
  }

  async pushQueue() {
    const models = await this.models()
    const sheets = config.push.sheets?.length ? config.push.sheets : sheetChoices(models)
    const text = sheets
      .map(n => models.get(n))
      .filter(Boolean)
      .map(model => renderQueue(model, { limit: config.push.limit }))
      .join("\n\n")

    return sendToGroups(config.push.groups.map(Number), `【三路深渊排队】\n${text}`)
  }

  /**
   * 轮询「帮帮完成情况」：谁刚刚完成了，就 @ 他后面第一个还在排队的人
   *
   * 状态快照存在 data/progress.json：只有「上次没完成 → 这次完成了」才算一次通知，
   * 因此重启、重复轮询都不会重复 @。首次运行只记基线，不发消息。
   */
  async watchProgress() {
    const models = await this.models()
    const next = snapshot([...models.values()])
    const file = statePath()
    const state = readJson(file)
    const prev = state?.rows ?? {}
    /** 先落盘再发送：发送失败也不至于重复 @ */
    writeJson(file, { rows: next, at: Date.now() })

    if (!state) return log("info", `[abyss-queue] 已记录排队进度基线（${Object.keys(next).length} 行）`)

    const done = detectCompletions(prev, next)
    const groups = notifyGroups()
    if (!done.length || !groups.length) return

    for (const gid of groups) {
      const dir = await memberDirectory(gid)
      const lines = []
      for (const item of done) {
        const model = models.get(item.sheet)
        const following = model ? nextPending(model, item.row) : null
        if (!following) continue
        lines.push([
          `【${item.sheet}】第 ${item.seq} 位「${item.nickname}」已完成 → 下一位 `,
          ...mentionParts(following.nickname, dir),
          `（第 ${following.seq ?? following.row} 位）请准备`,
        ])
      }
      if (lines.length) await sendToGroups([gid], joinLines(lines))
    }
  }

  /**
   * 每月最后一天：把还在排队的人 @ 一遍催进度
   *
   * cron 是每天跑一次，真正的判断在这里（月末就是"明天是 1 号"），
   * 免得依赖具体 cron 方言的 L 写法。同一天只发一次。
   */
  async monthlyRemind() {
    if (!isLastDayOfMonth(new Date())) return
    const file = monthlyPath()
    const today = new Date().toISOString().slice(0, 10)
    const sent = readJson(file)
    if (sent?.date === today) return

    const models = await this.models()
    const pending = pendingBySheet([...models.values()])
    const groups = notifyGroups()
    if (!pending.length || !groups.length) return
    writeJson(file, { date: today, at: Date.now() })

    for (const gid of groups) {
      const dir = await memberDirectory(gid)
      const lines = pending.map(p => {
        const parts = [`【${p.sheet}】还有 ${p.rows.length} 人：`]
        p.rows.forEach((r, i) => {
          if (i) parts.push("、")
          parts.push(...mentionParts(r.nickname, dir))
        })
        return parts
      })
      await sendToGroups(
        [gid],
        joinLines([["【三路深渊排队】本月最后一天了，还没轮到的记得盯一下进度："], ...lines]),
      )
    }
  }
}
