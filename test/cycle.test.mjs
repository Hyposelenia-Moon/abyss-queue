import assert from "node:assert/strict"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("分榜清榜周期")

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
