/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行，
   若在本文件里 setenv，config.js 早就按仓库 config.yaml 读完了（会动到真实表格） */
import { ensureEnv } from "./env.mjs"
/**
 * 工作流回归：在「假 Yunzai」里加载插件本体，用桩事件驱动真实 handler
 *
 * 填表已经移到在线编辑器（tools/editor.mjs），聊天端只保留查询类指令：
 *   #排队 / #主播 / #清空
 * 因此这里：
 *   - 用桩实现 Yunzai 注入的全局（plugin / logger / segment / Bot，见 _helper.mjs）
 *   - 用桩复刻 loader 的规则匹配与上下文分发
 *   - 真实调用插件的 menu / anchors / clearStep / pushQueue / watchProgress
 *   - 写表部分直接用 model 层（编辑器走的是同一套 Table.mutate）
 * 全程只操作表格副本。
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createChecker, exampleConfig, installFrameworkStubs, requireSource } from "./_helper.mjs"
import { DEFAULT_CONFIG } from "../components/config.js"
import { firstEmptyRow } from "../lib/queue.js"

const SOURCE = requireSource()
const { check, finish } = createChecker("工作流回归")

const ENV = ensureEnv({
  prefix: "abyss-queue-e2e-",
  extra: {
    push: { enable: true, groups: [20000], limit: 3 },
    editor_url: "https://abyss.example.com",
    editor_token: "tok-123",
    /** 别名：让 #主播 阿修 也能查到 阿修Axiu */
    anchor_aliases: { 阿修Axiu: ["阿修"] },
  },
})
const fixture = ENV.fixture
const storeFile = ENV.store
await fs.copyFile(SOURCE, fixture)
const sha256 = buf => createHash("sha256").update(buf).digest("hex")
const sourceHash = sha256(await fs.readFile(SOURCE))

/** 进度快照与月末标记写到临时目录，别动仓库的 data/ */
const { config } = await import("../components/config.js")
const { verifyIdentity } = await import("../lib/identity.js")
config.notify.state_file = path.join(ENV.dir, "notify", "progress.json")

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

const makeEvent = (msg, { user_id = "10001", card = "测试用户", isGroup = true } = {}) => ({
  msg,
  user_id,
  self_id: "10000",
  group_id: "20000",
  isGroup,
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

/** 模拟一条处于上下文中的消息（复刻 loader：私聊上下文 + 群上下文 合并） */
const answer = async (msg, opts = {}) => {
  const e = makeEvent(msg, opts)
  for (const C of APPS) {
    const inst = Object.assign(new C(), { e, __replies: [] })
    const ctx = { ...(inst.getContext() ?? {}), ...(inst.getContext(false, true) ?? {}) }
    const type = Object.keys(ctx)[0]
    if (!type) continue
    await inst[type](ctx[type])
    return { fnc: type, replies: inst.__replies, inst }
  }
  const empty = Object.assign(new APPS[0](), { e, __replies: [] })
  return { fnc: null, replies: empty.__replies, inst: empty }
}

/** 规则表里是否存在能命中该消息的规则（用于确认已删指令真的不再拦截） */
const matches = msg => APPS.some(C => rulesOf(Object.assign(new C(), {})).some(r => r.reg.test(msg)))

const last = r => String(r.replies.at(-1) ?? "")
const readModel = async sheet => {
  const table = new Table({ file: fixture, backup: false })
  return table.read(({ models }) => models.get(sheet))
}
const readRows = async sheet => (await readModel(sheet)).rows

/** 基线人数：源表格是用户随时在用的真实数据，不写死人数，只断言「相对基线」的变化 */
const baseCount = {}
for (const sheet of ["幻想真境剧诗", "幽境危战", "深境螺旋"]) baseCount[sheet] = (await readRows(sheet)).length
/** 新的数据行 = 幽境危战当前的首个空行（用户补过行时会顺延） */
const BASE = await readModel("幽境危战")
const EMPTY = firstEmptyRow(BASE)

console.log(`源表格：${SOURCE}\n测试副本：${fixture}\n`)

/* ------------------------------ 用例 ------------------------------ */

console.log("【1】规则分发（只剩查询类指令）")
{
  check("注册的规则数已精简到 3 条", () => {
    const n = APPS.reduce((sum, C) => sum + (new C().rule ?? []).length, 0)
    assert.equal(n, 3, `实际 ${n} 条`)
  })

  const r = await say("#排队")
  check("#排队 命中 menu", () => assert.equal(r.fnc, "menu"))
  const menuCall = sent.renderCalls.at(-1)
  check("菜单走图片渲染（模板与数据正确）", () => {
    assert.equal(menuCall?.plugin, "abyss-queue")
    assert.equal(menuCall?.tpl, "queue/menu")
    assert.equal(menuCall?.data.sheets.length, 3)
    assert.equal(menuCall?.data.sheets.find(s => s.name === "幽境危战")?.count, baseCount["幽境危战"])
    assert.ok(menuCall?.data.version.includes("三路深渊排队"), menuCall?.data.version)
  })
  check("菜单回复为图片占位（未走文本回退）", () => {
    /** 菜单之后还会补发一条编辑器链接，所以这里看整轮回复而不是最后一条 */
    assert.ok(r.replies.some(x => String(x).includes("[图片]")), r.replies.join(" | "))
  })
  check("菜单图里带上在线编辑器地址", () => {
    assert.equal(menuCall?.data.editorUrl, "https://abyss.example.com")
  })
  check("#排队 之后发放带口令的编辑器链接", () => {
    const text = r.replies.join("\n")
    assert.ok(text.includes("https://abyss.example.com/?k=tok-123"), text)
  })
  check("编辑器链接带上发送者的身份签名（只让他改自己那一行）", () => {
    const text = r.replies.join("\n")
    const url = new URL(text.match(/https:\/\/abyss\.example\.com\/\?k=\S+/)?.[0] ?? "https://x/")
    assert.equal(url.searchParams.get("k"), "tok-123")
    const id = verifyIdentity(url.searchParams.get("u"), url.searchParams.get("s"), "tok-123")
    assert.ok(id, "签名验不过")
    assert.equal(id.nick, "测试用户")
    /** 换成别人的昵称就验不过 */
    const forged = Buffer.from(JSON.stringify({ q: "1", n: "别人", t: Date.now() })).toString("base64url")
    assert.equal(verifyIdentity(forged, url.searchParams.get("s"), "tok-123"), null)
  })
  check("定时任务：推送 / 完成情况轮询 / 月末催办都注册了", () => {
    const app = APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "menu"))
    const inst = Object.assign(new app(), { e: makeEvent("#x"), __replies: [] })
    inst.init()
    const names = (inst.task ?? []).map(t => t.name)
    assert.ok(names.includes("深渊排队推送"), names.join(","))
    assert.ok(names.includes("排队完成情况轮询"), names.join(","))
    assert.ok(names.includes("月末排队催办"), names.join(","))
    for (const t of inst.task) assert.ok(/^[\d*/,\- ]+$/.test(t.cron), `cron 不合法：${t.cron}`)
  })

  const r2 = await say("#排队 危战")
  check("#排队 危战 命中 menu（单榜）", () => assert.equal(r2.fnc, "menu"))
  const queueCall = sent.renderCalls.at(-1)
  check("队列走图片渲染（模板与数据正确）", () => {
    assert.equal(queueCall?.tpl, "queue/queue")
    assert.equal(queueCall?.data.name, "幽境危战")
    assert.equal(queueCall?.data.total, baseCount["幽境危战"])
    assert.equal(queueCall?.data.rows[0].seq, "1")
    assert.equal(queueCall?.data.rows[0].nickname, "小伙01")
  })

  const r3 = await say("#主播 危战")
  check("#主播 危战 只列该榜主播（图片）", () => {
    assert.equal(r3.fnc, "anchors")
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.tpl, "queue/anchors")
    assert.equal(call?.data.anchors[0].name, "阿修Axiu")
    assert.equal(call?.data.total, 6)
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
  const rName = await say("#主播 阿修Axiu")
  check("#主播 <名字> 文本输出该主播信息", () => {
    assert.equal(rName.fnc, "anchors")
    const text = last(rName)
    assert.ok(text.includes("阿修Axiu"), text)
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
  check("#主播 <别名>：阿修 也能查到 阿修Axiu", () => {
    assert.equal(rAlias.fnc, "anchors")
    const text = last(rAlias)
    assert.ok(text.includes("阿修Axiu"), text)
    assert.ok(!text.includes("没找到"), text)
  })

  check("渲染请求带上出图分辨率倍数（render_scale）", () => {
    assert.equal(queueCall?.cfg?.scale, DEFAULT_CONFIG.render_scale)
    /** 缺省值与示例配置一致，部署照抄模板即可拿到高清图 */
    assert.ok(Number(exampleConfig.render_scale) > 1, `示例配置的 render_scale 应为高清：${exampleConfig.render_scale}`)
  })

  await check("单榜指令能查到对应榜（#排队 <榜> 与旧后缀写法）", async () => {
    for (const [cmd, sheet] of [
      ["#排队 危战", "幽境危战"],
      ["#排队 剧诗", "幻想真境剧诗"],
      ["#排队 深渊", "深境螺旋"],
      ["#排队 幽境危战", "幽境危战"],
      ["#排队 幻想真境剧诗", "幻想真境剧诗"],
      ["#排队 3", "深境螺旋"],
      ["#排队 剧诗 全部", "幻想真境剧诗"],
      /** 旧写法保留兼容 */
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

  check("裸榜名不再被本插件接管（避免与 Axiu-Plugin 抢命令）", () => {
    for (const cmd of ["#幽境危战", "#幻想真境剧诗", "#深境螺旋", "#深渊", "#危战", "#剧诗"])
      assert.equal(matches(cmd), false, `${cmd} 不应命中任何本插件规则`)
  })

  check("已移除的指令不再被拦截", () => {
    for (const cmd of [
      "#报名",
      "#报名 幽境危战 甲 阿修Axiu 无畏(N5) 低配",
      "#退队",
      "#改备注 备注内容",
      /** #我的 已并入 #排队 */
      "#我的",
      "#深渊报名",
      "#深渊退队",
      "#深渊我的",
      "#深渊主播",
    ])
      assert.equal(matches(cmd), false, `${cmd} 应已移除`)
  })
}

console.log("\n【2】写表（编辑器同一套 Table.mutate）→ 查询生效")
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
    assert.equal(viewCall?.data.total, baseCount["幽境危战"] + 1)
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
  const noMine = await say("#排队", { user_id: "99999", card: "查无此人" })
  check("表里没有这个人时，菜单图里不带本人信息块", () => {
    assert.equal(noMine.fnc, "menu")
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.tpl, "queue/menu")
    assert.equal(call?.data.mine?.length ?? 0, 0)
  })

  /** 清空（模拟编辑器里删行） */
  await table.mutate(ctx => ctx.clearRow("幽境危战", EMPTY))
  const after = await readRows("幽境危战")
  check("清空后回到基线人数", () => assert.equal(after.length, baseCount["幽境危战"]))
  check("该行已无数据", () => assert.equal(after.find(i => i.row === EMPTY), undefined))
}

console.log("\n【3】主人清空（二次确认）")
{
  const ask = await say("#清空 深境螺旋", { user_id: "10000", card: "主人" })
  check("清空前给出确认提示", () => {
    assert.ok(last(ask).includes(`将清空「深境螺旋」全部 ${baseCount["深境螺旋"]} 行`), last(ask))
    assert.ok(last(ask).includes("确认清空 深境螺旋"))
  })
  const wrong = await answer("确认清空 乱七八糟", { user_id: "10000", card: "主人" })
  check("错误的确认串被拒绝", () => assert.ok(last(wrong).includes("格式不对")))
  const ask2 = await say("#清空 深境螺旋", { user_id: "10000", card: "主人" })
  check("可以重新发起清空", () => assert.ok(last(ask2).includes("将清空")))
  const done = await answer("确认清空 深境螺旋", { user_id: "10000", card: "主人" })
  check("确认后按实际行数清空", () =>
    assert.ok(last(done).includes(`已清空「深境螺旋」${baseCount["深境螺旋"]} 行`), last(done)),
  )
  const rows = await readRows("深境螺旋")
  check("深境螺旋已无数据行", () => assert.equal(rows.length, 0))

  const { openWorkbook } = await import("../lib/xlsx.js")
  const { buildModel } = await import("../lib/schema.js")
  const buffer = await fs.readFile(fixture)
  const wb = await openWorkbook(buffer)
  const xml = await wb.sheetXml("深境螺旋")
  const model = buildModel({ name: "深境螺旋", xml, shared: wb.shared })

  const tagCount = (text, tag) => (text.split(tag).length - 1)
  const STRUCT = ["<dataValidation ", "<conditionalFormatting ", "<mergeCell ", "<hyperlink ", "<f>", "<row "]
  const originalXml = await (await openWorkbook(await fs.readFile(SOURCE))).sheetXml("深境螺旋")
  check("清空后表头仍在（解析后 A7 = 序号）", () => {
    assert.equal(model.headerRow, 7)
    assert.equal(model.col.nickname, "B")
  })
  check("清空后结构 / 公式 / 格式数量与原表一致", () => {
    for (const tag of STRUCT)
      assert.equal(tagCount(xml, tag), tagCount(originalXml, tag), `${tag} 数量变化`)
  })
  check("清空只删掉了单元格", () => assert.ok(tagCount(xml, "<c ") < tagCount(originalXml, "<c ")))
  check("清空后主播区仍可解析", () => assert.equal(model.anchors.length, 3))
}

console.log("\n【4】定时推送")
{
  const app = APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "menu"))
  const inst = Object.assign(new app(), { e: makeEvent("#x"), __replies: [] })
  await inst.pushQueue()
  check("推送产生消息", () => assert.equal(sent.length, 1))
  check("推送目标群正确", () => assert.equal(sent[0].gid, 20000))
  check("推送内容含榜单与限流条数", () => {
    assert.ok(sent[0].msg.includes("【三路深渊排队】"))
    assert.ok(sent[0].msg.includes("【幽境危战】"))
    assert.ok(sent[0].msg.includes("还有"), "list_limit=3 应触发折叠提示")
  })
}

console.log("\n【5】进度通知（上一位完成 → @ 下一位）")
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
    await inst.watchProgress()
    check("首次轮询只记基线，不发消息", () => assert.equal(sent.length, before))

    await table.mutate(ctx => ctx.setCell("幽境危战", first.row, "status", "本人已完成"))
    await inst.watchProgress()
    check("上一位完成后发出一条通知", () => assert.equal(sent.length, before + 1))
    const msg = sent.at(-1).msg
    check("通知 @ 的是下一位（不是别人）", () => {
      const flat = JSON.stringify(msg)
      assert.ok(flat.includes("30001"), `没有 @ 到下一位：${flat}`)
      assert.ok(flat.includes(following.nickname), flat)
      assert.ok(flat.includes(first.nickname), flat)
    })
    check("通知发到配置的群", () => assert.equal(sent.at(-1).gid, 20000))

    const again = sent.length
    await inst.watchProgress()
    check("状态没再变化就不重复 @", () => assert.equal(sent.length, again))

    /** 收尾：把状态改回去，源表副本恢复原样 */
    await table.mutate(ctx => ctx.setCell("幽境危战", first.row, "status", first.status))
  }
}

console.log("\n【6】按 QQ 定位（改了群名片也认人）")
{
  const { getStore } = await import("../model/index.js")
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
  await check("QQ 绑定命中：表里的群昵称被同步成新名片", async () => {
    const after = await readModel("幽境危战")
    const item = after.rows.find(r => r.row === row)
    assert.equal(item.nickname, NEW)
    /** 只改群昵称，游戏名不动 */
    assert.equal(item.gameName, "游戏名不该被动")
  })
  check("QQ 绑定命中：图里显示的也是新名片", () => {
    assert.equal(sent.renderCalls.at(-1)?.data.mine?.[0]?.nickname, NEW)
  })
  check("QQ 绑定命中：绑定记录里的昵称一并刷新", () => {
    assert.equal(store.get("幽境危战", QQ)?.nickname, NEW)
  })

  /** 收尾：清掉这一行与绑定 */
  await table.mutate(ctx => ctx.clearRow("幽境危战", row))
  store.dropRow("幽境危战", row)
  store.del("幽境危战", QQ)
  await store.save()
}

console.log("\n【7】原表格未被触碰")
{
  const after = await fs.readFile(SOURCE)
  check("源表格哈希未变", () => assert.equal(sha256(after), sourceHash))
}

await finish()
console.log(`测试产物：${fixture}`)
