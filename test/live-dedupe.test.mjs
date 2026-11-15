import { ensureEnv } from "./env.mjs"
/**
 * 开播提醒单场去重回归
 *
 * 只验证 `LiveStatus` 的事件基线/pending，以及 `notifyAnchorLive` 的多榜合并口径：
 *   - 同一场连续刷新只产生一次事件；
 *   - pending 重启后仍在，且不会重复旧场次；
 *   - 下播后再开播允许再次提醒；
 *   - 同一主播在多榜只发一条群消息；
 *   - 并发 refresh 不产生重复事件。
 */
import assert from "node:assert/strict"
import path from "node:path"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("开播去重")
const ENV = await ensureEnv({ prefix: "abyss-live-dedupe-" })
const { config } = await import("../components/config.js")
const { LiveStatus } = await import("../model/live-status.js")
const { notifyAnchorLive } = await import("../modules/anchor-live.js")
const { setLiveAlert } = await import("../model/live-alerts.js")

config.anchorLivePath = path.join(ENV.dir, "anchor-live.json")
config.liveAlertsPath = path.join(ENV.dir, "live-alerts.json")
config.anchor_live.enable = true
config.anchor_live.push = true

const ROOM = "1960"
const UID = "100"
const modelOf = name => ({
  name,
  anchors: [{ name: "阿修Axiu", recommend: "", skills: "", duty: "", entry: [`B站https://live.bilibili.com/${ROOM}`] }],
  rows: [{ row: 10, nickname: "甲", anchor: "阿修Axiu", status: "排队中" }],
})

const fakeLive = file => {
  const box = { live: 0, calls: 0 }
  const fetchImpl = async (url, opts) => {
    box.calls++
    if (String(url).includes("get_info"))
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { uid: UID, room_id: ROOM, live_status: box.live } }) }
    if (String(url).includes("get_status_info_by_uids")) {
      const body = JSON.parse(opts.body)
      const data = Object.fromEntries(body.uids.map(uid => [String(uid), { room_id: ROOM, live_status: box.live }]))
      return { ok: true, status: 200, json: async () => ({ code: 0, data }) }
    }
    throw new Error(`unexpected ${url}`)
  }
  return { box, live: new LiveStatus({ file, fetchImpl, now: () => 1_000, ttl: 1_000, stale: 600_000 }) }
}

console.log("【1】同一场连续刷新只产生一次事件")
{
  const file = path.join(ENV.dir, "dedupe-same.json")
  const { box, live } = fakeLive(file)
  const models = [modelOf("幻想真境剧诗")]
  await check("基线不产生事件", async () => {
    assert.deepEqual(await live.refresh(models, 1_000), [])
  })
  await check("开播只产生一次，后续 tick 不重复", async () => {
    box.live = 1
    const first = await live.refresh(models, 61_000)
    assert.equal(first.length, 1)
    const second = await live.refresh(models, 62_000)
    assert.deepEqual(second, [])
    assert.deepEqual(live.takePending().map(e => e.roomId), [ROOM])
    assert.deepEqual(live.takePending(), [])
  })
}

console.log("\n【2】pending 重启不丢、不重复旧场次")
{
  const file = path.join(ENV.dir, "dedupe-restart.json")
  const { box, live } = fakeLive(file)
  const models = [modelOf("幻想真境剧诗")]
  await live.refresh(models, 1_000)
  box.live = 1
  assert.equal((await live.refresh(models, 61_000)).length, 1)
  const restarted = fakeLive(file).live
  await check("重启后 pending 还在", () => {
    assert.deepEqual(restarted.takePending().map(e => e.roomId), [ROOM])
    assert.deepEqual(restarted.takePending(), [])
  })
  await check("重启后仍在播，不补发旧场次", async () => {
    assert.deepEqual(await restarted.refresh(models, 62_000), [])
  })
}

console.log("\n【3】下播后重新开播可以再提醒")
{
  const file = path.join(ENV.dir, "dedupe-reopen.json")
  const { box, live } = fakeLive(file)
  const models = [modelOf("幻想真境剧诗")]
  await live.refresh(models, 1_000)
  box.live = 1
  assert.equal((await live.refresh(models, 61_000)).length, 1)
  live.takePending()
  box.live = 0
  await live.refresh(models, 62_000, { force: true })
  box.live = 1
  await check("再次开播产生新事件", async () => {
    assert.equal((await live.refresh(models, 63_000, { force: true })).length, 1)
    assert.deepEqual(live.takePending().map(e => e.roomId), [ROOM])
  })
}

console.log("\n【4】同一主播多榜只发一条群消息")
{
  const models = [modelOf("幻想真境剧诗"), modelOf("幽境危战")]
  const status = { roomOf: e => (String(e?.roomId) === ROOM ? ROOM : "") }
  const store = { qqsOf: () => ["20001"], get: () => ({ row: 10, nickname: "甲" }) }
  const directory = async () => new Map([["甲", "20001"]])
  const sent = []
  const send = async (groups, msg) => sent.push({ groups, msg })
  setLiveAlert("20001", true)
  await check("两榜命中同一直播间，send 只调用一次", async () => {
    const n = await notifyAnchorLive([{ roomId: ROOM }], models, { groups: [20000], store, status, directory, send })
    assert.equal(n, 1)
    assert.equal(sent.length, 1)
    const text = JSON.stringify(sent[0].msg)
    assert.ok(text.includes("幻想真境剧诗") && text.includes("幽境危战"), text)
  })
  setLiveAlert("20001", false)
}

console.log("\n【5】并发 refresh 不产生重复事件")
{
  const file = path.join(ENV.dir, "dedupe-concurrent.json")
  const { box, live } = fakeLive(file)
  const models = [modelOf("幻想真境剧诗")]
  await live.refresh(models, 1_000)
  box.live = 1
  await check("两次并发只留一个 pending", async () => {
    const [a, b] = await Promise.all([live.refresh(models, 61_000), live.refresh(models, 61_000)])
    assert.ok(a.length <= 1 && b.length <= 1)
    assert.deepEqual(live.takePending().map(e => e.roomId), [ROOM])
    assert.deepEqual(live.takePending(), [])
  })
}

await ENV.cloud?.close()
await finish()
