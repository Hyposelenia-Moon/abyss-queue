/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行，
   若在本文件里 setenv，config.js 早就按仓库 config.yaml 读完了（会动到真实表格） */
import { ensureEnv } from "./env.mjs"
/**
 * 工作流回归：在「假 Yunzai」里加载插件本体，用桩事件驱动真实 handler
 *
 * 本机没有 QQ 协议端，无法真发消息，因此这里：
 *   - 用桩实现 Yunzai 注入的全局（plugin / logger / segment / Bot，见 _helper.mjs）
 *   - 用桩复刻 loader 的规则匹配与上下文分发
 *   - 经插件根 index.js 的 `apps` 导出装载入口类（与框架 loader 的取法一致）
 *   - 真实调用插件的 menu / joinInline / joinStep / leave / setNote / clearStep / pushQueue
 * 全程只操作表格副本。
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Paths, createChecker, exampleConfig, installFrameworkStubs, requireSource } from "./_helper.mjs"
import { DEFAULT_CONFIG } from "../components/config.js"
import { firstEmptyRow } from "../lib/queue.js"

const SOURCE = requireSource()
const { check, finish } = createChecker("工作流回归")

const ENV = ensureEnv({
  prefix: "abyss-queue-e2e-",
  extra: { push: { enable: true, groups: [20000], limit: 3 } },
})
const fixture = ENV.fixture
const storeFile = ENV.store
await fs.copyFile(SOURCE, fixture)
const sha256 = buf => createHash("sha256").update(buf).digest("hex")
const sourceHash = sha256(await fs.readFile(SOURCE))

/* ------------------------- 桩：Yunzai 环境 ------------------------- */

const sent = installFrameworkStubs()

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

const last = r => String(r.replies.at(-1) ?? "")
const readModel = async sheet => {
  const table = new Table({ file: fixture, backup: false })
  return table.read(({ models }) => models.get(sheet))
}
const readRows = async sheet => (await readModel(sheet)).rows

/** 基线人数：源表格是用户随时在用的真实数据，不写死人数，只断言「相对基线」的变化 */
const baseCount = {}
for (const sheet of ["幻想真境剧诗", "幽境危战", "深境螺旋"]) baseCount[sheet] = (await readRows(sheet)).length
/** 报名插入行 = 幽境危战当前的首个空行（用户补过行时会顺延） */
const BASE = await readModel("幽境危战")
const EMPTY = firstEmptyRow(BASE)

console.log(`源表格：${SOURCE}\n测试副本：${fixture}\n`)

/* ------------------------------ 用例 ------------------------------ */

console.log("【1】规则分发")
{
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
    assert.ok(last(r).includes("[图片]"), last(r))
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
  check("#主播 列出主播", () => {
    assert.equal(r3.fnc, "anchors")
    const call = sent.renderCalls.at(-1)
    assert.equal(call?.tpl, "queue/anchors")
    assert.equal(call?.data.anchors[0].name, "阿修Axiu")
    assert.equal(call?.data.total, 6)
  })
  check("渲染请求带上出图分辨率倍数（render_scale）", () => {
    assert.equal(queueCall?.cfg?.scale, DEFAULT_CONFIG.render_scale)
    /** 缺省值与示例配置一致，部署照抄模板即可拿到高清图 */
    assert.ok(Number(exampleConfig.render_scale) > 1, `示例配置的 render_scale 应为高清：${exampleConfig.render_scale}`)
  })
  check("单榜指令能查到对应榜（#排队 <榜> 与旧后缀写法）", async () => {
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
      /** 用独立 QQ：查询会顺带绑定，共用 QQ 会串到后面「新增报名」的用例 */
      const res = await say(cmd, { user_id: "90001", card: "只读查询" })
      assert.equal(res.fnc, "menu", `${cmd} 应命中 menu`)
      assert.equal(sent.renderCalls.at(-1)?.data.name, sheet, `${cmd} 应打开 ${sheet}`)
    }
  })
  check("裸榜名不再被本插件接管（避免与 Axiu-Plugin 抢命令）", async () => {
    for (const cmd of ["#幽境危战", "#幻想真境剧诗", "#深境螺旋", "#深渊", "#危战", "#剧诗"]) {
      const res = await say(cmd, { user_id: "90001", card: "只读查询" })
      assert.equal(res.fnc, null, `${cmd} 不应命中任何本插件规则`)
    }
  })
}

console.log("\n【2】一行式报名 → 查询 → 改备注 → 退队")
{
  const join = await say("#报名 幽境危战 测试号甲 阿修Axiu 无畏(N5) 低配 一行式备注", {
    user_id: "30001",
    card: "样本用户A",
  })
  check("命中 joinInline", () => assert.equal(join.fnc, "joinInline"))
  check("回复报名成功并给出序号", () => {
    const text = last(join)
    const expectSeq = `第 ${EMPTY - BASE.dataStart + 1} 位`
    assert.ok(text.includes(expectSeq), `期望「${expectSeq}」，实际回复：\n${text}`)
    assert.ok(text.includes(`表格第 ${EMPTY} 行`), `期望「表格第 ${EMPTY} 行」，实际回复：\n${text}`)
    assert.ok(text.includes("报名成功"), text)
  })
  const rows = await readRows("幽境危战")
  check(`表格第 ${EMPTY} 行写入正确`, () => {
    const row = rows.find(i => i.row === EMPTY)
    assert.ok(row, `第 ${EMPTY} 行没有数据`)
    assert.equal(row.nickname, "样本用户A")
    assert.equal(row.gameName, "测试号甲")
    assert.equal(row.anchor, "阿修Axiu")
    assert.equal(row.goal, "无畏(N5)")
    assert.equal(row.strength, "低配")
    assert.equal(row.note, "一行式备注")
    assert.equal(row.status, "排队中")
  })

  const view = await say("#危战排队", { user_id: "30001", card: "样本用户A" })
  const viewCall = sent.renderCalls.at(-1)
  check("自己那行被标记（图片数据里的 mine）", () => {
    const mineRow = viewCall?.data.rows.find(r => r.mine)
    assert.ok(mineRow, "没有标记出自己那一行")
    assert.equal(mineRow.nickname, "样本用户A")
  })
  check("人数 +1", () => assert.equal(viewCall?.data.total, baseCount["幽境危战"] + 1))

  const mine = await say("#我的", { user_id: "30001", card: "样本用户A" })
  check("#我的 显示绑定行", () => {
    assert.ok(last(mine).includes("幽境危战"))
    assert.ok(last(mine).includes(`表格第 ${EMPTY} 行`))
  })

  const note = await say("#改备注 改过的备注", { user_id: "30001", card: "样本用户A" })
  check("改备注成功", () => assert.ok(last(note).includes("改过的备注")))
  const rows2 = await readRows("幽境危战")
  check("表格 G 列已更新", () =>
    assert.equal(rows2.find(i => i.row === EMPTY)?.note, "改过的备注"),
  )

  const repeat = await say("#报名 幽境危战 测试号甲 阿修Axiu 绝境(N6) 中配", {
    user_id: "30001",
    card: "样本用户A",
  })
  check("重复报名走更新而非新增", () => {
    assert.ok(last(repeat).includes("更新"), last(repeat))
    assert.ok(last(repeat).includes(`表格第 ${EMPTY} 行`))
  })
  const rows3 = await readRows("幽境危战")
  check("更新后无重复行（仍 +1 行）", () => assert.equal(rows3.length, baseCount["幽境危战"] + 1))
  check("更新后的难度已生效", () =>
    assert.equal(rows3.find(i => i.row === EMPTY)?.goal, "绝境(N6)"),
  )

  const fuzzy = await say("#报名 幽境危战 测试号甲 阿修 无畏 3", {
    user_id: "30001",
    card: "样本用户A",
  })
  check("近似值（主播/难度/强度）自动归一后写入", () => {
    assert.ok(last(fuzzy).includes("报名成功"), last(fuzzy))
  })
  const rowsFuzzy = await readRows("幽境危战")
  check("归一结果落表正确（阿修→阿修Axiu，无畏→无畏(N5)，3→低配）", () => {
    const row = rowsFuzzy.find(i => i.row === EMPTY)
    assert.ok(row, `第 ${EMPTY} 行没有数据`)
    assert.equal(row.anchor, "阿修Axiu")
    assert.equal(row.goal, "无畏(N5)")
    assert.equal(row.strength, "低配")
    assert.equal(rowsFuzzy.length, baseCount["幽境危战"] + 1, "归一不应新增行")
  })

  const leave = await say("#退队", { user_id: "30001", card: "样本用户A" })
  check("退队成功并报行号", () => assert.ok(last(leave).includes(`表格第 ${EMPTY} 行已清空`)))
  const rows4 = await readRows("幽境危战")
  check("退队后回到基线人数", () => assert.equal(rows4.length, baseCount["幽境危战"]))
  check(`空行回到第 ${EMPTY} 行`, () => assert.equal(rows4.find(i => i.row === EMPTY), undefined))

  const leaveAgain = await say("#退队", { user_id: "30001", card: "样本用户A" })
  check("未报名时退队给出提示", () => assert.ok(last(leaveAgain).includes("没有报名记录")))
}

console.log("\n【3】引导式报名（上下文流程）")
{
  const start = await say("#报名", { user_id: "10002", card: "测试乙" })
  check("命中 joinGuide", () => assert.equal(start.fnc, "joinGuide"))
  check("提示选择榜", () => assert.ok(last(start).includes("请选择要报名的榜")))

  const s1 = await answer("2", { user_id: "10002", card: "测试乙" })
  check("步骤推进：选榜 → 游戏名", () => {
    assert.equal(s1.fnc, "joinStep")
    assert.ok(last(s1).includes("原神游戏名"))
  })
  const s2 = await answer("乙的游戏名", { user_id: "10002", card: "测试乙" })
  check("步骤推进：游戏名 → 主播", () => assert.ok(last(s2).includes("请选择帮帮主播")))
  check("主播选项带序号", () => assert.ok(last(s2).includes("1. 阿修Axiu")))

  const bad = await answer("不存在的主播", { user_id: "10002", card: "测试乙" })
  check("非法主播被拦下并重问", () => {
    assert.ok(last(bad).includes("没匹配到主播"))
    assert.ok(last(bad).includes("阿修Axiu"))
  })

  const s3 = await answer("1", { user_id: "10002", card: "测试乙" })
  check("步骤推进：主播 → 难度", () => assert.ok(last(s3).includes("请选择难度及目标")))
  const ambiguous = await answer("绝境", { user_id: "10002", card: "测试乙" })
  check("歧义输入（绝境 → 两项）被要求重选", () => {
    assert.ok(last(ambiguous).includes("没匹配到难度"), last(ambiguous))
    assert.ok(last(ambiguous).includes("绝境(N6)180s"), "应列出候选")
  })
  const s4 = await answer("3", { user_id: "10002", card: "测试乙" })
  check("按序号选择难度成功", () => assert.ok(last(s4).includes("请选择账号强度"), last(s4)))
  const s5 = await answer("中配", { user_id: "10002", card: "测试乙" })
  check("步骤推进：强度 → 备注", () => assert.ok(last(s5).includes("请发送备注")))
  const s6 = await answer("无", { user_id: "10002", card: "测试乙" })
  check("确认摘要内容正确", () => {
    const text = last(s6)
    assert.ok(text.includes("请确认报名信息（幽境危战）"), text)
    assert.ok(text.includes("游戏名：乙的游戏名"))
    assert.ok(text.includes("主播：阿修Axiu"))
    assert.ok(text.includes("难度：绝境(N6)"))
    assert.ok(text.includes("强度：中配"))
  })
  const s7 = await answer("1", { user_id: "10002", card: "测试乙" })
  check("确认后写入成功", () => assert.ok(last(s7).includes("报名成功"), last(s7)))

  const rows = await readRows("幽境危战")
  check(`第 ${EMPTY} 行已写入引导流程数据`, () => {
    const row = rows.find(i => i.row === EMPTY)
    assert.ok(row)
    assert.equal(row.nickname, "测试乙")
    assert.equal(row.gameName, "乙的游戏名")
    assert.equal(row.anchor, "阿修Axiu")
    assert.equal(row.goal, "绝境(N6)")
    assert.equal(row.strength, "中配")
    assert.equal(row.note, "")
  })

  const cancelFlow = await say("#报名", { user_id: "10003", card: "测试丙" })
  check("第三个用户可独立开工", () => assert.equal(cancelFlow.fnc, "joinGuide"))
  const cancelled = await answer("取消", { user_id: "10003", card: "测试丙" })
  check("回复取消即退出流程", () => assert.ok(last(cancelled).includes("已取消报名")))
  const afterCancel = await answer("1", { user_id: "10003", card: "测试丙" })
  check("取消后上下文已清除", () => assert.equal(afterCancel.fnc, null))

  await say("#退队", { user_id: "10002", card: "测试乙" })
  const rowsEnd = await readRows("幽境危战")
  check("清理后回到基线人数", () => assert.equal(rowsEnd.length, baseCount["幽境危战"]))
}

console.log("\n【4】错误与边界")
{
  const badSheet = await say("#报名 不存在的榜 甲 阿修Axiu 无畏(N5) 低配")
  check("榜名错误给出可选榜", () => assert.ok(last(badSheet).includes("第一个参数要写榜名")))
  const fewArgs = await say("#报名 幽境危战 甲")
  check("参数不足给用法", () => assert.ok(last(fewArgs).includes("用法：#报名")))
  const badOption = await say("#报名 幽境危战 甲 阿修Axiu 打不过 低配")
  check("非法难度被拦下并列出候选", () => {
    assert.ok(last(badOption).includes("难度及目标「打不过」不在下拉选项中"), last(badOption))
    assert.ok(last(badOption).includes("绝境(N6)"))
    assert.ok(!last(badOption).includes("出错了"), "用户输入问题不应报成程序异常")
  })
  const ambiguousOption = await say("#报名 幽境危战 甲 阿修Axiu 绝境 低配")
  check("歧义难度提示按序号选择并列出两项", () => {
    assert.ok(last(ambiguousOption).includes("对应多个选项"), last(ambiguousOption))
    assert.ok(last(ambiguousOption).includes("绝境(N6)"))
    assert.ok(last(ambiguousOption).includes("绝境(N6)180s"))
  })
  const rows = await readRows("幽境危战")
  check("校验失败时未写入任何行", () => assert.equal(rows.length, baseCount["幽境危战"]))

  const emptyOption = await say("#报名 幽境危战 甲 阿修Axiu 「 」 低配")
  check("空选项提示不能为空", () => {
    assert.ok(last(emptyOption).includes("难度及目标不能为空"), last(emptyOption))
    assert.ok(!last(emptyOption).includes("出错了"), "不应报成程序异常")
  })

  const noNote = await say("#改备注")
  check("#改备注 无内容不匹配规则", () => assert.equal(noNote.fnc, null))
}

console.log("\n【5】主人清空（二次确认）")
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

console.log("\n【6】定时推送")
{
  const queueApp = APPS.find(C => (C.rule ?? []).some(r => String(r.fnc) === "pushQueue")) ?? APPS[0]
  const inst = Object.assign(new queueApp(), { e: makeEvent("#x"), __replies: [] })
  await inst.pushQueue()
  check("推送产生消息", () => assert.equal(sent.length, 1))
  check("推送目标群正确", () => assert.equal(sent[0].gid, 20000))
  check("推送内容含榜单与限流条数", () => {
    assert.ok(sent[0].msg.includes("【三路深渊排队】"))
    assert.ok(sent[0].msg.includes("【幽境危战】"))
    assert.ok(sent[0].msg.includes("还有"), "list_limit=3 应触发折叠提示")
  })
}

console.log("\n【7】原表格未被触碰")
{
  const after = await fs.readFile(SOURCE)
  check("源表格哈希未变", () => assert.equal(sha256(after), sourceHash))
}

finish()
console.log(`测试产物：${fixture}`)
