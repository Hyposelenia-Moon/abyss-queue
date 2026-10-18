/**
 * 排队进度：完成判定、下一位、状态变化检测、月末判断
 *
 * 这三件事决定了「上一位完成后 @ 下一位」与「月末催办」会不会 @ 错人，所以单独验。
 * 用法：node test/progress.test.mjs
 */
import assert from "node:assert/strict"
import {
  detectCompletions,
  detectReverts,
  isDone,
  isLastDayOfMonth,
  isPending,
  nextPending,
  pendingBySheet,
  rowKey,
  snapshot,
  snapshotShape,
  statusLabel,
} from "../modules/progress.js"
import { tickTasks } from "../modules/notify.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("排队进度")

/** 造一张榜：rows 里给「昵称 / 状态」 */
const sheet = (name, rows) => ({
  name,
  rows: rows.map(([nickname, status], i) => ({ row: 20 + i, seq: String(i + 1), nickname, status })),
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

check("结构指纹：按行序记每榜的群昵称（空行不算）", () => {
  const shape = snapshotShape([yw, deep])
  assert.deepEqual(shape["幽境危战"], ["甲", "乙", "丙", "丁", "戊"])
  assert.deepEqual(shape["深境螺旋"], ["甲", "乙"])
})

/**
 * 2026-10-18 审核 P2：行位移 ≠ 有人完成了
 *
 * `snapshot()` 按 `榜#行号` 存；插一行（成员整体下移）之后，同一个行号键上换了人，
 * `detectCompletions` 就会把**早就完成过的人**再报一次"刚刚完成"。
 * `tickTasks` 因此先比结构指纹：结构变了这一轮不判完成，只更新基线。
 */
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
  /**
   * 模拟"主播插了一行"：前面多一个人（第 20 行），所有人下移一格，**状态一个都没改**
   * 若不比结构指纹，行号 21 上会从"乙(排队中)"变成"甲(已完成)"⇒ 误报甲刚完成
   */
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

check("结构闸：老状态文件没有 shape（升级后首跑）⇒ 这一轮只记基线、不判完成", () => {
  const old = { rows: {}, open: {}, daily: {}, at: 0 }
  const now = sheet("幽境危战", [["甲", "本人已完成"], ["乙", "排队中"]])
  const r = tickTasks({ prev: old, models: [now], now: TICK_NOW, cfg: TICK_CFG })
  assert.deepEqual(r.completions, [])
  assert.deepEqual(r.state.shape["幽境危战"], ["甲", "乙"])
})

await finish()
