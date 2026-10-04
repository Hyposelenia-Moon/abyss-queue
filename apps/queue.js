/**
 * 查询类指令：菜单 / 单榜队列 / 主播列表
 *
 * `#我的` 已并入 `#排队`：发 `#排队` 时按发送者定位账号，一并发出发送者本人的排队信息。
 * 这里同时承载**唯一一条定时任务**（`notify.cron` → `tick()`）：
 * 完成情况轮询、榜开启提醒、月末催办、群成员名单同步都在那一条里按内部时间判断做。
 * 编排逻辑在 lib/notify.js（纯函数，可独立测试），这里只负责取表、@ 人、发消息。
 */
import fs from "node:fs"
import path from "node:path"
import { config, confineDataPath, pluginRoot } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { runInitCommand } from "../components/init.js"
import { allCommand, matchSheetCommand, SHEET_CMD_REGEX } from "../lib/commands.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderAnchorsImg, renderMenuImg, renderQueueImg } from "../components/render-html.js"
import { editorUrl, signTicket, SHORT_PATH } from "../lib/identity.js"
import { listMembers, pushRoster } from "../components/roster.js"
import { canonicalAnchor, compileAliases } from "../lib/aliases.js"
import { isDone, localDayKey, nextPending } from "../lib/progress.js"
import { queuedInSheet, readState, TICK_NAME, tickTasks } from "../lib/notify.js"
import { anchorDetailView, mineView, renderAnchorDetail } from "../lib/render.js"
import { resolveSheet, sheetChoices } from "../lib/router.js"
import { getRemote } from "../model/index.js"
import { AppBase, log } from "./_base.js"

/** 主播别名（配置里登记的其它写法） */
const aliases = () => compileAliases(config.anchor_aliases)

/** 填报入口上的那四个字（点它就是链接） */
const FILL_LINK_TEXT = "点此填表"

/**
 * 「点此填表」这一段
 *
 * 要求是"文字本身就是短链，点文字跳浏览器"，QQ 里能做到这点的只有 **markdown 段**：
 * 卡片（json / xml / 小程序）会被 QQ 当成第三方客户端发的卡片挡掉（提示「发送者版本过低」），
 * share 段 NapCat 根本不认（未知段会直接抛错，整条消息都发不出去），纯文本又挂不了超链接。
 *
 * 本机链路：TRSS 的 OneBotv11 适配器把段原样透传 → NapCat 映射成 markdownElement（见
 * `napcat.mjs` 的 `ob11ToRawConverters[markdown]`）。QQ 不认时发送会报错，
 * 调用方会把这一段换成纯文本「点此填表：<地址>」，图与填写情况照发。
 *
 * @param url 带身份签名的编辑器地址
 */
const linkSegment = url => ({ type: "markdown", data: { content: `[${FILL_LINK_TEXT}](${url})` } })

/**
 * 填报入口：**每次都附**，和图一起发（同一条消息）
 *
 * 第一行是填写情况：
 *   未填：<榜名…>；已完成：<榜名…>
 * 「未填」只列还没有自己那一行的榜；「已完成」列已经处理过的榜——主播打完的（表里是主播名）
 * 和自己点过完成的（表里落成了群昵称）都算；还在排队中的榜两边都不提。
 * 三个榜都填过就只有入口——让他随时能回去改已填的那一行（已填的内容也能改，自由度更高）。
 *
 * 第二段是填报入口：群里发的是**短链**（`<编辑器地址>/s/<16 字符码>`），链接字面就是「点此填表」（可选，见 linkSegment）。
 * 码是不透明的（QQ 经置换 + MAC，见 `signTicket`），编辑器验过之后才换成带 `k=` 与身份签名的完整地址，
 * 群名片由编辑器按 QQ 从群名单里自己取——所以码短、链接短，权限口径与长链接完全一样：
 * 编辑器验签后只让他改自己那一行。
 *
 * 地址 / 口令 / 签名密钥三者缺一，链接就是"打开也没用"的空壳，这种时候**只写「暂无链接」**。
 *
 * @param ctx 插件实例（取发送者的 QQ）
 * @param sheets 这一轮要看的榜名（#排队 是三个榜，单榜命令就一个）
 * @param active mineView().active（本人名下的行）
 * @returns {{head: string, seg: object|null, link: string}}
 *          head 填写情况那一行；seg「点此填表」那一段（签不出地址 / 关掉 markdown 时为 null）；link 纯文本兜底
 */
function fillEntry(ctx, sheets, active) {
  const base = String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
  const token = String(config.remote?.token ?? "").trim()
  const signKey = String(config.remote?.sign_key ?? "").trim()
  const url =
    base && token && signKey
      ? editorUrl(base, { token, signKey, qq: ctx.e.user_id, nick: ctx.nickname() })
      : ""
  const own = name => active.find(a => a.sheet === name)
  const missing = sheets.filter(name => !own(name))
  const done = sheets.filter(name => isDone(own(name)?.status))
  const head = [missing.length ? `未填：${missing.join("、")}` : "", done.length ? `已完成：${done.join("、")}` : ""]
    .filter(Boolean)
    .join("；")
  if (!url) return { head, seg: null, link: "暂无链接" }
  /**
   * 短链：云端 / 本机编辑器都要是**带这个路由的版本**；编辑器还没更新时把 remote.short_link
   * 改成 false 就退回原来那条长链接。
   */
  const code = config.remote?.short_link === false ? "" : signTicket({ qq: ctx.e.user_id }, signKey)
  const shown = code ? `${base}/${SHORT_PATH}/${code}` : url
  return {
    head,
    seg: config.remote?.link_markdown === true ? linkSegment(shown) : null,
    link: `${FILL_LINK_TEXT}：${shown}`,
  }
}

/**
 * 通知发给哪些群：优先 notify.groups，留空则回落到**旧的** `push.groups`
 *
 * 定时推送功能已经删掉了（见 README），`push.groups` 留下来只为兼容老配置里已经写好的群号——
 * **它现在只当通知群号的回退来源，不再有任何推送行为**。新部署请直接写 notify.groups。
 */
const notifyGroups = () => {
  const list = config.notify?.groups?.length ? config.notify.groups : config.push?.groups
  return [...new Set((list ?? []).map(Number).filter(Boolean))]
}

/**
 * 定时任务的状态文件落点
 *
 * 配置里能改（`notify.state_file`），但**不许离开插件目录**：这里每次取用时过一遍
 * `confineDataPath`，出圈就记 error 并回落到 `data/progress.json`。
 * 在取用处判（而不是只用 loadConfig 算出的那份）是为了让套件在运行中改配置照样生效。
 *
 * 这一个文件里装着四件事的去重状态（进度快照 / 每榜开启标记 / 当天已做的标记），
 * 口径见 lib/notify.js 的文件头。
 */
const statePath = () => {
  const file = config.notify?.state_file || "data/progress.json"
  const abs = path.isAbsolute(file) ? file : path.join(pluginRoot, file)
  return confineDataPath("notify.state_file", abs, "data/progress.json")
}

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
 * 取成员走 `listMembers()`：真实框架给的是"以 QQ 为键的普通对象"，直接 `[...map.values()]` 会炸。
 */
async function memberDirectory(gid) {
  const dir = new Map()
  try {
    const group = Bot.pickGroup(Number(gid))
    const list = await listMembers(group)
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
         * 主人专用的一次性初始化（#排队初始化）：把本机编辑器那套手工初始化按顺序做完，
         * 任何一步出错立刻停并汇报（见 components/init.js）。
         *
         * `permission: "master"` 是框架自己的主人判定（loader.js 的 filtPermission：
         * 非主人直接回「暂无权限，只有主人才能操作」，压根不进 handler）；
         * handler 里再判一次 `e.isMaster` 是第二道闸——两道都留着，别删其中任何一道。
         * 放在 #排队 那条规则**前面**：虽然 SHEET_CMD_REGEX 匹配不到这条消息（它后面必须跟空白），
         * 但顺序在前更不容易被以后的正则放宽悄悄抢走。
         */
        { reg: "^#排队初始化$", fnc: "queueInit", permission: "master", log: true },
        /**
         * 唯一入口：#排队 看总览，#排队 <榜> [全部] 看单榜。
         * 正则来自 lib/commands.js（与处理器解析、分页提示同一份定义），
         * 涵盖全名 / 简称 / 序号写法与历史后缀写法（#危战排队 / #螺旋列表）。
         * 刻意不接收裸榜名（#幽境危战 / #深渊 等），那些归 Axiu-Plugin 等（优先级更低）所有。
         */
        { reg: SHEET_CMD_REGEX, fnc: "menu" },
        { reg: "^#主播(\\s+\\S+)?$", fnc: "anchors" },
      ],
    })
  }

  /**
   * 定时任务：**只注册一条**统一 tick（`notify.cron`，默认每 3 分钟）
   *
   * 四件事（完成轮询 / 榜开启提醒 / 月末催办 / 名单同步）全在那一条里按内部时间判断做，
   * 见 lib/notify.js 的 `tickTasks` 与本文件的 `tick`。
   * 一条任务的好处：周期与去重口径只有一份，"当时到底哪条跑没跑"不再需要人肉对账。
   *
   * 没有任何时间点可做时**不注册**（免得挂一条每 3 分钟空跑的任务）：
   * 通知群号没配（或 notify.enable = false）→ 三件 @ 通知都不发；roster.group 没配 → 名单同步也不做。
   */
  async init() {
    const groups = notifyGroups()
    const rosterGroup = String(config.roster?.group ?? "").trim()
    const wantNotify = config.notify?.enable !== false && groups.length > 0

    if (wantNotify || rosterGroup) {
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
        "[abyss-queue] 定时任务没注册：notify.groups 与 roster.group 都没配（@ 通知与群名单同步都靠群号）",
      )
    }

    /**
     * 群号没配就提示一句：这些 @ 通知完全靠群号，不配就不会跑（免得以为是功能没生效）
     */
    if (config.notify?.enable !== false && !groups.length)
      log(
        "warn",
        "[abyss-queue] 进度通知已开但没配群号：请填 config.yaml 的 notify.groups" +
          "（老配置里的 push.groups 也认，但它现在只是通知群号的兼容回退、不再有推送功能），" +
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
      const kick = setTimeout(() => pushRoster(), 20_000)
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
          .then(up => up && log("mark", "[abyss-queue] 编辑器没在跑，已按 remote.autostart 拉起"))
          .catch(err => log("warn", `[abyss-queue] 拉起编辑器失败：${err?.message ?? err}`))
      }, 5_000)
      kick.unref?.()
    }
  }

  /**
   * #排队初始化 —— 主人专用的一次性初始化（逻辑在 components/init.js）
   *
   * 为什么按 QQ 而不是昵称写白名单：权限只认稳定身份（AGENTS.md 九-1），昵称随时能改。
   * 为什么逻辑不写在这里：初始化要读文件、要注册计划任务、要探活，放在 lib/components 里
   * 才能用注入的桩跑回归（`initDeps` 就是这个注入点，见 test/init.test.mjs）。
   * 非主人由 `runInitCommand` 挡掉：**不读配置、不建目录、一个字都不写**。
   */
  async queueInit() {
    return this.safe(() => runInitCommand(this.e, { reply: text => this.reply(text), ...(this.initDeps ?? {}) }))
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

  async menu() {
    return this.safe(async () => {
      const msg = this.e.msg.trim()
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
          entry: fillEntry(this, sheets, view.active),
        })
        return sent
      }

      /** 单榜写法由 lib/commands.js 解析（与注册规则、分页提示同一份定义） */
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
        entry: fillEntry(this, [sheet], view.active),
      })
      return sent
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

  /**
   * 唯一那条定时任务的入口：一次 tick 把四件事按内部时间判断做完
   *
   * 顺序是**先算、后写、再发**：
   *   1. `tickTasks` 一次性算出新状态与"这一轮要发什么"（纯函数）
   *   2. 状态先落盘（含进度快照、每榜开启标记、当天已做的标记）
   *   3. 再逐条发消息
   *
   * 先落盘的意义：发送失败也不会在下一轮重复发。反过来（先发后写）只要写盘失败一次，
   * 就会对着整榜的人重复 @。代价是"发失败就这一次没了"，这在群里是更可接受的一侧。
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
    /** 唯一的写盘点：四件事的去重标记一起落盘 */
    writeJson(file, plan.state)
    if (!plan.ready) return log("info", `[abyss-queue] 已记录排队进度基线（${Object.keys(plan.state.rows).length} 行）`)

    const groups = notifyGroups()
    if (!groups.length) return

    /** 2. 榜开启提醒：先把"榜开了"发出去（用开启前的排队人数），再处理这一轮的状态变化 */
    await this.notifyOpenSheets(models, plan.openNow, groups)
    /** 1. 完成情况轮询：上一位完成 → @ 下一位 */
    await this.notifyCompletions(models, plan.completions, groups)
    /** 3. 月末催办 */
    if (plan.monthly) await this.notifyMonthly(plan.monthly, groups)
    /**
     * 4. 群成员名单同步（不发给群，推给云端编辑器）
     *
     * 标记在**推成功之后**才写：推失败（网络抖动 / 编辑器没起来）时下一次 tick 还能补，
     * 若按"到点就记"会把当天的补做机会也吃掉。这一步比上面三件多写一次状态文件，
     * 但一天只发生在一次成功的推送之后，代价可以忽略。
     */
    if (plan.roster) {
      const pushed = await pushRoster()
      if (pushed?.ok) {
        plan.state.daily.roster = localDayKey(at)
        writeJson(file, plan.state)
      }
    }
  }

  /**
   * 榜开启提醒：某个榜翻到「已开启」时，把该榜还在排队的人 @ 一遍
   *
   * @param {Array<object>} models 当前各榜模型（取"排队中"的人）
   * @param {string[]} sheets 这一轮刚翻到已开启的榜（`tickTasks` 判的 false→true）
   * @param {number[]} groups 发到哪些群
   */
  async notifyOpenSheets(models, sheets, groups) {
    if (!sheets.length) return
    for (const name of sheets) {
      const model = models.find(m => m.name === name)
      const queue = model ? queuedInSheet(model) : []
      /** 开了但还没人排队：不 @ 人也不刷屏，只记一条日志（真到有人时会有"上一位完成 @ 下一位"接上） */
      if (!queue.length) {
        log("info", `[abyss-queue]「${name}」已开启，但还没有人排队，不提醒`)
        continue
      }
      for (const gid of groups) {
        const dir = await memberDirectory(gid)
        const lines = queue.map((r, i) => {
          const parts = [i ? "、" : ""]
          parts.push(...mentionParts(r.nickname, dir))
          return parts
        })
        await sendToGroups(
          [gid],
          joinLines([
            [`【${name}】开榜了！还在排队的有 ${queue.length} 人（下面这些还没轮到，请留意自己的顺序）：`],
            lines,
          ]),
        )
      }
      log("mark", `[abyss-queue] 已提醒「${name}」开榜（${queue.length} 人还在排队）`)
    }
  }

  /**
   * 完成情况轮询：谁刚刚完成了，就 @ 他后面第一个还在排队的人
   *
   * @param {Array<object>} models 当前各榜模型
   * @param {Array<{sheet,row,seq,nickname}>} done 这一轮「上次没完成 → 这次完成了」的人
   * @param {number[]} groups 发到哪些群
   */
  async notifyCompletions(models, done, groups) {
    if (!done.length) return
    for (const gid of groups) {
      const dir = await memberDirectory(gid)
      const lines = []
      for (const item of done) {
        const model = models.find(m => m.name === item.sheet)
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
   * 月末催办：每月最后一天（到 `notify.monthly_at` 之后）把还在排队的人 @ 一遍
   *
   * "是不是月末""今天发过没有"都在 `tickTasks` 里判完了：这里只负责把内容发出去，
   * 所以不依赖 cron 方言的 L 写法，也不怕重启。
   *
   * @param {{sheets: Array<{sheet, rows}>, day: string}} plan 要发的内容
   * @param {number[]} groups 发到哪些群
   */
  async notifyMonthly(plan, groups) {
    for (const gid of groups) {
      const dir = await memberDirectory(gid)
      const lines = plan.sheets.map(p => {
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
