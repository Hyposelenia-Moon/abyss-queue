/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行，
   若在本文件里 setenv，config.js 早就按仓库 config.yaml 读完了（会动到真实表格） */
import { ensureEnv } from "./env.mjs"
/**
 * 工作流回归：在「假 Yunzai」里加载插件本体，用桩事件驱动真实 handler
 *
 * 聊天端只剩查询类指令（插件对表只读，填表在云端编辑器里做）：
 *   #排队 / #主播
 * 因此这里：
 *   - 用桩实现 Yunzai 注入的全局（plugin / logger / segment / Bot，见 _helper.mjs）
 *   - 用桩复刻 loader 的规则匹配与上下文分发
 *   - 真实调用插件的 menu / anchors / tick（唯一的定时任务入口）
 *   - 写表部分直接用 model 层（只为把数据摆成测试要的样子，插件自己不会写）
 * 全程只操作表格副本。
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createChecker, exampleConfig, installFrameworkStubs, requireSource } from "./_helper.mjs"
import { DEFAULT_CONFIG } from "../components/config.js"
import { TICK_NAME } from "../modules/notify.js"
import { firstEmptyRow } from "../modules/queue.js"
import { isPending } from "../modules/progress.js"
import { decodeLinkNick, verifyTicket } from "../model/identity.js"

const SOURCE = await requireSource()
const { check, finish } = createChecker("工作流回归")

const ENV = await ensureEnv({
  prefix: "abyss-queue-e2e-",
  extra: {
    /** 通知群：唯一那条定时任务（进度 @ / 开启提醒 / 月末催办）都发到这里 */
    notify: { enable: true, groups: [20000] },
    /** 别名：让 #主播 阿修 也能查到 阿修Axiu */
    anchor_aliases: { 阿修Axiu: ["阿修"] },
  },
})
const fixture = ENV.fixture
await fs.copyFile(SOURCE, fixture)
const sha256 = buf => createHash("sha256").update(buf).digest("hex")
const sourceHash = sha256(await fs.readFile(SOURCE))

/** 进度快照与月末标记写到临时目录，别动仓库的 data/（`ensureEnv` 已按环境变量指好） */
const { config } = await import("../components/config.js")

/* ------------------------- 桩：Yunzai 环境 ------------------------- */

/** 群昵称 → QQ：通知里 @ 人靠它，内容可在用例里随时补 */
const MEMBERS = {}
const sent = installFrameworkStubs({ members: MEMBERS })

/* 经插件根 index.js 的 apps 导出装载入口类——与框架 loader 的取法一致
   （loader 只认 index.js，见 lib/plugins/loader.js:58-62 与 :130） */
const { apps } = await import("../index.js")
const APPS = Object.values(apps).filter(c => typeof c === "function")
const { Table } = await import("../model/table.js")

/* ------------------------- 桩：loader 分发 ------------------------- */

const makeEvent = (msg, { user_id = "10001", card = "测试用户", isGroup = true, isMaster = false } = {}) => ({
  msg,
  user_id,
  self_id: "10000",
  group_id: "20000",
  isGroup,
  /** 框架的主人判定（`#排队初始化` / `#排队同步名单` 那两条闸都看它） */
  isMaster,
  sender: { card, nickname: card },
})

/** 复刻 loader：非 RegExp 的 reg 会被编译成正则 */
const rulesOf = app => (app.rule ?? []).map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))

/** 模拟一条普通消息：按 priority 顺序匹配，命中第一个规则即执行 */
const say = async (msg, opts = {}) => {
  const e = makeEvent(msg, opts)
  const appsArr = APPS.map(C => Object.assign(new C(), { e, __replies: [] }))
  for (const inst of appsArr.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
    const hit = rulesOf(inst).find(r => r.reg.test(msg))
    if (!hit) continue
    await inst[hit.fnc]()
    return { fnc: hit.fnc, replies: inst.__replies, inst }
  }
  return { fnc: null, replies: appsArr[0].__replies, inst: appsArr[0] }
}

/** 规则表里是否存在能命中该消息的规则（用于确认插件不接管的指令确实不被拦截） */
const matches = msg => APPS.some(C => rulesOf(Object.assign(new C(), {})).some(r => r.reg.test(msg)))

const last = r => String(r.replies.at(-1) ?? "")
/** 一条回复转成可读文本：图片段记成 [图片]、markdown 段按 markdown 原文，其余原样（图与入口是同一条消息里的片段数组） */
const msgText = msg =>
  Array.isArray(msg)
    ? msg
        .map(p =>
          typeof p === "string"
            ? p
            : p?.type === "image"
              ? "[图片]"
              : p?.type === "markdown"
                ? String(p.data?.content ?? "")
                : String(p),
        )
        .join("")
    : String(msg)
/** 一次指令发出的所有消息（每条一段） */
const replyText = r => r.replies.map(msgText).join("\n")
/** 这次回复里有没有图片段 */
const hasImage = r => r.replies.some(m => Array.isArray(m) && m.some(p => p?.type === "image"))
const partsOf = r => r.replies.flatMap(m => (Array.isArray(m) ? m : [m]))
/** 「点此填表」那一段（markdown）的原文 */
const linkMd = r => partsOf(r).find(p => p?.type === "markdown")?.data?.content ?? ""
/**
 * 链接文字指向的地址：从 markdown 的 `[点此填表](http…)` 里取；
 * 没有那一段（发不出去 / 关掉 markdown）时退回纯文本里的「点此填表：<地址>」
 */
const linkUrl = r => {
  const md = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(linkMd(r))
  if (md) return md[2]
  return /点此填表：(http\S+)/.exec(replyText(r))?.[1] ?? ""
}
/** 断言"只发了一条消息"，并把它取出来（图与入口合并的判据） */
const singleMsg = r => {
  assert.equal(r.replies.length, 1, `应当只发一条消息：${JSON.stringify(r.replies.map(msgText))}`)
  return r.replies[0]
}
/**
 * 短链的样子：`<编辑器地址>/s/<码>?t=<签发分钟>&ts=<签名>&n=<群昵称>`
 * （码 = 16 个 base64url 字符的不透明短码；编辑器地址可能带子路径如 /queue；
 * `?t&ts&n` 三段是机器人签的**签发时刻 + 发送者群昵称**，见 `model/identity.js` 的 `signFreshness`）
 */
const SHORT_LINK_RE = /^http:\/\/127\.0\.0\.1:\d+\/\S*\/s\/[A-Za-z0-9_-]{16}(?:\?t=\d+&ts=[A-Za-z0-9_-]+(?:&n=[A-Za-z0-9_-]+)?)?$/
const readModel = async sheet => {
  const table = new Table({ file: fixture, backup: false })
  return table.read(({ models }) => models.get(sheet))
}
const readRows = async sheet => (await readModel(sheet)).rows

/** 基线人数：源表格是用户随时在用的真实数据，不写死人数，只断言「相对基线」的变化 */
const baseCount = {}
for (const sheet of ["幻想真境剧诗", "幽境危战", "深境螺旋"]) baseCount[sheet] = (await readRows(sheet)).length
/**
 * 基线**排队中人数**（菜单那一列的口径，2026-10 维护者反馈后从「排队人数」改名）：
 * 只数还没打完的人（`isPending`：写着「排队中」或完成情况空着）；已完成 / 等待开启都不算。
 */
const baseQueuing = {}
for (const sheet of ["幻想真境剧诗", "幽境危战", "深境螺旋"])
  baseQueuing[sheet] = (await readRows(sheet)).filter(r => isPending(r.status)).length
/** 新的数据行 = 幽境危战当前的首个空行（用户补过行时会顺延） */
const BASE = await readModel("幽境危战")
const EMPTY = firstEmptyRow(BASE)
/** 基线昵称也从被测表里推：取表里第一个排队的人（写死成某个昵称会在换表时误报） */
const FIRST_NICK = BASE.rows[0]?.nickname ?? ""
/**
 * 主播区的基线：第一位主播的名字与总数
 *
 * 同样从被测表里推 —— 合成样本与真实表是两批数据（样本由 `test/fixtures/sample-table.mjs` 生成），
 * 写死「阿修Axiu / 6 位」的话，换成样本就会误报。
 */
const BASE_ANCHORS = BASE.anchors.map(a => a.name)
const FIRST_ANCHOR = BASE_ANCHORS[0] ?? ""

console.log(`源表格：${SOURCE}\n测试副本：${fixture}\n`)

/* ------------------------------ 用例 ------------------------------ */

console.log("【1】规则分发（只剩查询类指令）")
{
  check("注册的规则数已精简到 7 条（查询 2 条 + #插队 1 条 + 主人专用的 初始化 / 同步名单 / 更新 / 强制更新）", () => {
    const n = APPS.reduce((sum, C) => sum + (new C().rule ?? []).length, 0)
    assert.equal(n, 7, `实际 ${n} 条`)
  })

  const r = await say("#排队")
  check("#排队 命中 menu", () => assert.equal(r.fnc, "menu"))
  const menuCall = sent.renderCalls.at(-1)
  check("菜单走图片渲染（模板与数据正确）", () => {
    assert.equal(menuCall?.plugin, "abyss-queue")
    assert.equal(menuCall?.tpl, "queue/menu")
    assert.equal(menuCall?.data.sheets.length, 3)
    assert.equal(menuCall?.data.sheets.find(s => s.name === "幽境危战")?.count, baseQueuing["幽境危战"])
    assert.ok(menuCall?.data.version.includes("三路深渊排队"), menuCall?.data.version)
  })
  check("菜单回复为图片占位（未走文本回退）", () => {
    assert.ok(hasImage(r), replyText(r))
  })
  check("菜单里没有编辑器地址（插件不含编辑器）", () => {
    assert.equal(menuCall?.data.editorUrl, undefined)
    assert.ok(!replyText(r).includes("编辑器"), replyText(r))
  })
  check("定时任务：只注册唯一一条统一 tick，其余按频率注册的任务都没了", () => {
    const app = APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "menu"))
    const inst = Object.assign(new app(), { e: makeEvent("#x"), __replies: [] })
    /** init() 是同步的：任务表当场就位（框架注册 cron 时读的就是它） */
    inst.init()
    const names = (inst.task ?? []).map(t => t.name)
    assert.equal(inst.task?.length ?? 0, 1, `应当只有一条定时任务：${names.join(",")}`)
    assert.equal(names[0], TICK_NAME)
    for (const gone of ["深渊排队推送", "排队完成情况轮询", "月末排队催办", "群成员名单同步"])
      assert.ok(!names.includes(gone), `仍然注册着「${gone}」：${names.join(",")}`)
    assert.equal(inst.task[0].cron, config.notify.cron)
    for (const t of inst.task) assert.ok(/^[\d*/,\- ]+$/.test(t.cron), `cron 不合法：${t.cron}`)
  })
  check("定时推送功能已删除：连 handler 都不在了", () => {
    const app = APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "menu"))
    assert.equal(typeof new app().pushQueue, "undefined", "pushQueue 应当随定时推送一起删掉")
  })
  check("通知群号只有一个来源：默认配置里没有 push 这一节，只剩 notify.groups", () => {
    assert.equal(DEFAULT_CONFIG.push, undefined, `push 应当整节删掉：${JSON.stringify(DEFAULT_CONFIG.push)}`)
    assert.deepEqual(DEFAULT_CONFIG.notify.groups, [], JSON.stringify(DEFAULT_CONFIG.notify.groups))
  })

  const r2 = await say("#排队 危战")
  check("#排队 危战 命中 menu（单榜）", () => assert.equal(r2.fnc, "menu"))
  const queueCall = sent.renderCalls.at(-1)
  check("队列走图片渲染（模板与数据正确）", () => {
    assert.equal(queueCall?.tpl, "queue/queue")
    assert.equal(queueCall?.data.name, "幽境危战")
    assert.equal(queueCall?.data.total, baseQueuing["幽境危战"], "「共 N 人排队中」= 还没打完的人（与菜单同一口径）")
    assert.equal(queueCall?.data.rows[0].seq, "1")
    /** 表里第一位排队的人（不写死昵称：真实表与合成样本是两批数据） */
    assert.equal(queueCall?.data.rows[0].nickname, FIRST_NICK)
  })

  const r3 = await say("#主播 危战")
  check("#主播 危战 只列该榜主播（图片）", () => {
    assert.equal(r3.fnc, "anchors")
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.tpl, "queue/anchors")
    assert.equal(call?.data.anchors[0].name, FIRST_ANCHOR)
    assert.equal(call?.data.total, BASE_ANCHORS.length)
  })
  const rAll = await say("#主播")
  check("#主播 合并三个榜（去重后少于原始行数）", () => {
    assert.equal(rAll.fnc, "anchors")
    const call = sent.renderCalls.at(-1)
    const names = call?.data.anchors.map(a => a.name) ?? []
    assert.ok(names.length > 0, "没有主播")
    assert.equal(new Set(names).size, names.length, "合并后有重复主播")
    /** 专职与入口都是数组（模板里一项一行），入口项里不该再留「/」分隔符 */
    for (const a of call.data.anchors) {
      assert.ok(Array.isArray(a.duty), `${a.name} 专职应为数组`)
      assert.ok(Array.isArray(a.entry), `${a.name} 入口应为数组`)
      for (const en of a.entry) assert.ok(!/[、]/.test(en) && !/ \/ /.test(en), `${a.name} 入口未拆开：${en}`)
    }
  })
  const rName = await say(`#主播 ${FIRST_ANCHOR}`)
  check("#主播 <名字> 文本输出该主播信息", () => {
    assert.equal(rName.fnc, "anchors")
    const text = last(rName)
    assert.ok(text.includes(FIRST_ANCHOR), text)
    assert.ok(text.includes("专职："), text)
    assert.ok(text.includes("直播入口"), text)
    assert.ok(!text.includes("[图片]"), text)
  })
  const rNobody = await say("#主播 查无此主播")
  check("#主播 <不认识的名字> 给出提示", () => {
    assert.equal(rNobody.fnc, "anchors")
    assert.ok(last(rNobody).includes("没找到"), last(rNobody))
  })
  const rAlias = await say("#主播 阿修")
  check("#主播 <别名>：阿修 也能查到正名", () => {
    assert.equal(rAlias.fnc, "anchors")
    const text = last(rAlias)
    assert.ok(text.includes(FIRST_ANCHOR), text)
    assert.ok(!text.includes("没找到"), text)
  })

  check("渲染请求带上出图分辨率倍数（render_scale）", () => {
    assert.equal(queueCall?.cfg?.scale, DEFAULT_CONFIG.render_scale)
    /** 缺省值与示例配置一致，部署照抄模板即可拿到高清图 */
    assert.ok(Number(exampleConfig.render_scale) > 1, `示例配置的 render_scale 应为高清：${exampleConfig.render_scale}`)
  })

  await check("单榜指令能查到对应榜（#排队 <榜> 与前缀式、后缀式写法）", async () => {
    for (const [cmd, sheet] of [
      ["#排队 危战", "幽境危战"],
      ["#排队 剧诗", "幻想真境剧诗"],
      ["#排队 深渊", "深境螺旋"],
      ["#排队 幽境危战", "幽境危战"],
      ["#排队 幻想真境剧诗", "幻想真境剧诗"],
      ["#排队 3", "深境螺旋"],
      ["#排队 剧诗 全部", "幻想真境剧诗"],
      /** 后缀式：与前缀式等价 */
      ["#危战排队", "幽境危战"],
      ["#剧诗排队", "幻想真境剧诗"],
      ["#深渊排队", "深境螺旋"],
      ["#螺旋列表", "深境螺旋"],
    ]) {
      /** 用独立 QQ：本人那一行按群昵称匹配，与后面的写入用例共用 QQ 会串到同一行 */
      const res = await say(cmd, { user_id: "90001", card: "只读查询" })
      assert.equal(res.fnc, "menu", `${cmd} 应命中 menu`)
      assert.equal(sent.renderCalls.at(-1)?.data.name, sheet, `${cmd} 应打开 ${sheet}`)
    }
  })

  check("裸榜名不归本插件接管（避免与 Axiu-Plugin 抢命令）", () => {
    for (const cmd of ["#幽境危战", "#幻想真境剧诗", "#深境螺旋", "#深渊", "#危战", "#剧诗"])
      assert.equal(matches(cmd), false, `${cmd} 不应命中任何本插件规则`)
  })

  check("这几个指令不被本插件的任何规则拦截", () => {
    for (const cmd of [
      "#报名",
      "#报名 幽境危战 甲 阿修Axiu 无畏(N5) 低配",
      "#退队",
      "#改备注 备注内容",
      /** #我的 的内容归 #排队 */
      "#我的",
      "#深渊报名",
      "#深渊退队",
      "#深渊我的",
      "#深渊主播",
    ])
      assert.equal(matches(cmd), false, `${cmd} 应已移除`)
  })
}

console.log("\n【2】摆数据（测试侧直接写副本）→ 查询生效")
{
  const NICK = "编辑器样本"
  const table = new Table({ file: fixture, backup: false })

  await table.mutate(ctx => {
    const model = ctx.model("幽境危战")
    assert.equal(firstEmptyRow(model), EMPTY, `空行应为第 ${EMPTY} 行`)
    for (const [k, v] of Object.entries({
      nickname: NICK,
      gameName: "样本游戏名",
      anchor: "阿修Axiu",
      goal: "无畏(N5)",
      strength: "低配",
      note: "编辑器写入",
    }))
      ctx.setCell("幽境危战", EMPTY, k, v)
  })

  const rows = await readRows("幽境危战")
  check("写入后行数 +1", () => assert.equal(rows.length, baseCount["幽境危战"] + 1))
  check("写入内容正确", () => {
    const row = rows.find(i => i.row === EMPTY)
    assert.ok(row, `第 ${EMPTY} 行没有数据`)
    assert.equal(row.nickname, NICK)
    assert.equal(row.gameName, "样本游戏名")
    assert.equal(row.anchor, "阿修Axiu")
    assert.equal(row.goal, "无畏(N5)")
    assert.equal(row.strength, "低配")
    assert.equal(row.note, "编辑器写入")
  })

  const view = await say("#排队 危战", { user_id: "30001", card: NICK })
  const viewCall = sent.renderCalls.at(-1)
  check("查询能看到新增的人", () => {
    /** 新写的这一行是「排队中」⇒ 排队中人数 +1（口径见 `baseQueuing`） */
    assert.equal(viewCall?.data.total, baseQueuing["幽境危战"] + 1)
    assert.ok(viewCall?.data.rows.some(r => r.nickname === NICK), "列表里没有新写入的人")
  })
  check("本人在列表里被标记（mine）", () => {
    const mineRow = viewCall?.data.rows.find(r => r.mine)
    assert.ok(mineRow, "没有标记出自己那一行")
    assert.equal(mineRow.nickname, NICK)
  })

  const beforeMine = sent.renderCalls.length
  const mine = await say("#排队", { user_id: "30001", card: NICK })
  check("#排队 只发一张图，榜单与本人信息合在一起", () => {
    assert.equal(mine.fnc, "menu")
    /** 只该出这一张图：本人的排队信息不再单独发一张 */
    assert.equal(
      sent.renderCalls.length,
      beforeMine + 1,
      `一次 #排队 只该渲染一张图：${sent.renderCalls.slice(beforeMine).map(c => c.tpl).join(",")}`,
    )
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.tpl, "queue/menu")
    const item = call?.data.mine?.[0]
    assert.ok(item, "菜单图里没有带出本人的排队信息")
    assert.equal(item.sheet, "幽境危战")
    assert.equal(item.row, EMPTY)
    assert.equal(item.nickname, NICK)
    assert.equal(item.gameName, "样本游戏名")
  })
  check("只排了一个榜：附填报入口，并点名还缺哪些榜", () => {
    const text = replyText(mine)
    assert.ok(/未填：幻想真境剧诗、深境螺旋/.test(text), text)
    /** 默认发短链：`<编辑器地址>/s/<码>`，长地址（k/u/s）不进聊天 */
    assert.ok(SHORT_LINK_RE.test(linkUrl(mine)), linkUrl(mine))
    assert.ok(!text.includes("?k="), `短链里不该出现口令与身份参数：${text}`)
    assert.ok(!/未填：[^\n；]*幽境危战/.test(text), text)
  })
  /** 短码要能被编辑器那一套验出来（插件签、编辑器验，两边共用 model/identity.js） */
  check("短码验得出人：verifyTicket(码, 签名密钥) 就是发送者", () => {
    const code = linkUrl(mine).split("/s/")[1] ?? ""
    const ticket = verifyTicket(code, config.remote.sign_key)
    assert.ok(ticket, `验不出短码：${code}`)
    assert.equal(ticket.qq, "30001")
    /** 不透明：码里看不出 QQ（既不出现十进制，也不出现 base36 写法） */
    assert.ok(!code.includes("30001") && !code.includes((30001).toString(36)), code)
  })
  /**
   * 短链上还挂一段**发送者当时的群昵称**（`?n=`，与 `?t&ts=` 同一段签名）
   *
   * 为什么要有它：编辑器认出"你是谁"之后，还要按群昵称去表里找"你自己那一行"，而群名片一向由它按 QQ
   * 从**每天推一次的群名单**里补；名单里没有这个人时，身份昵称会是空串、页面于是认不出自己那一行
   * （现场：主人第一次点自己的链接，看到"这个链接里没有你的群昵称"）。发链接这一刻机器人手里就有他的群名片。
   */
  check("短链带上发送者当时的群昵称（编辑器在群名单还没同步时靠它认出本人）", () => {
    const query = new URL(linkUrl(mine)).searchParams
    assert.equal(decodeLinkNick(query.get("n")), NICK, `短链里没有群昵称：${linkUrl(mine)}`)
    assert.ok(Number(query.get("t")) > 0 && query.get("ts"), `签发时刻那段丢了：${linkUrl(mine)}`)
    /**
     * 链接长度是**体感问题**（群里那条会折行）：除昵称外那两段（`t` + `ts`）加起来不该超过 30 个字符。
     * `ts` 是截断到 12 字节（16 字符）的签名，整段 HMAC 会占 43 个字符、这条就会红。
     */
    assert.ok(query.get("t").length <= 8, `签发分钟该是 8 位以内：${query.get("t")}`)
    assert.equal(query.get("ts").length, 16, `签名该是 16 个字符：${query.get("ts")}`)
    assert.ok(
      query.get("t").length + query.get("ts").length <= 24,
      `签发分钟 + 签名两段太长（${query.get("t").length + query.get("ts").length} 个字符）：${linkUrl(mine)}`,
    )
  })
  /**
   * AQ-02：另一个 QQ 用**同一个群昵称**时，不该被当成那一行的主人
   *
   * 昵称可以重名、本人也随时能改，绑定才是身份。昵称兜底若是"直接找同名行"，
   * 同名的后来者就能拿到先来者已经绑定的那一行（横向越权）。
   * 这条钉子钉在查询链路上（mineView → locateSelf），防止以后被改回去。
   */
  await check("同名的另一个 QQ：拿不到别人已绑定的那一行（AQ-02）", async () => {
    const other = await say("#排队", { user_id: "30099", card: NICK })
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.data.mine?.length ?? 0, 0, `同名的另一个 QQ 不该拿到别人那一行：${JSON.stringify(call?.data.mine)}`)
    const text = replyText(other)
    assert.ok(/未填：[^\n；]*幽境危战/.test(text), `幽境危战 是别人填的，对这个人仍算未填：${text}`)
    const { getStore } = await import("../model/store.js")
    assert.equal((await getStore()).get("幽境危战", "30099"), null, "没有认领就不该记下绑定")
  })

  /** 图与入口必须是**同一条消息**：分成两条会把群里刷成两屏 */
  check("图与填报入口合并在一条消息里（图 + 填写情况 + 短链）", () => {
    const msg = singleMsg(mine)
    assert.ok(Array.isArray(msg), "应当按片段数组发送")
    assert.equal(msg[0]?.type, "image", JSON.stringify(msg))
    const text = msg.filter(p => typeof p === "string").join("")
    assert.ok(text.includes("未填："), JSON.stringify(msg))
    assert.ok(text.includes("点此填表：http://127.0.0.1:"), JSON.stringify(msg))
    assert.ok(text.includes("/s/"), JSON.stringify(msg))
  })
  /** 云端编辑器还没更新（没有 /s/ 路由）时把开关关掉，退回长链接 */
  await check("关掉 short_link：退回带 k/u/s 的长链接", async () => {
    const saved = config.remote.short_link
    config.remote.short_link = false
    try {
      const out = await say("#排队", { user_id: "30001", card: NICK })
      const url = linkUrl(out)
      assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/[^\s]*\?k=[^&\s]+&u=[^&\s]+&s=[^&\s]+/.test(url), url)
      assert.ok(!url.includes("/s/"), url)
    } finally {
      config.remote.short_link = saved
    }
  })
  /** 打开 markdown（`remote.link_markdown: true`）时「点此填表」四个字本身就是链接 */
  await check("打开 link_markdown：入口是「点此填表」四个字带链接", async () => {
    const saved = config.remote.link_markdown
    config.remote.link_markdown = true
    try {
      const out = await say("#排队", { user_id: "30001", card: NICK })
      const md = linkMd(out)
      assert.ok(/^\[点此填表\]\(http:\/\/127\.0\.0\.1:\d+\/\S*\/s\/[A-Za-z0-9_-]{16}(?:\?t=\d+&ts=[A-Za-z0-9_-]+(?:&n=[A-Za-z0-9_-]+)?)?\)$/.test(md), md)
      singleMsg(out)
    } finally {
      config.remote.link_markdown = saved
    }
  })
  /** markdown 在多数群 / 账号上发不出去：不能把整条消息（含图）搭进去 */
  await check("「点此填表」发不出去（抛错）：图照发，入口退回「点此填表：<地址>」", async () => {
    const saved = config.remote.link_markdown
    config.remote.link_markdown = true
    const C = APPS.find(x => (new x().rule ?? []).some(r => String(r.fnc) === "menu"))
    const inst = Object.assign(new C(), { e: makeEvent("#排队", { user_id: "30001", card: NICK }), __replies: [] })
    const real = inst.reply.bind(inst)
    /** 复刻协议端不认这个段：整条消息发送失败 */
    inst.reply = (...args) => {
      if (JSON.stringify(args).includes('"markdown"')) return Promise.reject(new Error("发送者版本过低，无法展示内容"))
      return real(...args)
    }
    try {
      await inst.menu()
      const out = { replies: inst.__replies }
      const text = replyText(out)
      assert.ok(hasImage(out), text)
      assert.equal(linkMd(out), "", `回退后不该再带 markdown 段：${text}`)
      assert.ok(/点此填表：http:\/\/127\.0\.0\.1:\d+[^\n]*\/s\//.test(text), text)
    } finally {
      config.remote.link_markdown = saved
    }
  })
  /**
   * 真实框架的 reply **把发送异常吞成返回值** `{ error }`（不抛错），
   * 所以兜底必须看返回值——否则失败了也不会有任何回退
   */
  await check("「点此填表」发送失败被框架吞成 { error }：照样退回链接文本", async () => {
    const saved = config.remote.link_markdown
    config.remote.link_markdown = true
    const C = APPS.find(x => (new x().rule ?? []).some(r => String(r.fnc) === "menu"))
    const inst = Object.assign(new C(), { e: makeEvent("#排队", { user_id: "30001", card: NICK }), __replies: [] })
    const real = inst.reply.bind(inst)
    inst.reply = (...args) => {
      if (JSON.stringify(args).includes('"markdown"')) return Promise.resolve({ error: [new Error("markdown 被拒")] })
      return real(...args)
    }
    try {
      await inst.menu()
      const out = { replies: inst.__replies }
      const text = replyText(out)
      assert.ok(hasImage(out), text)
      assert.equal(linkMd(out), "", `被拒后不该再带 markdown 段：${text}`)
      assert.ok(/点此填表：http:\/\/127\.0\.0\.1:\d+[^\n]*\/s\//.test(text), text)
    } finally {
      config.remote.link_markdown = saved
    }
  })
  /**
   * 没配签名密钥时签不出可用身份：宁可说「暂无链接」，也不往群里丢一串打开没用的字符
   *
   * 这里用 **30001**（这一行真正的主人）：同一位成员在同名卡片的其它 QQ 下不再被当成同一人，
   * 见上一段「同名的另一个 QQ」——那是 AQ-02 要求的语义。
   */
  await check("发不出可用链接时：写「暂无链接」，既不带地址也不带入口", async () => {
    const saved = config.remote.sign_key
    config.remote.sign_key = ""
    try {
      const out = await say("#排队", { user_id: "30001", card: NICK })
      const text = replyText(out)
      assert.ok(/未填：幻想真境剧诗、深境螺旋/.test(text), text)
      assert.ok(text.includes("暂无链接"), text)
      assert.ok(!/https?:\/\//.test(text), text)
      assert.equal(linkMd(out), "", "签不出地址时不该丢一段点不开的入口")
      /** 链接废了也照样与图同一条消息，不额外补一条 */
      assert.ok(hasImage(out), text)
      singleMsg(out)
    } finally {
      config.remote.sign_key = saved
    }
  })
  const noMine = await say("#排队", { user_id: "99999", card: "查无此人" })
  check("表里没有这个人时，菜单图里不带本人信息块", () => {
    assert.equal(noMine.fnc, "menu")
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.tpl, "queue/menu")
    assert.equal(call?.data.mine?.length ?? 0, 0)
  })
  check("表里没有他：附上填报入口（带口令的编辑器地址）", () => {
    const text = replyText(noMine)
    assert.ok(/未填：/.test(text), text)
    assert.ok(SHORT_LINK_RE.test(linkUrl(noMine)), linkUrl(noMine))
  })
  /**
   * 已经填过的榜不再写「未填」→ 依旧附链接（已填的内容也要能回去改）
   *
   * 必须 await：这条用例自己会改表，不 await 就会和后面的写入用例抢同一行
   * （表格是真实数据的副本，另两个榜可能已经排满，没有空行就跳过那几个榜）
   */
  await check("已经填过的榜不再写「未填」：仍然附填报入口", async () => {
    const table = new Table({ file: fixture, backup: false })
    const added = []
    for (const name of ["幻想真境剧诗", "深境螺旋"]) {
      const row = firstEmptyRow(await readModel(name))
      if (row) added.push({ name, row })
    }
    if (!added.length) {
      console.log("     ⏭ 另外两个榜都没有空行（已排满），跳过本条")
      return
    }
    await table.mutate(ctx => {
      for (const { name, row } of added) ctx.setCell(name, row, "nickname", NICK)
    })
    try {
      /** 同一位成员（30001）：换一个 QQ 用同名卡片不再算同一个人，那一行的归属会互抢（AQ-02） */
      const full = await say("#排队", { user_id: "30001", card: NICK })
      const text = replyText(full)
      for (const { name } of added)
        assert.ok(!new RegExp(`未填：[^\\n；]*${name}`).test(text), `${name} 刚填上，不该算未填：${text}`)
      assert.ok(SHORT_LINK_RE.test(linkUrl(full)), linkUrl(full))
    } finally {
      await table.mutate(ctx => {
        for (const { name, row } of added) ctx.clearRow(name, row)
      })
    }
  })

  /**
   * 「已完成」两行文案：主播打完的（表里写的是主播名）和自己点过完成的（表里落成群昵称）
   * 都要点名出来，别再写进「未填」。
   */
  await check("已完成：主播打完与自己完成都算，并且不再算「未填」", async () => {
    const SHEET = "深境螺旋"
    const table = new Table({ file: fixture, backup: false })
    const row = firstEmptyRow(await readModel(SHEET))
    if (!row) {
      console.log("     ⏭ 表格没有空行，跳过本条")
      return
    }
    try {
      for (const status of ["本人已完成", "阿修Axiu"]) {
        await table.mutate(ctx => {
          ctx.setCell(SHEET, row, "nickname", NICK)
          ctx.setCell(SHEET, row, "status", status)
        })
        const menu = await say("#排队", { user_id: "30001", card: NICK })
        const menuText = replyText(menu)
        assert.ok(/已完成：深境螺旋/.test(menuText), `${status} 应当算已完成：${menuText}`)
        assert.ok(!/未填：[^\n；]*深境螺旋/.test(menuText), `深境螺旋 不该再算未填：${menuText}`)
        /** 单榜命令照同一口径走 */
        const one = await say("#排队 深境螺旋", { user_id: "30001", card: NICK })
        const oneText = replyText(one)
        assert.ok(/已完成：深境螺旋/.test(oneText), `${status}（单榜）应当算已完成：${oneText}`)
        assert.ok(!/未填：/.test(oneText), `有自己那一行就不该写未填：${oneText}`)
      }
    } finally {
      await table.mutate(ctx => ctx.clearRow(SHEET, row))
    }
  })

  /** 清空（模拟编辑器里删行） */
  await table.mutate(ctx => ctx.clearRow("幽境危战", EMPTY))
  const after = await readRows("幽境危战")
  check("清空后回到基线人数", () => assert.equal(after.length, baseCount["幽境危战"]))
  check("该行已无数据", () => assert.equal(after.find(i => i.row === EMPTY), undefined))
}

console.log("\n【3】定时任务里没有「队列推送」这回事")
{
  const app = APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "menu"))
  const inst = Object.assign(new app(), { e: makeEvent("#x"), __replies: [] })
  check("pushQueue 已删除（定时推送随 4 条任务一起精简掉）", () => assert.equal(typeof inst.pushQueue, "undefined"))
  check("注册的那条任务不是推送，而是统一 tick", () => {
    inst.init()
    assert.equal((inst.task ?? []).length, 1)
    assert.equal(inst.task[0].name, TICK_NAME)
  })
}

console.log("\n【4】进度通知（上一位完成 → @ 下一位）")
{
  const app = APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "menu"))
  const inst = Object.assign(new app(), { e: makeEvent("#x"), __replies: [] })
  const table = new Table({ file: fixture, backup: false })

  /** 找一对「前一位 + 后面还在排队的人」，@ 需要群里有这个昵称才行 */
  const model = await readModel("幽境危战")
  const rows = model.rows.filter(r => String(r.nickname).trim()).sort((a, b) => a.row - b.row)
  const at = rows.findIndex(r => r.status === "排队中")
  const first = at >= 0 ? rows[at] : null
  const following = first ? rows.slice(at + 1).find(r => r.status === "排队中") : null

  if (!first || !following) {
    console.log("     ⏭ 表里没有「前一位排队中且后面还有人排队」的组合，跳过本条")
  } else {
    MEMBERS[following.nickname] = "30001"

    const before = sent.length
    await inst.tick()
    check("首次轮询只记基线，不发消息", () => assert.equal(sent.length, before))

    const baseline = sent.length
    await table.mutate(ctx => ctx.setCell("幽境危战", first.row, "status", "本人已完成"))
    await inst.tick()
    /** 这一轮可能同时发「榜开启提醒」（某榜刚好翻到已开启）与完成通知，所以按内容找那一条 */
    const notice = sent
      .slice(baseline)
      .map(m => msgText(m.msg))
      .find(t => t.includes(first.nickname) && t.includes(following.nickname))
    check("上一位完成后发出一条通知", () => assert.ok(notice, `没有完成通知：${sent.slice(baseline).map(m => msgText(m.msg)).join(" || ")}`))
    check("通知 @ 的是下一位（不是别人）", () => {
      const flat = JSON.stringify(sent.find(m => msgText(m.msg) === notice)?.msg)
      assert.ok(flat.includes("30001"), `没有 @ 到下一位：${flat}`)
      assert.ok(flat.includes(following.nickname), flat)
      assert.ok(flat.includes(first.nickname), flat)
    })
    check("通知发到配置的群", () =>
      assert.equal(sent.find(m => msgText(m.msg) === notice)?.gid, 20000),
    )

    const again = sent.length
    await inst.tick()
    check("状态没再变化就不重复 @", () => assert.equal(sent.length, again))

    /**
     * @ 谁：优先这一行的**绑定**（`QQ → 行` 反查，`model/store.js`），其次群名单按昵称查；
     * 两边都拿不到 ⇒ 只显示名字、**不发 @**（不瞎 @，更不 @ 全体）。
     */
    const { getStore } = await import("../model/store.js")
    const store = await getStore()
    const atQqs = msg => (Array.isArray(msg) ? msg : [msg]).filter(p => p?.type === "at").map(p => String(p.qq))
    /** 再触发一次「上一位刚刚完成」，返回那一条完成通知（没发出来就是 null） */
    const completionNotice = async () => {
      /** 先按回"排队中"并 tick 一次：让下一轮重新算作「未完成 → 已完成」 */
      await table.mutate(ctx => ctx.setCell("幽境危战", first.row, "status", "排队中"))
      await inst.tick()
      await table.mutate(ctx => ctx.setCell("幽境危战", first.row, "status", "本人已完成"))
      const mark = sent.length
      await inst.tick()
      return (
        sent
          .slice(mark)
          .find(m => msgText(m.msg).includes("已完成 → 下一位") && msgText(m.msg).includes(following.nickname)) ?? null
      )
    }

    const BOUND_QQ = "30002"
    const rosterQq = MEMBERS[following.nickname]
    store.set("幽境危战", BOUND_QQ, { row: following.row, nickname: following.nickname })
    await store.save()

    await check("有绑定：消息里确有 at 段，@ 的是绑定里那个 QQ（绑定优先于群名单）", async () => {
      assert.notEqual(BOUND_QQ, rosterQq, `这条用例要有意义：绑定与群名单必须指向不同的人（都是 ${rosterQq}）`)
      const hit = await completionNotice()
      assert.ok(hit, "没发出完成通知")
      assert.ok(msgText(hit.msg).includes(following.nickname), `没写上名字：${msgText(hit.msg)}`)
      assert.deepEqual(atQqs(hit.msg), [BOUND_QQ], `实际 ${JSON.stringify(hit.msg)}`)
    })

    await check("没有绑定：退回群名单按昵称查，@ 的正是这个群昵称的人", async () => {
      store.dropRow("幽境危战", following.row)
      await store.save()
      const hit = await completionNotice()
      assert.ok(hit, "没发出完成通知")
      assert.ok(msgText(hit.msg).includes(following.nickname), `没写上名字：${msgText(hit.msg)}`)
      assert.deepEqual(atQqs(hit.msg), [rosterQq], `实际 ${JSON.stringify(hit.msg)}`)
    })

    await check("两边都拿不到：只显示名字、不发 @（也不报错）", async () => {
      const { forgetRoster } = await import("../model/roster.js")
      /** 缓存也要清掉：这条用例要的就是"哪儿都没有他"（缓存里有就等于名单里也有） */
      forgetRoster()
      delete MEMBERS[following.nickname]
      try {
        const hit = await completionNotice()
        assert.ok(hit, "没发出完成通知")
        assert.ok(msgText(hit.msg).includes(following.nickname), `没写上名字：${msgText(hit.msg)}`)
        assert.deepEqual(atQqs(hit.msg), [], `本该没有 at 段：${JSON.stringify(hit.msg)}`)
      } finally {
        MEMBERS[following.nickname] = rosterQq
      }
    })

    /**
     * 这一条钉的是"艾特时好时坏"的另一半：通知是**那一刻**发的，实时名单取不到（机器人刚重启 /
     * 这一下取成员失败）时不能就退化。今天扫到过一次，@ 就得照样成立。
     */
    const CACHE_QQ = "30009"
    await check("实时名单取不到、但今天扫到过：@ 改用扫描缓存兜底", async () => {
      const { rememberRoster, forgetRoster } = await import("../model/roster.js")
      delete MEMBERS[following.nickname]
      rememberRoster(20000, [{ qq: CACHE_QQ, nick: following.nickname }])
      try {
        const hit = await completionNotice()
        assert.ok(hit, "没发出完成通知")
        assert.ok(msgText(hit.msg).includes(following.nickname), `没写上名字：${msgText(hit.msg)}`)
        assert.deepEqual(atQqs(hit.msg), [CACHE_QQ], `没 @ 到扫描缓存里那个人：${JSON.stringify(hit.msg)}`)
      } finally {
        forgetRoster()
        MEMBERS[following.nickname] = rosterQq
      }
    })

    /** 收尾：把状态改回去，源表副本恢复原样 */
    await table.mutate(ctx => ctx.setCell("幽境危战", first.row, "status", first.status))
  }
}

console.log("\n【5】按 QQ 定位（改了群名片也认人）")
{
  const { getStore } = await import("../model/store.js")
  const store = await getStore()
  const table = new Table({ file: fixture, backup: false })
  const QQ = "40001"
  const OLD = "改名之前的旧名片"
  const NEW = "改名之后的新名片"

  const model = await readModel("幽境危战")
  const row = firstEmptyRow(model)
  await table.mutate(ctx => {
    ctx.setCell("幽境危战", row, "nickname", OLD)
    ctx.setCell("幽境危战", row, "gameName", "游戏名不该被动")
  })
  store.set("幽境危战", QQ, { row, nickname: OLD })
  await store.save()

  const res = await say("#排队", { user_id: QQ, card: NEW })
  check("QQ 绑定命中：发 #排队 照样带出本人的排队信息", () => {
    assert.equal(res.fnc, "menu")
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.tpl, "queue/menu")
    assert.equal(call?.data.mine?.[0]?.row, row)
  })
  await check("QQ 绑定命中：表里一个字都没改（插件只读）", async () => {
    const after = await readModel("幽境危战")
    const item = after.rows.find(r => r.row === row)
    assert.equal(item.nickname, OLD)
    assert.equal(item.gameName, "游戏名不该被动")
  })
  check("QQ 绑定命中：图里显示的是表里的昵称，不是群名片", () => {
    assert.equal(sent.renderCalls.at(-1)?.data.mine?.[0]?.nickname, OLD)
  })
  check("QQ 绑定命中：绑定记录里的昵称刷新成新名片", () => {
    assert.equal(store.get("幽境危战", QQ)?.nickname, NEW)
  })

  /** 收尾：清掉这一行与绑定 */
  await table.mutate(ctx => ctx.clearRow("幽境危战", row))
  store.dropRow("幽境危战", row)
  store.del("幽境危战", QQ)
  await store.save()
}

console.log("\n【6】原表格未被触碰")
{
  const after = await fs.readFile(SOURCE)
  check("源表格哈希未变", () => assert.equal(sha256(after), sourceHash))
}

/**
 * 【7】`#排队同步名单`：主人手动推一次名单
 *
 * 名单本来只有两条自动路径（启动后 20 秒的 kick、每天 `roster.at` 那次 tick），
 * 想立刻拉一次只能重启机器人——这条命令补的就是这个口子。
 */
console.log("\n【7】`#排队同步名单`：主人手动推一次名单")
{
  const app = APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "rosterSync"))
  const pushes = () => Number(ENV.cloud.state.rosterPushes ?? 0)

  check("规则已注册、且是主人专用", () => {
    assert.ok(app, "没有 #排队同步名单 这个入口")
    const rule = (new app().rule ?? []).find(r => String(r.fnc) === "rosterSync")
    assert.equal(rule.permission, "master", JSON.stringify(rule))
    assert.ok(new RegExp(rule.reg).test("#排队同步名单"), String(rule.reg))
  })

  /** 主人：真推一次（临时把群号与成员补齐，这个套件的配置本来不含 roster.group） */
  const groupBefore = String(config.roster?.group ?? "")
  config.roster.group = "20000"
  MEMBERS["同步测试"] = "30009"
  const before = pushes()
  const asMaster = await say("#排队同步名单", { user_id: "10000", card: "主人", isMaster: true })
  check("主人：真推了一次，并回执同步了几人", () => {
    assert.equal(asMaster.fnc, "rosterSync")
    assert.equal(pushes(), before + 1, `实际推了 ${pushes() - before} 次`)
    /** 人数按这个套件当前的群名单算（前面的 @ 用例会往里补人，别写死 1） */
    const want = Object.keys(MEMBERS).length
    assert.ok(last(asMaster).includes(`已同步：${want} 人`), `人数不对：${last(asMaster)}（群名单里 ${want} 人）`)
  })

  /** 非主人：一个请求都不发（handler 里那道 `e.isMaster` 闸） */
  const beforeMember = pushes()
  const asMember = await say("#排队同步名单", { user_id: "30001", card: "普通群友" })
  check("非主人：不推、只回一句拒绝", () => {
    assert.equal(asMember.fnc, "rosterSync")
    assert.equal(pushes(), beforeMember, "非主人却把名单推出去了")
    assert.ok(/主人/.test(last(asMember)), last(asMember))
  })

  /** 没配群号：把原因原样说出来（这条原来只在返回值里，日志里一个字都没有） */
  config.roster.group = ""
  const beforeSkipped = pushes()
  const noGroup = await say("#排队同步名单", { user_id: "10000", card: "主人", isMaster: true })
  check("没配群号：回执点明「没配 roster.group」，且不发请求", () => {
    assert.equal(pushes(), beforeSkipped, "没配群号却发了请求")
    assert.ok(/没配 roster\.group/.test(last(noGroup)), last(noGroup))
  })
  config.roster.group = groupBefore
  delete MEMBERS["同步测试"]
}

/**
 * 【8】`#排队` 前补推名单：**本群守卫的兜底**
 *
 * 编辑器的守卫是"名单可信 + 你在名单里 ⇒ 才能改整张表"，而名单每天才推一次：
 * 刚进群的人当天不在名单里，拿到的链接会被判成"群外人"（只读）。
 * 所以 `#排队` 里补一步：发送者不在**已有名单**里时，当场重扫一次再发链接。
 */
console.log("\n【8】`#排队` 前补推名单（新人的链接不能一开局就只读）")
{
  const { forgetRoster } = await import("../model/roster.js")
  const pushes = () => Number(ENV.cloud.state.rosterPushes ?? 0)
  const groupBefore = String(config.roster?.group ?? "")
  config.roster.group = "20000"
  MEMBERS["刚进群的人"] = "30077"
  /** 清掉内存里的名单 ⇒ 模拟"这个人不在已有名单里"（新人的现场就是这样） */
  forgetRoster()

  const before = pushes()
  const joined = await say("#排队", { user_id: "30077", card: "刚进群的人" })
  check("发送者不在已有名单里 ⇒ `#排队` 顺手补推一次名单，再发链接", () => {
    assert.equal(joined.fnc, "menu")
    assert.equal(pushes(), before + 1, `实际推了 ${pushes() - before} 次`)
  })

  const seeded = pushes()
  const again = await say("#排队", { user_id: "30077", card: "刚进群的人" })
  check("名单里已经有他 ⇒ 不再补推（省下一次全群扫描）", () => {
    assert.equal(again.fnc, "menu")
    assert.equal(pushes(), seeded, "名单里有他却又推了一次")
  })

  config.roster.group = ""
  const noGroup = pushes()
  await say("#排队", { user_id: "30088", card: "没人认识的号" })
  check("没配群号 ⇒ 不补推（这条兜底只在本群守卫用得上时才做）", () => {
    assert.equal(pushes(), noGroup, "没配群号却发了请求")
  })
  config.roster.group = groupBefore
  delete MEMBERS["刚进群的人"]
}

/** 收掉假云端 */
await ENV.cloud?.close()

await finish()
console.log(`测试产物：${fixture}`)
