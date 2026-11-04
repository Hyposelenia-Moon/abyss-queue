/**
 * 开榜提醒去重：同一周期只发一次
 *
 * 现场问题：榜里排队的人清空后 `open` 会从 true 变 false，重新有人排队又变 true；
 * 旧逻辑只看 boolean 翻转，就会在同一周期反复发开榜提醒。
 *
 * 这里直接测纯函数 `tickTasks()`，不碰表格与消息：只验 `openNow` 与状态里的
 * `openNotified` 周期标记。
 */
import assert from "node:assert/strict"
import { createChecker } from "./_helper.mjs"
import { QUEUED } from "../modules/progress.js"
import { tickTasks } from "../modules/notify.js"

const { check, finish } = createChecker("开榜提醒去重")

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

finish()
