/**
 * 排队进度：完成判定、下一位、状态变化检测、月末判断
 *
 * 这三件事决定了「上一位完成后 @ 下一位」与「月末催办」会不会 @ 错人，所以单独验。
 * 用法：node test/progress.test.mjs
 */
import assert from "node:assert/strict"
import {
  detectCompletions,
  isDone,
  isLastDayOfMonth,
  isPending,
  nextPending,
  pendingBySheet,
  rowKey,
  snapshot,
} from "../lib/progress.js"
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

finish()
