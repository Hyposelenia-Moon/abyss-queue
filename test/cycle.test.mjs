/** 清榜：cycle / open-reminder / progress 合并成一个套件（原文件见 git 历史） */
import assert from "node:assert/strict"
import { QUEUED } from "../modules/progress.js"
import { tickTasks } from "../modules/notify.js"
import { detectCompletions, detectReverts, isDone, isLastDayOfMonth, isPending, nextPending, pendingBySheet, rowKey, snapshot, snapshotShape, statusLabel } from "../modules/progress.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("清榜")

await (async () => {
  const {
    attackCycle,
    cycleEvents,
    dramaCycle,
    fmt,
    phaseOf,
    SHEET_ABYSS,
    SHEET_ATTACK,
    SHEET_DRAMA,
    SHEET_STYGIAN,
    stygianCycle,
  } = await import("../components/cycle.js")
  const at = s => new Date(s)
  const has = (events, sheet, type, time) =>
    events.some(e => e.sheet === sheet && e.type === type && fmt(e.at) === time)
  check("剧诗：当月最后一天 12 点提醒，次月 1 日 4 点清榜", () => {
    const before = cycleEvents(at("2026-10-30T12:00:00+08:00"))
    assert.ok(!has(before, SHEET_DRAMA, "reminder", "2026-10-31 12:00"))
    assert.ok(has(cycleEvents(at("2026-10-31T12:00:00+08:00")), SHEET_DRAMA, "reminder", "2026-10-31 12:00"))
    assert.ok(has(cycleEvents(at("2026-11-01T04:00:00+08:00")), SHEET_DRAMA, "clear", "2026-11-01 04:00"))
    const d = dramaCycle(at("2026-10-27T12:00:00+08:00"))
    assert.equal(fmt(d.nextClear), "2026-11-01 04:00")
    assert.equal(fmt(d.reminder), "2026-10-31 12:00")
  })
  check("深渊：15 日 12 点提醒，16 日 4 点清榜", () => {
    assert.ok(has(cycleEvents(at("2026-11-15T12:00:00+08:00")), SHEET_ABYSS, "reminder", "2026-11-15 12:00"))
    assert.ok(has(cycleEvents(at("2026-11-16T04:00:00+08:00")), SHEET_ABYSS, "clear", "2026-11-16 04:00"))
    assert.equal(phaseOf(SHEET_ABYSS, at("2026-11-10T12:00:00+08:00")), "waiting")
    assert.equal(phaseOf(SHEET_ABYSS, at("2026-11-16T04:00:00+08:00")), "queued")
  })
  check("危战：9/30、11/11、12/23 的 42 天周期", () => {
    const a = stygianCycle(at("2026-10-27T12:00:00+08:00"))
    assert.equal(fmt(a.clear), "2026-11-03 04:00")
    assert.equal(fmt(a.nextStart), "2026-11-11 10:00")
    assert.ok(has(cycleEvents(at("2026-11-02T12:00:00+08:00")), SHEET_STYGIAN, "reminder", "2026-11-02 12:00"))
    assert.ok(has(cycleEvents(at("2026-11-03T04:00:00+08:00")), SHEET_STYGIAN, "clear", "2026-11-03 04:00"))
    assert.ok(has(cycleEvents(at("2026-11-11T10:00:00+08:00")), SHEET_STYGIAN, "start", "2026-11-11 10:00"))
    const b = stygianCycle(at("2026-11-11T10:00:00+08:00"))
    assert.equal(fmt(b.clear), "2026-12-15 04:00")
    assert.equal(fmt(b.nextStart), "2026-12-23 10:00")
    assert.equal(phaseOf(SHEET_STYGIAN, at("2026-11-03T04:00:00+08:00")), "waiting")
    assert.equal(phaseOf(SHEET_STYGIAN, at("2026-11-11T10:00:00+08:00")), "queued")
  })
  check("枪战：11/4、12/16 版更，前一天 12 点提醒", () => {
    const a = attackCycle(at("2026-10-27T12:00:00+08:00"))
    assert.equal(fmt(a.nextStart), "2026-11-04 10:00")
    assert.equal(fmt(a.reminder), "2026-11-03 12:00")
    assert.ok(has(cycleEvents(at("2026-11-03T12:00:00+08:00")), SHEET_ATTACK, "reminder", "2026-11-03 12:00"))
    assert.ok(has(cycleEvents(at("2026-11-04T10:00:00+08:00")), SHEET_ATTACK, "update", "2026-11-04 10:00"))
    assert.ok(has(cycleEvents(at("2026-12-15T12:00:00+08:00")), SHEET_ATTACK, "reminder", "2026-12-15 12:00"))
    assert.ok(has(cycleEvents(at("2026-12-16T10:00:00+08:00")), SHEET_ATTACK, "update", "2026-12-16 10:00"))
  })
  await finish()
})()

await (async () => {
  const SHEET = "幻想真境剧诗"
  const D1 = new Date(2026, 9, 20, 12, 0, 0)
  const D2 = new Date(2026, 10, 2, 12, 0, 0)
  const row = (nickname, n = 1) => ({ row: n, seq: String(n), nickname, status: QUEUED })
  const model = rows => ({ name: SHEET, rows })
  let prev = null
  let out = tickTasks({ prev, models: [model([row("甲")])], now: D1 })
  check("首轮只记基线，不发开榜提醒", () => assert.deepEqual(out.openNow, []))
  check("状态里记下本周期已提醒的 key", () => {
    assert.ok(out.state.openNotified?.[SHEET], JSON.stringify(out.state.openNotified))
  })
  const key = out.state.openNotified[SHEET]
  /* 队列清空：日历上剧诗仍然算开启，open 保持 true；不能因为没人排队就清掉已提醒标记 */
  out = tickTasks({ prev: out.state, models: [model([])], now: D1 })
  check("同一周期队列清空：不发开榜提醒", () => assert.deepEqual(out.openNow, []))
  check(
    "清空后周期标记仍在",
    () => assert.equal(out.state.openNotified?.[SHEET], key),
  )
  /* 重新有人排队：open 仍是 true，旧逻辑不会发；但即便 open 被清成 false 又回 true，也不能补发 */
  out = tickTasks({ prev: out.state, models: [model([row("乙")])], now: D1 })
  check("同一周期重新排队：不发开榜提醒", () => assert.deepEqual(out.openNow, []))
  check(
    "重新排队后周期标记不变",
    () => assert.equal(out.state.openNotified?.[SHEET], key),
  )
  /* 进入下一个周期：key 变了，应该重新提醒一次 */
  out = tickTasks({ prev: out.state, models: [model([row("丙")])], now: D2 })
  check("跨周期后重新提醒一次", () => assert.deepEqual(out.openNow, [SHEET]))
  /* 升级场景：老状态里 open=true、没有 openNotified，不能补发 */
  const legacy = {
    rows: {},
    shape: {},
    open: { [SHEET]: true },
    daily: {},
    at: D1.getTime(),
  }
  out = tickTasks({ prev: legacy, models: [model([row("丁")])], now: D1 })
  check("老状态升级当天不补发开榜提醒", () => assert.deepEqual(out.openNow, []))
  check(
    "老状态升级时补记当前周期 key",
    () => assert.ok(out.state.openNotified?.[SHEET]),
  )
})()

await (async () => {
  /** 造一张榜：rows 里给「昵称 / 状态」；`start` 是从第几行开始（模拟表格行号位移用） */
  const sheet = (name, rows, start = 20) => ({
    name,
    rows: rows.map(([nickname, status], i) => ({ row: start + i, seq: String(i + 1), nickname, status })),
  })
  const yw = sheet("幽境危战", [
    ["甲", "本人已完成"],
    ["乙", "排队中"],
    ["丙", "阿修Axiu"],
    ["丁", "排队中"],
    ["戊", ""],
  ])
  const deep = sheet("深境螺旋", [
    ["甲", "等待开启"],
    ["乙", "等待开启"],
  ])
  check("完成判定：只有「排队中」「等待开启」和空不算完成", () => {
    assert.equal(isDone("排队中"), false)
    assert.equal(isDone("等待开启"), false)
    assert.equal(isDone(""), false)
    assert.equal(isDone("   "), false)
    assert.equal(isDone("本人已完成"), true)
    assert.equal(isDone("阿修Axiu"), true)
    assert.equal(isDone("阿修Axiu,听雨"), true)
  })
  check("排队判定：等待开启的人不算在排队", () => {
    assert.equal(isPending("排队中"), true)
    assert.equal(isPending(""), true)
    assert.equal(isPending("等待开启"), false)
    assert.equal(isPending("本人已完成"), false)
    assert.equal(isPending("阿修Axiu"), false)
  })
  check("下一位：从他后面开始找，跳过已完成的人", () => {
    /** 甲（行 20）完成 → 下一位是乙 */
    assert.equal(nextPending(yw, 20).nickname, "乙")
    /** 丙（行 22）完成 → 乙已完成，下一位是丁 */
    assert.equal(nextPending(yw, 22).nickname, "丁")
    /** 传入的那一行自己不算"下一位" */
    assert.equal(nextPending(yw, 21).nickname, "丁")
  })
  check("下一位：后面没人了返回 null", () => {
    assert.equal(nextPending(yw, 24), null)
    assert.equal(nextPending(deep, 20), null)
  })
  check("下一位：整理前在队尾、整理后会排到表头的场景，wrap 回到第一个排队中", () => {
    /** 戊在队尾且已完成；每日整理会把他挪到最前面，下一位应为表头第一个排队中的乙 */
    assert.equal(nextPending(yw, 24, { wrap: true }).nickname, "乙")
    /** 确实一个排队中都没有时不硬凑 */
    assert.equal(nextPending(deep, 20, { wrap: true }), null)
  })
  check("下一位：行号对不上时返回 null", () => {
    assert.equal(nextPending(yw, 999), null)
  })
  check("快照：等待开启不算完成，也不当排队", () => {
    const snap = snapshot([yw, deep])
    assert.equal(snap[rowKey("幽境危战", 20)].done, true)
    assert.equal(snap[rowKey("深境螺旋", 20)].done, false)
    assert.equal(snap[rowKey("深境螺旋", 20)].status, "等待开启")
  })
  check("变化检测：只认「上次没完成 → 这次完成」", () => {
    const prev = snapshot([yw])
    const next = snapshot([sheet("幽境危战", [
      ["甲", "本人已完成"],
      ["乙", "本人已完成"],
      ["丙", "阿修Axiu"],
      ["丁", "排队中"],
      ["戊", ""],
    ])])
    const done = detectCompletions(prev, next)
    assert.equal(done.length, 1)
    assert.equal(done[0].nickname, "乙")
    assert.equal(done[0].sheet, "幽境危战")
  })
  check("变化检测：状态没变不通知", () => {
    const snap = snapshot([yw])
    assert.deepEqual(detectCompletions(snap, snap), [])
  })
  check("变化检测：新加的行即使已经是完成状态也不通知", () => {
    const prev = snapshot([yw])
    const next = snapshot([
      sheet("幽境危战", [
        ["甲", "本人已完成"],
        ["乙", "排队中"],
        ["丙", "阿修Axiu"],
        ["丁", "排队中"],
        ["戊", ""],
        ["己", "本人已完成"],
      ]),
    ])
    assert.deepEqual(detectCompletions(prev, next), [])
  })
  check("变化检测：从完成改回排队中再完成，会再通知一次", () => {
    const done = snapshot([sheet("幽境危战", [["乙", "本人已完成"]])])
    const back = snapshot([sheet("幽境危战", [["乙", "排队中"]])])
    const again = snapshot([sheet("幽境危战", [["乙", "本人已完成"]])])
    assert.deepEqual(detectCompletions(done, back), [])
    assert.equal(detectCompletions(back, again).length, 1)
  })
  check("变化检测：**已完成 → 排队中** 单独认出来（补充播报用），变回「等待开启」不算", () => {
    const done = snapshot([sheet("幽境危战", [["乙", "本人已完成"]])])
    const back = snapshot([sheet("幽境危战", [["乙", "排队中"]])])
    const waiting = snapshot([sheet("幽境危战", [["乙", "等待开启"]])])
    /** 还是完成（换了个完成人）不算"被改回排队" */
    const stillDone = snapshot([sheet("幽境危战", [["乙", "阿修Axiu"]])])
    const hits = detectReverts(done, back)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].nickname, "乙")
    assert.equal(hits[0].status, "排队中")
    assert.deepEqual(detectReverts(done, waiting), [], "「等待开启」不是重新排队")
    assert.deepEqual(detectReverts(done, stillDone), [], "还是完成不算")
    assert.deepEqual(detectReverts(back, done), [], "反过来是完成播报的事")
  })
  check("月末催办：只催还在排队的人", () => {
    const list = pendingBySheet([yw, deep])
    assert.equal(list.length, 1, "等待开启的榜不该被催")
    assert.equal(list[0].sheet, "幽境危战")
    assert.deepEqual(
      list[0].rows.map(r => r.nickname),
      ["乙", "丁", "戊"],
    )
  })
  check("月末判断：只看是不是当月最后一天", () => {
    assert.equal(isLastDayOfMonth(new Date(2026, 9, 31)), true)
    assert.equal(isLastDayOfMonth(new Date(2026, 9, 30)), false)
    assert.equal(isLastDayOfMonth(new Date(2026, 1, 28)), true, "2026 年 2 月只有 28 天")
    assert.equal(isLastDayOfMonth(new Date(2028, 1, 29)), true, "2028 年 2 月有 29 天")
    assert.equal(isLastDayOfMonth(new Date(2028, 1, 28)), false)
    assert.equal(isLastDayOfMonth(new Date(2026, 11, 31)), true)
  })
  check("显示：「本人已完成」按该行的群昵称显示", () => {
    assert.equal(statusLabel("本人已完成", "甲"), "甲")
    assert.equal(statusLabel("阿修Axiu,本人已完成", "甲"), "阿修Axiu,甲")
    assert.equal(statusLabel("本人已完成", ""), "本人已完成", "没有昵称时保持原样")
    assert.equal(statusLabel("排队中", "甲"), "排队中", "其它状态不动")
    assert.equal(statusLabel("", "甲"), "")
  })
  check("结构指纹：按行序记每榜的「行号:群昵称」（空行不算）", () => {
    const shape = snapshotShape([yw, deep])
    assert.deepEqual(shape["幽境危战"], ["20:甲", "21:乙", "22:丙", "23:丁", "24:戊"])
    assert.deepEqual(shape["深境螺旋"], ["20:甲", "21:乙"])
  })
  // 2026-10-18 审核 P2：行位移 ≠ 有人完成了
  const TICK_CFG = { rosterAt: "05:00", monthlyAt: "23:00", monthlyEnable: false }
  const TICK_NOW = new Date(2026, 9, 20, 12, 0, 0)
  check("结构闸：插一行导致行位移时这一轮不报完成，基线跟上后真完成照常报", () => {
    /** 首轮：只记基线 */
    const base = tickTasks({ prev: null, models: [sheet("幽境危战", [["甲", "排队中"], ["乙", "排队中"]])], now: TICK_NOW, cfg: TICK_CFG }).state
    /** 结构没变：甲完成 ⇒ 正常报一条 */
    const done = sheet("幽境危战", [["甲", "本人已完成"], ["乙", "排队中"]])
    const r1 = tickTasks({ prev: base, models: [done], now: TICK_NOW, cfg: TICK_CFG })
    assert.equal(r1.completions.length, 1, "结构没变时应当正常报完成")
    assert.equal(r1.completions[0].nickname, "甲")
    // 模拟"主播插了一行"：前面多一个人（第 20 行），所有人下移一格，**状态一个都没改**
    const shifted = sheet("幽境危战", [["新主播", ""], ["甲", "本人已完成"], ["乙", "排队中"]])
    const r2 = tickTasks({ prev: r1.state, models: [shifted], now: TICK_NOW, cfg: TICK_CFG })
    assert.deepEqual(r2.completions, [], "结构变了（行位移）不该报完成")
    /** 基线已跟上：下一轮结构没变，乙真完成时照常报（而且报的是乙，不是被挪动的甲） */
    const r3 = tickTasks({
      prev: r2.state,
      models: [sheet("幽境危战", [["新主播", ""], ["甲", "本人已完成"], ["乙", "本人已完成"]])],
      now: TICK_NOW,
      cfg: TICK_CFG,
    })
    assert.equal(r3.completions.length, 1)
    assert.equal(r3.completions[0].nickname, "乙")
  })
  // 2026-10-23 复审 P2：主播区插行 = **表头上方**多一行，成员整体下移，昵称序列一个都不差
  check("结构闸：主播区插一行（昵称序列不变、只挪行号）不报完成，基线跟上后按新行号照常报", () => {
    /** 基线：甲已完成、乙排队中、丙已完成 —— 位移后 21 号键会从乙换成甲、22 号键会从丙换成乙 */
    const base = tickTasks({
      prev: null,
      models: [sheet("幽境危战", [["甲", "本人已完成"], ["乙", "排队中"], ["丙", "阿修Axiu"]])],
      now: TICK_NOW,
      cfg: TICK_CFG,
    }).state
    /** 主播区插一行：成员整体下移一格，昵称 / 状态一个都没改 */
    const shifted = sheet("幽境危战", [["甲", "本人已完成"], ["乙", "排队中"], ["丙", "阿修Axiu"]], 21)
    const r = tickTasks({ prev: base, models: [shifted], now: TICK_NOW, cfg: TICK_CFG })
    assert.deepEqual(r.completions, [], "行号位移不该报完成（旧 21 号键上换成了甲）")
    assert.deepEqual(r.reverts, [], "行号位移也不该报「已完成 → 排队中」（旧 22 号键上换成了乙）")
    /** 基线已跟上：乙在新行号上真正完成，报的必须是乙、行号也是新的 */
    const next = tickTasks({
      prev: r.state,
      models: [sheet("幽境危战", [["甲", "本人已完成"], ["乙", "本人已完成"], ["丙", "阿修Axiu"]], 21)],
      now: TICK_NOW,
      cfg: TICK_CFG,
    })
    assert.equal(next.completions.length, 1)
    assert.equal(next.completions[0].nickname, "乙")
    assert.equal(next.completions[0].row, 22)
  })
  check("结构闸：同一轮里完成 + 整理搬行，仍按群昵称报出完成与下一位", () => {
    const base = tickTasks({
      prev: null,
      models: [sheet("幽境危战", [["甲", "排队中"], ["乙", "排队中"]])],
      now: TICK_NOW,
      cfg: TICK_CFG,
    }).state
    /** 每日整理把乙挪到前面，同时乙这一轮变成完成：行号全换了，人没换 */
    const moved = sheet("幽境危战", [["乙", "本人已完成"], ["甲", "排队中"]])
    const r = tickTasks({ prev: base, models: [moved], now: TICK_NOW, cfg: TICK_CFG })
    assert.equal(r.completions.length, 1, "按昵称对上乙之后仍要报完成")
    assert.equal(r.completions[0].nickname, "乙")
    assert.equal(nextPending(moved, r.completions[0].row).nickname, "甲", "下一位按新行号找")
  })
  check("结构闸：整理搬行但没人完成时，不因行号变化误报", () => {
    const base = tickTasks({
      prev: null,
      models: [sheet("幽境危战", [["甲", "排队中"], ["乙", "排队中"]])],
      now: TICK_NOW,
      cfg: TICK_CFG,
    }).state
    const moved = sheet("幽境危战", [["乙", "排队中"], ["甲", "排队中"]])
    const r = tickTasks({ prev: base, models: [moved], now: TICK_NOW, cfg: TICK_CFG })
    assert.deepEqual(r.completions, [])
    assert.deepEqual(r.reverts, [])
  })
  check("结构闸：老状态文件没有 shape（升级后首跑）⇒ 这一轮只记基线、不判完成", () => {
    const old = { rows: {}, open: {}, daily: {}, at: 0 }
    const now = sheet("幽境危战", [["甲", "本人已完成"], ["乙", "排队中"]])
    const r = tickTasks({ prev: old, models: [now], now: TICK_NOW, cfg: TICK_CFG })
    assert.deepEqual(r.completions, [])
    assert.deepEqual(r.state.shape["幽境危战"], ["20:甲", "21:乙"])
  })
  await finish()
})()

finish()
