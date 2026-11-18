import { ensureEnv } from "./env.mjs"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createChecker, installFrameworkStubs } from "./_helper.mjs"

const { check, finish } = createChecker("直播刷新每日标记")
const ENV = await ensureEnv({ prefix: "abyss-live-tick-", cloud: false })
const { config } = await import("../components/config.js")
config.notify.enable = false
config.notify.groups = []
config.notify.monthly_enable = false
config.anchor_live.enable = true
config.anchor_live.push = false

const sent = installFrameworkStubs()
const { AbyssQueueQuery } = await import("../apps/queue.js")
const { liveStatus } = await import("../model/live-status.js")
const { tickTasks } = await import("../modules/notify.js")
const { localDayKey } = await import("../modules/progress.js")
const { cycleEvents } = await import("../components/cycle.js")
const { readJson, statePath, writeJson } = await import("../model/queue-state.js")
const at = new Date(2026, 10, 16, 12, 0)
const day = localDayKey(at)
const app = new AbyssQueueQuery()
let models
app.models = async () => new Map(models.map(model => [model.name, model]))
app.store = async () => ({})

const prepare = (name, rooms) => {
  models = [{
    name: "直播回归榜",
    rows: [],
    anchors: rooms.map(room => ({ name: `主播${room}`, entry: [`https://live.bilibili.com/${room}`] })),
  }]
  const { state } = tickTasks({ prev: null, models, now: at })
  state.daily = { monthly: day, roster: day, tidy: day }
  writeJson(statePath(), state)
  // tick 仍运行真实周期任务；预记当日事件可把本套限定在直播刷新。
  writeJson(path.join(ENV.dir, "cycle.json"), {
    done: Object.fromEntries(cycleEvents(at).map(event => [`${event.sheet}:${event.type}:${event.round}`, at.toISOString()])),
  })
  liveStatus.file = path.join(ENV.dir, `${name}.json`)
  liveStatus.state = null
  config.anchor_live.enable = true
}

let calls = 0
let failing = true
prepare("retry", [101])
liveStatus.fetchImpl = async (url, options) => {
  calls++
  if (failing) return { ok: true, json: async () => ({ code: -1, message: "offline fixture" }) }
  if (String(url).includes("get_info"))
    return { ok: true, json: async () => ({ code: 0, data: { uid: "101", room_id: "101", live_status: 0 } }) }
  const { uids } = JSON.parse(options.body)
  return { ok: true, json: async () => ({ code: 0, data: Object.fromEntries(uids.map(uid => [uid, { room_id: uid, live_status: 0 }])) }) }
}

await check("接口全部失败：真实 tick 不记当天刷新完成", async () => {
  await app.tick(at)
  assert.ok(calls > 0, "tick 没有实际请求直播接口")
  assert.notEqual(readJson(statePath()).daily.live, day, "接口失败仍写入 daily.live，下一次 tick 会失去当天强制重试")
})

await check("同日接口恢复：下一次 tick 重试成功后才记 daily.live", async () => {
  const before = calls
  failing = false
  await app.tick(new Date(at.getTime() + 3 * 60_000))
  assert.ok(calls > before, "接口恢复后没有绕过失败退避重试")
  assert.equal(readJson(statePath()).daily.live, day)
  assert.equal(liveStatus.load().rooms["101"].live, 0)
})

await check("部分入口失败：已有成功状态也不记整轮完成", async () => {
  prepare("partial", [201, 202])
  liveStatus.fetchImpl = async (url, options) => {
    if (String(url).includes("get_info")) {
      const room = new URL(url).searchParams.get("room_id")
      return { ok: true, json: async () => room === "202" ? { code: -1 } : { code: 0, data: { uid: room, room_id: room, live_status: 0 } } }
    }
    const { uids } = JSON.parse(options.body)
    return { ok: true, json: async () => ({ code: 0, data: Object.fromEntries(uids.map(uid => [uid, { room_id: uid, live_status: 0 }])) }) }
  }
  await app.tick(at)
  assert.equal(liveStatus.load().rooms["201"].live, 0)
  assert.notEqual(readJson(statePath()).daily.live, day, "只刷新了部分入口仍记成整轮完成")
})

await check("默认最多解析 10 个新房间：未覆盖的入口不记完成", async () => {
  prepare("limited", Array.from({ length: 11 }, (_, i) => 301 + i))
  let resolutions = 0
  assert.equal(liveStatus.maxResolve, 10)
  liveStatus.fetchImpl = async (url, options) => {
    if (String(url).includes("get_info")) {
      resolutions++
      const room = new URL(url).searchParams.get("room_id")
      return { ok: true, json: async () => ({ code: 0, data: { uid: room, room_id: room, live_status: 0 } }) }
    }
    const { uids } = JSON.parse(options.body)
    return { ok: true, json: async () => ({ code: 0, data: Object.fromEntries(uids.map(uid => [uid, { room_id: uid, live_status: 0 }])) }) }
  }
  await app.tick(at)
  assert.equal(resolutions, 10)
  assert.notEqual(readJson(statePath()).daily.live, day, "第 11 个房间未解析仍记成当天完成")
})

await check("关闭直播状态：tick 不请求接口、不写日标记、不发送消息", async () => {
  prepare("disabled", [401])
  config.anchor_live.enable = false
  let requests = 0
  liveStatus.fetchImpl = async () => { requests++; throw new Error("关闭后不应发起请求") }
  await app.tick(at)
  assert.equal(requests, 0)
  assert.notEqual(readJson(statePath()).daily.live, day)
  assert.equal(sent.length, 0)
})

await finish()
fs.rmSync(ENV.dir, { recursive: true, force: true })
