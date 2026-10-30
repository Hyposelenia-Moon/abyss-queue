import assert from "node:assert/strict"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("清榜前核查判定")

const { precheckEvents } = await import("../components/cycle.js")
const { extraOf, judgeForGoal } = await import("../modules/check-done.js")
const { evaluateGoal } = await import("../modules/check-done.js")
const { resolvePlayer } = await import("../modules/check-done.js")

const at = s => new Date(s)
const event = (events, sheet, round) =>
  events.find(e => e.sheet === sheet && e.type === "verify" && e.round === round)

check("剧诗按每一行选的模式与目标判定", () => {
  const full = { mode_id: 5, star_medal: 12, round_count: 10 }
  assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满星章", full), true)
  assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满原石", full), true)
  assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满原石", { ...full, round_count: 9 }), false)
  assert.equal(judgeForGoal("幻想真境剧诗", "卓越模式满星章", { mode_id: 4, star_medal: 10 }), true)
  assert.equal(judgeForGoal("幻想真境剧诗", "困难模式满星章", { mode_id: 3, star_medal: 8 }), true)
  assert.equal(judgeForGoal("幻想真境剧诗", "困难模式满星章", { mode_id: 3, star_medal: 7 }), false)
  /** 旧写法不再认 */
  assert.equal(judgeForGoal("幻想真境剧诗", "月谕满花", full), false)
  assert.equal(judgeForGoal("幻想真境剧诗", "月谕满原石", full), false)
})

check("危战按 N 数与 180s 目标判定", () => {
  assert.equal(judgeForGoal("幽境危战", "绝境(N6)", { difficulty: 6, time_second: 999 }), true)
  assert.equal(judgeForGoal("幽境危战", "绝境(N6)180s", { difficulty: 6, time_second: 180 }), true)
  assert.equal(judgeForGoal("幽境危战", "绝境(N6)180s", { difficulty: 6, time_second: 181 }), false)
  assert.equal(judgeForGoal("幽境危战", "无畏(N5)", { difficulty: 5, time_second: 999 }), true)
  assert.equal(judgeForGoal("幽境危战", "无畏(N5)", { difficulty: 6, time_second: 100 }), true)
  assert.equal(judgeForGoal("幽境危战", "绝境(N6)", { difficulty: 5, time_second: 100 }), false)
})

check("深渊按目标层数判定", () => {
  assert.equal(judgeForGoal("深境螺旋", "第12层满星", { total_star: 36 }), true)
  assert.equal(judgeForGoal("深境螺旋", "第12层满星", { max_floor: "12-3", max_floor_star: 9 }), true)
  assert.equal(judgeForGoal("深境螺旋", "第12层满星", { max_floor: "11-3", max_floor_star: 9 }), false)
  assert.equal(judgeForGoal("深境螺旋", "第11层满星", { max_floor: "11-3", max_floor_star: 9 }), true)
  /** 旧写法不再认 */
  assert.equal(judgeForGoal("深境螺旋", "12层满星", { total_star: 36 }), false)
})

check("部分达成只播报、不填表", () => {
  assert.equal(evaluateGoal("幽境危战", "绝境(N6)", { difficulty: 5, time_second: 100 }).status, "partial")
  assert.equal(evaluateGoal("幽境危战", "绝境(N6)180s", { difficulty: 6, time_second: 220 }).status, "partial")
  assert.equal(evaluateGoal("幻想真境剧诗", "月谕模式满星章", { mode_id: 5, star_medal: 11 }).status, "partial")
  assert.equal(evaluateGoal("深境螺旋", "第12层满星", { max_floor: "11-3", max_floor_star: 9 }).status, "partial")
  assert.equal(evaluateGoal("幽境危战", "绝境(N6)", { difficulty: 6, time_second: 200 }).status, "achieved")
})

check("原始接口字段映射", () => {
  const drama = extraOf(1, {
    stat: { difficulty_id: 5, get_medal_round_list: Array(12).fill(1) },
    detail: { rounds_data: Array(10).fill({}) },
  })
  assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满星章", drama), true)
  assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满原石", drama), true)

  const hard = extraOf(2, { single: { best: { difficulty: 6, second: 180 } } })
  assert.equal(judgeForGoal("幽境危战", "绝境(N6)180s", hard), true)

  const abyss = extraOf(0, {
    max_floor: "12-3",
    total_star: 36,
    floors: [{ index: 11, star: 9 }, { index: 12, star: 9 }],
  })
  assert.equal(judgeForGoal("深境螺旋", "第12层满星", abyss), true)
})

check("玩家解析：绑定优先、归一化昵称、主播不充玩家", () => {
  const model = { anchors: [{ name: "主播甲" }] }
  const store = {
    qqsOf: () => ["10001"],
    get: () => ({ nickname: "甲" }),
  }
  const dir = new Map([["甲", "10001"], ["主播甲", "99999"]])
  assert.equal(resolvePlayer({ model, store, dir, sheet: "深境螺旋", row: 10, nickname: "甲" }).qq, "10001")

  const noBind = { qqsOf: () => [], get: () => null }
  assert.equal(resolvePlayer({ model, store: noBind, dir: new Map([["甲 ", "10002"]]), sheet: "深境螺旋", row: 10, nickname: "甲" }).qq, "10002")
  assert.equal(resolvePlayer({ model, store: noBind, dir, sheet: "深境螺旋", row: 10, nickname: "主播甲" }).kind, "missing")
  assert.equal(resolvePlayer({ model, store: noBind, dir, sheet: "深境螺旋", row: 10, nickname: "乙" }).kind, "missing")
  assert.equal(resolvePlayer({ model, store, dir: new Map([["别人", "10003"]]), sheet: "深境螺旋", row: 10, nickname: "甲" }).kind, "left")

  /** Map 覆盖了完全同名的一人，但 playerEntries 仍保留；可靠绑定不能因此被判退群 */
  const dupDir = new Map([["同名", "10002"]])
  dupDir.playerEntries = [["同名", "10001"], ["同名", "10002"]]
  const dupStore = { qqsOf: () => ["10001"], get: () => ({ nickname: "同名" }) }
  assert.equal(resolvePlayer({ model, store: dupStore, dir: dupDir, sheet: "深境螺旋", row: 10, nickname: "同名" }).qq, "10001")
  assert.equal(resolvePlayer({ model, store: noBind, dir: dupDir, sheet: "深境螺旋", row: 10, nickname: "同名" }).kind, "ambiguous")
})

check("核查窗口：清榜提醒前 1 小时，三榜各一次；枪战不参与", () => {
  const drama = precheckEvents(at("2026-10-31T11:30:00+08:00"))
  assert.ok(event(drama, "幻想真境剧诗", "2026-10"))
  assert.equal(precheckEvents(at("2026-10-31T10:59:00+08:00")).length, 0)
  assert.equal(precheckEvents(at("2026-10-31T12:00:00+08:00")).length, 0)

  const abyss = precheckEvents(at("2026-11-15T11:30:00+08:00"))
  assert.ok(event(abyss, "深境螺旋", "2026-11"))

  const stygian = precheckEvents(at("2026-11-02T11:30:00+08:00"))
  assert.ok(event(stygian, "幽境危战", "2026-09-30"))

  assert.equal(precheckEvents(at("2026-11-04T09:30:00+08:00")).some(e => e.sheet === "绝境攻炼"), false)
})

await finish()
