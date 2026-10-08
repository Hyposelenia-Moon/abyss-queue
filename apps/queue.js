/**
 * 查询类指令：`#排队`（含本人的排队信息）与单榜队列
 *
 * 发 `#排队` 时按发送者定位账号，一并发出发送者本人的排队信息（本人信息不另设指令）。
 * 这里同时承载**唯一一条定时任务**（`notify.cron` → `tick()`）：
 * 完成情况轮询、榜开启提醒、月末催办、群成员名单同步都在那一条里按内部时间判断做。
 * 编排逻辑在 modules/notify.js（纯函数，可独立测试），这里只负责取表、@ 人、发消息。
 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { fillEntry } from "../components/fill-entry.js"
import { notifyGroups } from "../components/notify-send.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderMenuImg, renderQueueImg } from "../components/render-html.js"
import { pushRoster } from "../model/roster.js"
import { compileAliases } from "../components/aliases.js"
import { allCommand, matchSheetCommand, SHEET_CMD_REGEX } from "../modules/commands.js"
import { localDayKey } from "../modules/progress.js"
import { readState, TICK_NAME, tickTasks } from "../modules/notify.js"
import { notifyCompletions, notifyMonthly, notifyOpenSheets } from "../modules/notify/send.js"
import { mineView } from "../components/render.js"
import { resolveSheet, sheetChoices } from "../modules/router.js"
import { log } from "../components/logger.js"
import { readJson, statePath, writeJson } from "../model/queue-state.js"
import { getRemote } from "../model/remote.js"
import { windowEpoch } from "../model/identity.js"
import { isManagerQq, managerQqs } from "../model/whitelist.js"
import { dmSender, DM_FAILED_TEXT, recordManagerLink } from "../modules/manager-link.js"
import { tidySheets } from "../model/tidy.js"
import { AppBase } from "../components/base.js"

/** 主播别名（配置里登记的其它写法） */
const aliases = () => compileAliases(config.anchor_aliases)

export class AbyssQueueQuery extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        /**
         * 唯一入口：#排队 看总览，#排队 <榜> [全部] 看单榜。
         * 正则来自 modules/commands.js（与处理器解析、分页提示同一份定义），
         * 涵盖全名 / 简称 / 序号写法与后缀式写法（#危战排队 / #螺旋列表）。
         * 刻意不接收裸榜名（#幽境危战 / #深渊 等），那些归 Axiu-Plugin 等（优先级更低）所有。
         */
        { reg: SHEET_CMD_REGEX, fnc: "menu" },
      ],
    })
  }

  /**
   * 定时任务：**只注册一条**统一 tick（`notify.cron`，默认每 3 分钟）
   *
   * 五件事（完成轮询 / 榜开启提醒 / 月末催办 / 名单同步 / 每日整理）
   * 全在那一条里按内部时间判断做，见 modules/notify.js 的 `tickTasks` 与本文件的 `tick`。
   * 一条任务的好处：周期与去重口径只有一份，"当时到底跑没跑"看这一个任务的执行记录就够。
   * 管理员的私聊链接**不在这一条里**：它只在本人发 `#排队` 时给一次（见 `menu()` 与
   * modules/manager-link.js），tick 不主动重发。
   *
   * 没有任何时间点可做时**不注册**（免得挂一条每 3 分钟空跑的任务）：
   * 通知群号为空（含 `notify.enable = false`）→ 三件 @ 通知都不发；`roster.group` 没配 →
   * 名单同步与每日整理（两件都不发给群、共用 `roster.at` 这个时刻）也不做。
   * `#排队` 那一次**不受影响**——它按当时的名单直接私聊发（见 `menu()`）。
   */
  async init() {
    const groups = notifyGroups()
    const rosterGroup = String(config.roster?.group ?? "").trim()
    const managers = managerQqs()

    if (groups.length || rosterGroup || managers.length) {
      this.task = [
        {
          name: TICK_NAME,
          /** 唯一的时间源；留空回落到 3 分钟一次 */
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

    /**
     * 通知开着却没配群号就提示一句：这些 @ 通知完全靠群号，不配就不会跑（免得以为是功能没生效）。
     * `notify.enable = false` 是"明确关掉"，不提示。
     */
    if (config.notify?.enable !== false && !groups.length)
      log(
        "warn",
        "[abyss-queue] 进度通知已开但没配群号：请填 config.yaml 的 notify.groups，" +
          "否则「上一位完成 @ 下一位」「榜开启提醒」与「月末催办」都不会发",
      )
    if (!rosterGroup)
      log("info", "[abyss-queue] 还没配 roster.group（群号）：编辑器里不会有「群昵称候选」，按 QQ 的名单对账也不会跑")

    /**
     * 群成员名单：配了群号就先推一次（等机器人连上），之后每天到 roster.at 由 tick 推
     *
     * 推给在线编辑器当「群昵称候选」，并让编辑器按 QQ 对账（改名同步、退群删行）。
     * 这次 kick 不吃"当天已推"的标记：它是给"机器人刚起来、名单还没同步"准备的，
     * 与每天那次各管各的（重复推一份名单在编辑器侧是幂等的）。
     */
    if (rosterGroup) {
      /** 这次 kick 的结果也要留痕：跳过（没配编辑器地址等）与失败都不该静默 */
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

    /**
     * 编辑器随机器人启动（单机部署：机器人 + 编辑器同一台）
     *
     * 插件加载后过几秒探一次编辑器（`/healthz`），没起来就按 `remote.autostart` 拉起来——
     * 这样单机部署不用再给编辑器单独注册 Windows 服务（`remote.autostart` 留空则什么都不做，
     * 编辑器单独部署的形态照样成立）。
     */
    if (config.remote?.autostart) {
      const kick = setTimeout(() => {
        getRemote()
          .ensureEditor({ waitMs: 8000 })
          .then(up => up && log("info", "[abyss-queue] 编辑器没在跑，已按 remote.autostart 拉起"))
          .catch(err => log("warn", `[abyss-queue] 拉起编辑器失败：${err?.message ?? err}`))
      }, 5_000)
      kick.unref?.()
    }
  }

  /**
   * `#排队` 的统一入口
   *   - `#排队`                → 三榜总览菜单 + **发送者本人的排队信息**（在表里就跟着发）
   *                              + 带口令的编辑器链接
   *   - `#排队 <榜> [全部]`     → 该榜队列（榜名支持全名/简称/序号），图内带本人那一行
   *   - `#<榜>排队`（如 #危战排队）→ 同上，后缀式写法与 `#排队 <榜>` 等价
   *
   * **投递方式按身份分**（本阶段新增）：发送者是主人 / 白名单管理员时，这一条回复**私聊发给他本人**、
   * 群里一个字都不发——管理链接一旦落在群里，谁先点谁认领（见 modules/manager-link.js）。
   * 普通群友照旧群内发，行为一字未变。
   */
  async menu() {
    return this.safe(async () => {
      const msg = this.e.msg.trim()
      /**
       * 私聊那一档：身份判据只有一条 `dm`（null = 照旧群内发）。
       * `now` 只算一次：它既决定链接里的时间窗，也决定状态文件里记的那个窗口——两者必须是同一个。
       */
      const dm = this.dmTarget()
      const now = Date.now()
      if (/^#排队$/.test(msg)) {
        const models = await this.models()

        /** 按 QQ 定位账号（昵称兜底），顺手把改名 / 绑定落实 */
        const store = await this.store()
        const view = mineView(models, store, this.e.user_id, this.nickname(), { aliases: aliases() })
        await this.syncIdentity(store, view)

        /**
         * 一张图 + 跟着的填写情况与填报入口，合起来**只发一条消息**：
         * 还有榜没排就点名缺哪些、哪些已完成，三个榜都排过就只给入口——
         * 让他随时能回去改已填的那一行。
         */
        const choices = sheetChoices(models).map(n => models.get(n))
        const sheets = choices.map(m => m.name)
        const sent = await renderMenuImg(this, this.e, choices, {
          defaultSheet: config.default_sheet,
          version: versionFooter(PLUGIN_NAME),
          mine: view.active,
          entry: fillEntry(this, sheets, view.active, { manager: Boolean(dm), now }),
          send: dm?.sender.send,
        })
        return this.afterSend(sent, dm, now)
      }

      /** 单榜写法由 modules/commands.js 解析（与注册规则、分页提示同一份定义） */
      const { name, all } = matchSheetCommand(msg) ?? { name: "", all: false }
      /**
       * 空榜名两种来源：
       *   - `#排队 全部`：对默认榜取全量（榜名为空但 all=true）
       *   - 其余解析不出榜名的情况按「没找到这个榜」处理
       */
      const models = await this.models()
      const arg = name
      const sheet = resolveSheet(arg, models) ?? (all ? resolveSheet(config.default_sheet, models) : null)
      if (!sheet) return this.reply(`没找到这个榜，发送 #排队 看总览；现有：${sheetChoices(models).join("、")}`)

      const store = await this.store()
      const model = models.get(sheet)
      /** 它同时也把改名 / 绑定落实了，单榜查询用同一套口径 */
      const view = mineView(models, store, this.e.user_id, this.nickname(), { aliases: aliases() })
      await this.syncIdentity(store, view)
      const myRow = view.active.find(a => a.sheet === sheet)?.row ?? 0
      /** 单榜也一样：这个榜里有他也照样附填报入口（已完成 / 未填 照同一口径写） */
      const sent = await renderQueueImg(this, this.e, model, {
        limit: all ? 0 : config.list_limit,
        myRow,
        /** 分页提示用 allCommand 生成，保证是注册规则真能命中的写法 */
        moreHint: allCommand(sheet),
        entry: fillEntry(this, [sheet], view.active, { manager: Boolean(dm), now }),
        /** 规范署名行：三张图口径一致（见 AGENTS.md §3.5） */
        version: versionFooter(PLUGIN_NAME),
        send: dm?.sender.send,
      })
      return this.afterSend(sent, dm, now)
    })
  }

  /**
   * 这次要不要**私聊发**：发送者是主人或白名单管理员
   *
   * 两条都算主人：框架的 master（`e.isMaster`，`#排队初始化` 认的就是它）与白名单文件里的 `owner`
   * （编辑器认的是它）。宁可按"是自己人"多发一条私聊，也不能把管理链接丢进群里。
   * 名单本身每次现读（`model/whitelist.js`），改了不用重启。
   *
   * @returns {{qq: string, sender: {send: Function, messageId: string}}|null} null = 照旧群内发
   */
  dmTarget() {
    const qq = String(this.e?.user_id ?? "").trim()
    if (!qq) return null
    if (this.e?.isMaster !== true && !isManagerQq(qq)) return null
    return { qq, sender: dmSender(qq) }
  }

  /**
   * 发完之后收尾：私聊那一档记下"发给了谁 / 哪个窗口 / 消息 id"，私发失败在群里说一句
   *
   * 记录只在**真的发出去了**（拿到了消息 id）时才写：没发出去却记下来，等于把这次失败
   * 记成"链接已经在路上"，事后对不上账。
   * 发出去但拿不到消息 id（个别适配器不回）只记一条 warn——那一份链接没进记录，
   * 不记的话这个缺口没人看得出来。
   * 私发失败时给的提示**不带链接**——失败了也不能把管理链接退回群里。
   * @param {boolean} sent 这一条回复发出去了吗（`renderOrFallback` 的返回值）
   */
  afterSend(sent, dm, now) {
    if (!dm) return sent
    if (!sent) {
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
    return sent
  }

  /**
   * 按 QQ 定位账号之后要做的事（见 modules/queue.js 的 locateSelf）：
   *   - 首次按昵称认出来 → 记下 QQ 绑定，以后按 QQ 认人
   *   - 绑定失效（那一行没了或已属于别人）→ 删掉
   *   - 名片与表里昵称不一致 → 只记日志：表由云端编辑器维护，插件一个字也不写
   * 这些都不该影响查询本身：出错只记日志。
   */
  async syncIdentity(store, view) {
    const qq = this.e.user_id

    /**
     * 表是只读的：插件只记一条日志。
     * 真正的同步由云端编辑器做——本人打开编辑器时按群名片同步，机器人每天的群名单核对也会兜一遍。
     */
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

  /**
   * 唯一那条定时任务的入口：一次 tick 把五件事按内部时间判断做完
   *
   * 顺序是**先算、后写、再发**：
   *   1. `tickTasks` 一次性算出新状态与"这一轮要发什么"（纯函数）
   *   2. 状态先落盘（含进度快照、每榜开启标记、当天已做的标记）
   *   3. 再逐条发消息
   *
   * 先落盘的意义：发送失败也不会在下一轮重复发。反过来（先发后写）只要写盘失败一次，
   * 就会对着整榜的人重复 @。代价是"发失败就这一次没了"，这在群里是更可接受的一侧。
   *
   * 管理员的私聊链接**不在这里发**：它只在本人发 `#排队` 时给一次（见 `menu()` 与
   * modules/manager-link.js），5 分钟时间窗过期即失效，等下次 `#排队` 再给新的。
   *
   * @param {Date} [now] 判定时刻；默认当前时间。**只在回归套件里注入**——
   *   月末催办与"每天几点"这类判断按真实日历没法在一秒内跑完
   */
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
    /** 唯一的写盘点：五件事的去重标记一起落盘 */
    writeJson(file, plan.state)
    if (!plan.ready) return log("info", `[abyss-queue] 已记录排队进度基线（${Object.keys(plan.state.rows).length} 行）`)

    const groups = notifyGroups()

    /**
     * 4. 群成员名单同步 + 5. 每日整理：这两件**都不发给群**，所以不受 `notify.groups` 影响
     * （口径见 components/notify-send.js：关掉通知不连带停掉名单同步），因此排在"没配群就返回"之前。
     *
     * 两件的标记都在**成功之后**才写：失败（网络抖动 / 编辑器没起来）时下一次 tick 还能补，
     * 若按"到点就记"会把当天的补做机会也吃掉。各自比上面三件多写一次状态文件，
     * 但一天只发生在一次成功之后，代价可以忽略。
     */
    if (plan.roster) {
      const pushed = await pushRoster()
      if (pushed?.ok) {
        plan.state.daily.roster = localDayKey(at)
        writeJson(file, plan.state)
      } else if (pushed?.skipped) {
        /**
         * "跳过"（没配群号 / 没配编辑器地址 / 签不出机器人身份）原来**一个字都不记**：
         * 现场表现就是"名单到底推没推"在日志里查不出来（维护者正是这么找上门的）。
         * 抛错那条由 `pushRoster` 自己记 warn，这里只补跳过这一支，不重复刷。
         */
        log("warn", `[abyss-queue] 群成员名单这次没推：${pushed.skipped}`)
      }
    }
    /**
     * 5. 每日整理（已完成前移 / 排队中后移，「等待开启」当挡位不动）：与名单同步同一个时刻（`roster.at`）。
     * 编辑器侧**已经是有序的就不写表**（不重新保存、不产生历史版本），所以天天跑也不留垃圾版本。
     */
    if (plan.tidy) {
      try {
        await tidySheets()
        plan.state.daily.tidy = localDayKey(at)
        writeJson(file, plan.state)
      } catch (err) {
        log("warn", `[abyss-queue] 每日整理失败（下一个 tick 还会再试）：${err?.message ?? err}`)
      }
    }

    if (!groups.length) return

    /** 2. 榜开启提醒：先把"榜开了"发出去（用开启前的排队人数），再处理这一轮的状态变化 */
    await notifyOpenSheets(models, plan.openNow, groups)
    /** 1. 完成情况轮询：上一位完成 → @ 下一位（@ 谁优先按这一行的绑定反查，见 components/notify-send.js） */
    await notifyCompletions(models, plan.completions, groups, { store: await this.store() })
    /** 3. 月末催办 */
    if (plan.monthly) await notifyMonthly(plan.monthly, groups)
  }
}
