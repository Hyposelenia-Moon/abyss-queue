/** 查询类指令：`#排队`（含本人的排队信息）与单榜队列 */
import { config } from "../components/config.js"
import { ATTACK_VERSION_MESSAGE, attackVersionIndex, attackVersionNotice } from "../components/attack.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { fillEntry } from "../components/fill-entry.js"
import { at as atSegment, notifyGroups, sendToGroups } from "../components/notify-send.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderMenuImg, renderQueueImg } from "../components/render-html.js"
import { cachedRoster, pushRoster } from "../model/roster.js"
import { issueLink, recordLinkTarget } from "../model/editor-links.js"
import { getEditorService } from "../editor/service.js"
import { messageHandlesOf, replaceGroupOutput } from "../modules/group-link.js"
import { compileAliases } from "../components/aliases.js"
import { matchSheetCommand, SHEET_CMD_REGEX } from "../modules/commands.js"
import { atOrAfter, localDayKey } from "../modules/progress.js"
import { readState, TICK_NAME, tickTasks } from "../modules/notify.js"
import { notifyCompletions, notifyOpenSheets, notifyReverts } from "../modules/notify/send.js"
import { exactSelfView, mineView } from "../components/render.js"
import { liveLinesForMenu, liveLookup, notifyAnchorLive, refreshAnchorLiveDetailed, takeAnchorLiveStarted } from "../modules/anchor-live.js"
import { resolveSheet, sheetChoices } from "../modules/router.js"
import { log } from "../components/logger.js"
import { readJson, statePath, writeJson } from "../model/queue-state.js"
import { windowEpoch } from "../model/identity.js"
import { isManagerQq, managerQqs } from "../model/whitelist.js"
import { dmSender, DM_FAILED_TEXT, recordManagerLink } from "../modules/manager-link.js"
import { tidySheets } from "../model/editor-commands.js"
import { runCycle } from "../modules/cycle.js"
import { AppBase } from "../components/base.js"

const aliases = () => compileAliases(config.anchor_aliases)

export class AbyssQueueQuery extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        { reg: SHEET_CMD_REGEX, fnc: "menu" },
      ],
    })
  }
  async init() {
    const groups = notifyGroups()
    const rosterGroup = String(config.roster?.group ?? "").trim()
    const managers = managerQqs()
    const liveOn = Boolean(config.anchor_live?.enable)
    if (groups.length || rosterGroup || managers.length || liveOn) {
      this.task = [
        {
          name: TICK_NAME,
          cron: String(config.notify?.cron ?? "").trim() || "*/3 * * * *",
          fnc: () => this.tick(),
          log: false,
        },
      ]
    } else {
      log(
        "info",
        "[abyss-queue] 定时任务没注册：notify.groups 与 roster.group 都没配、白名单里也没有主人/管理员" +
          "（@ 通知与群名单同步都无事可做）",
      )
    }
    if (config.notify?.enable !== false && !groups.length)
      log(
        "warn",
        "[abyss-queue] 进度通知已开但没配群号：请填 config.yaml 的 notify.groups，" +
          "否则「上一位完成 @ 下一位」「榜开启提醒」与「月末催办」都不会发",
      )
    if (!rosterGroup)
      log("info", "[abyss-queue] 还没配 roster.group（群号）：编辑器里不会有「群昵称候选」，按 QQ 的名单对账也不会跑")
    if (rosterGroup) {
      const kick = setTimeout(
        () =>
          Promise.resolve(pushRoster())
            .then(out => {
              if (!out?.ok && out?.skipped) log("warn", `[abyss-queue] 启动后那次群成员名单同步没做：${out.skipped}`)
            })
            .catch(err => log("warn", `[abyss-queue] 启动后那次群成员名单同步失败：${err?.message ?? err}`)),
        20_000,
      )
      kick.unref?.()
    }
    if (liveOn) {
      const kick = setTimeout(
        () =>
          Promise.resolve()
            .then(async () => {
              const models = [...(await this.models()).values()]
              const result = await refreshAnchorLiveDetailed(models, new Date(), { force: true })
              if (result.failed || result.skipped) {
                log("warn", `[abyss-queue] 启动直播刷新未完成：成功 ${result.refreshed}/${result.total}，失败 ${result.failed}，跳过 ${result.skipped}`)
              }
            })
            .catch(err => log("warn", `[abyss-queue] 启动后那次直播状态刷新失败：${err?.message ?? err}`)),
        5_000,
      )
      kick.unref?.()
    }
  }
  async menu() {
    return this.safe(async () => {
      const msg = this.e.msg.trim()
      const dm = this.dmTarget()
      await this.ensureRosterKnows()
      const link = issueLink(this.e.user_id)
      const now = Date.now()
      if (/^#排队$/.test(msg)) {
        const models = await this.models({ force: true })
        const store = await this.store()
        const rawView = mineView(models, store, this.e.user_id, this.nickname(), {
          aliases: aliases(),
          moreNames: this.nicknames().slice(1),
          liveLookup,
        })
        const view = exactSelfView(rawView, this.nicknames())
        await this.syncIdentity(store, view)
        const choices = sheetChoices(models).map(n => models.get(n))
        const sheets = choices.map(m => m.name)
        this.logSelfHit(dm, view, store)
        const entry = this.entryOf(sheets, view, dm, { now })
        const live = liveLinesForMenu(choices, view.active)
        if (live && entry) entry.head = [live, entry.head].filter(Boolean).join("\n")
        await this.prepareEntry(entry, link, dm)
        const sent = await renderMenuImg(this, this.e, choices, {
          defaultSheet: config.default_sheet,
          version: versionFooter(PLUGIN_NAME),
          mine: view.active,
          entry,
          send: dm?.sender.send,
          onSent: dm ? () => { dm.delivered = true } : res => this.afterGroupOutput(res),
        })
        return this.afterSend(sent, dm, now)
      }
      const { name } = matchSheetCommand(msg) ?? { name: "" }
      const models = await this.models({ force: true })
      const sheet = resolveSheet(name, models)
      if (!sheet) return this.reply(`没找到这个榜，发送 #排队 看总览；现有：${sheetChoices(models).join("、")}`)
      const store = await this.store()
      const model = models.get(sheet)
      const rawView = mineView(models, store, this.e.user_id, this.nickname(), {
        aliases: aliases(),
        moreNames: this.nicknames().slice(1),
        liveLookup,
      })
      const view = exactSelfView(rawView, this.nicknames())
      await this.syncIdentity(store, view)
      const myRow = view.active.find(a => a.sheet === sheet)?.row ?? 0
      this.logSelfHit(dm, view, store)
      const entry = this.entryOf([sheet], view, dm, { now })
      await this.prepareEntry(entry, link, dm)
      const sent = await renderQueueImg(this, this.e, model, {
        limit: config.list_limit,
        myRow,
        own: view.active.find(a => a.sheet === sheet) ?? null,
        entry,
        version: versionFooter(PLUGIN_NAME),
        send: dm?.sender.send,
        onSent: dm ? () => { dm.delivered = true } : res => this.afterGroupOutput(res),
      })
      return this.afterSend(sent, dm, now)
    })
  }
  entryOf(sheets, view, dm, { now = Date.now() } = {}) {
    const resolved = String((view?.active ?? [])[0]?.nickname ?? "").trim()
    const entry = fillEntry(this, sheets, view.active, { manager: Boolean(dm), now, nick: resolved })
    if (!dm) return entry
    const lines = []
    if (view?.missed?.length) {
      const hint = this.missedHint(view)
      if (hint) lines.push(hint)
    }
    if (lines.length) entry.head = [entry.head, ...lines].filter(Boolean).join("\n")
    return entry
  }
  missedHint(view) {
    const nick = this.nickname()
    const names = this.nicknames()
    const shown = names.length ? names : [nick]
    const listText = shown.map(n => `「${n}」`).join(" / ")
    const sheets = [...new Set((view?.missed ?? []).map(m => m.sheet))].filter(Boolean)
    if (!sheets.length) return ""
    return [
      `⚠️ 队列里没找到你：「${listText}」在 ${sheets.join("、")} 里对不上。`,
      `把群名片改成上面这个名字（或让主播帮你改一下那一行），再发一次 #排队 就好。`,
    ].join("\n")
  }
  async ensureRosterKnows() {
    const group = String(config.roster?.group ?? "").trim()
    if (!group) return false
    const qq = String(this.e?.user_id ?? "").trim()
    if (!qq) return false
    const cache = cachedRoster(group)
    if (cache?.members?.some(m => String(m?.qq ?? "").trim() === qq)) return false
    try {
      const pushed = await pushRoster()
      if (pushed?.ok) log("info", `[abyss-queue] #排队 前补推了一次群成员名单（${qq} 不在已有名单里）：${pushed.count} 人`)
      else if (pushed?.skipped) log("warn", `[abyss-queue] #排队 前想补推群成员名单，但没做：${pushed.skipped}`)
      return Boolean(pushed?.ok)
    } catch (err) {
      log("warn", `[abyss-queue] #排队 前补推群成员名单失败（不影响这次回复）：${err?.message ?? err}`)
      return false
    }
  }
  logSelfHit(dm, view, store) {
    if (!dm) return
    const qq = String(dm.qq ?? "").trim()
    const hits = view?.active ?? []
    if (!hits.length) {
      log("info", `[abyss-queue] #排队（私聊档）qq=${qq} 群名片=「${this.nickname()}」⇒ 没认出本人行`)
      return
    }
    const detail = hits
      .map(a => {
        const bind = store?.get?.(a.sheet, qq)
        const via = bind && Number(bind.row) === Number(a.row) ? `绑定（记的昵称「${bind.nickname}」）` : "昵称兜底"
        return `${a.sheet}#${a.row}「${a.nickname}」← ${via}`
      })
      .join("、")
    log("info", `[abyss-queue] #排队（私聊档）qq=${qq} 群名片=「${this.nickname()}」⇒ ${detail}`)
  }
  dmTarget() {
    const qq = String(this.e?.user_id ?? "").trim()
    if (!qq) return null
    if (this.e?.isMaster !== true && !isManagerQq(qq)) return null
    return { qq, sender: dmSender(qq) }
  }
  afterSend(sent, dm, now) {
    if (!dm) return sent
    const delivered = sent || dm.delivered === true
    if (!delivered) {
      log("warn", `[abyss-queue] 私聊发不出填表链接（qq=${dm.qq}）：没加好友 / 框架没有 Bot.pickFriend`)
      return this.reply(DM_FAILED_TEXT)
    }
    if (dm.sender.messageId) {
      recordManagerLink(dm.qq, {
        nick: this.nickname(),
        window: windowEpoch(now),
        messageId: dm.sender.messageId,
        now,
      })
    } else {
      log("warn", `[abyss-queue] 私聊链接发出去了但框架没回消息 id（qq=${dm.qq}）：这一次没记进状态文件`)
    }
    return delivered
  }
  async prepareEntry(entry, link, dm) {
    const full = /点此填表：(https?:\/\/\S+)/.exec(String(entry?.link ?? ""))?.[1] ?? ""
    const mark = String(link?.v ?? "").trim()
    const code = String(link?.code ?? "").trim()
    if (!full || !mark || !code) return entry
    const saved = recordLinkTarget(this.e.user_id, mark, full)
    if (dm || !saved) return entry
    const base = String(config.editor.public_url ?? "").trim().replace(/\/+$/, "")
    if (!base) return entry
    const service = getEditorService()
    if (!service?.linkCode) {
      log("warn", "[abyss-queue] 短进入口不可用，已回退长链接：编辑器没有在进程内挂载")
      return entry
    }
    try {
      const target = await service.linkCode(null, { code })
      if (target?.url !== full) {
        log("warn", "[abyss-queue] 短进入口不可用，已回退长链接：口令没有换回同一条链接")
        return entry
      }
      entry.link = `点此填表：${base}/#code=${code}`
    } catch (error) {
      log("warn", `[abyss-queue] 短进入口不可用，已回退长链接：${error?.message ?? error}`)
    }
    return entry
  }
  async afterGroupOutput(res) {
    if (this.e?.isGroup !== true) return
    const handles = messageHandlesOf(res)
    if (!handles.length) return
    await replaceGroupOutput(this.e, handles)
  }
  async syncIdentity(store, view) {
    const qq = this.e.user_id
    for (const r of view.renames ?? [])
      log(
        "info",
        `[abyss-queue] QQ ${qq} 的群名片与表里昵称不一致：${r.sheet} 第 ${r.row} 行「${r.from}」→「${r.to}」（插件不写表，云端编辑器会自动同步）`,
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
  async tick(now = new Date()) {
    const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
    const models = [...(await this.models()).values()]
    const file = statePath()
    const prev = readState(() => readJson(file))
    const plan = tickTasks({
      prev,
      models,
      now: at,
      cfg: {
        monthlyAt: config.notify?.monthly_at,
        rosterAt: config.roster?.at,
        monthlyEnable: config.notify?.monthly_enable,
      },
    })
    const attackVersion = attackVersionNotice(prev, at)
    const keptAttackVersion = Number(prev?.attackVersion?.index ?? prev?.attackVersion ?? 0)
    if (attackVersion) plan.state.attackVersion = attackVersion.index
    else if (keptAttackVersion) plan.state.attackVersion = keptAttackVersion
    else if (!prev) {
      const current = attackVersionIndex(at)
      if (current) plan.state.attackVersion = current
    }
    const liveDay = localDayKey(at)
    const liveDaily =
      Boolean(config.anchor_live?.enable) && atOrAfter(at, "00:00") && plan.state.daily?.live !== liveDay
    writeJson(file, plan.state)
    if (config.anchor_live?.enable) {
      try {
        const result = await refreshAnchorLiveDetailed(models, at, { force: liveDaily })
        if (result.failed) {
          log("warn", `[abyss-queue] 直播刷新未完成：成功 ${result.refreshed}/${result.total}，失败 ${result.failed}，跳过 ${result.skipped}`)
        }
        if (liveDaily && result.failed === 0 && result.skipped === 0) {
          plan.state.daily.live = liveDay
          writeJson(file, plan.state)
        }
      } catch (err) {
        log("warn", `[abyss-queue] 直播状态刷新失败：${err?.message ?? err}`)
      }
    }
    try {
      await runCycle({ models, now: at, store: await this.store() })
    } catch (err) {
      log("warn", `[abyss-queue] 周期清榜任务失败：${err?.message ?? err}`)
    }
    if (!plan.ready) return log("info", `[abyss-queue] 已记录排队进度基线（${Object.keys(plan.state.rows).length} 行）`)
    const groups = notifyGroups()
    if (plan.roster) {
      const pushed = await pushRoster()
      if (pushed?.ok) {
        plan.state.daily.roster = localDayKey(at)
        writeJson(file, plan.state)
      } else if (pushed?.skipped) {
        log("warn", `[abyss-queue] 群成员名单这次没推：${pushed.skipped}`)
      }
    }
    if (plan.tidy) {
      try {
        const tidied = await tidySheets()
        const store = await this.store()
        let moved = 0
        for (const [sheet, rowMap] of Object.entries(tidied?.shiftRows ?? {}))
          moved += store.remap(sheet, rowMap)
        if (moved) await store.save()
        plan.state.daily.tidy = localDayKey(at)
        writeJson(file, plan.state)
      } catch (err) {
        log("warn", `[abyss-queue] 每日整理失败（下一个 tick 还会再试）：${err?.message ?? err}`)
      }
    }
    if (!groups.length) return
    if (attackVersion) {
      const atAll = atSegment("all")
      await sendToGroups(groups, [atAll, `\n${ATTACK_VERSION_MESSAGE}`])
    }
    await notifyOpenSheets(models, plan.openNow, groups, at)
    await notifyCompletions(models, plan.completions, groups, { store: await this.store() })
    await notifyReverts(models, plan.reverts, groups)
    if (config.anchor_live?.enable) {
      const liveStarted = takeAnchorLiveStarted()
      if (liveStarted.length) {
        try {
          await notifyAnchorLive(liveStarted, models, { groups, store: await this.store() })
        } catch (err) {
          log("warn", `[abyss-queue] 开播提醒发送失败：${err?.message ?? err}`)
        }
      }
    }
  }
}
