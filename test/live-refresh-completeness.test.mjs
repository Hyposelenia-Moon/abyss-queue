import { ensureEnv } from "./env.mjs"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("直播刷新完整性")
const ENV = await ensureEnv({ prefix: "abyss-live-completeness-", cloud: false })
const { LiveStatus, refsOf } = await import("../model/live-status.js")
const { parseEntry } = await import("../components/live-entry.js")
const NOW = Date.parse("2026-11-16T09:00:00Z")
const reply = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) })
const modelsOf = count => [{ name: "测试榜", anchors: Array.from({ length: count }, (_, i) => ({
  name: `主播${i + 1}`, entry: [`https://live.bilibili.com/${101 + i}`],
})) }]

/** 接口响应与时钟可变，所有状态读写仍由真实 LiveStatus 完成。 */
function fixture(name, count = 9) {
  const server = { at: NOW, live: 0, batch: "full", failedRooms: new Set(), calls: [] }
  const file = path.join(ENV.dir, `${name}.json`)
  const live = new LiveStatus({ file, now: () => server.at, fetchImpl: async (url, options) => {
    server.calls.push(String(url))
    if (String(url).includes("get_info?")) {
      const roomId = new URL(url).searchParams.get("room_id")
      if (server.failedRooms.has(roomId)) return { ok: false, status: 503 }
      return reply({ room_id: roomId, uid: String(Number(roomId) + 1000), live_status: server.live })
    }
    if (server.batch === "fail") return { ok: false, status: 412 }
    const { uids } = JSON.parse(options.body)
    const returned = server.batch === "partial" ? uids.slice(0, 1) : uids
    return reply(Object.fromEntries(returned.map(uid => [uid, { room_id: String(uid - 1000), live_status: server.live }])))
  } })
  return { file, live, server, models: modelsOf(count) }
}

await check("九位主播全部刷新，旧 refresh 保留数组返回值", async () => {
  const { live, server, models } = fixture("all")
  const result = await live.refreshDetailed(models, new Date(server.at), { force: true })
  assert.deepEqual(result, { started: [], total: 9, refreshed: 9, failed: 0, skipped: 0 })
  assert.equal(refsOf(models).filter(ref => live.lookup(ref)).length, 9)
  assert.ok(Array.isArray(await live.refresh(models, server.at)))
})

await check("批量只返回一位，其余八位由房间查询补齐", async () => {
  const { live, server, models } = fixture("partial")
  await live.refresh(models, server.at)
  server.at += 4 * 60_000
  server.live = 1
  server.batch = "partial"
  server.calls = []
  const result = await live.refreshDetailed(models, server.at, { force: true })
  assert.equal(result.refreshed, 9)
  assert.equal(result.failed, 0)
  assert.equal(result.started.length, 9)
  assert.equal(server.calls.filter(url => url.includes("get_info?")).length, 8)
  assert.equal(refsOf(models).filter(ref => live.lookup(ref)?.state === "live").length, 9)
})

await check("批量失败但房间接口可用，所有旧房间更新", async () => {
  const { live, server, models } = fixture("batch-failure")
  await live.refresh(models, server.at)
  server.at += 4 * 60_000
  server.live = 1
  server.batch = "fail"
  server.calls = []
  await live.refresh(models, server.at, { force: true })
  assert.equal(refsOf(models).filter(ref => live.lookup(ref)?.state === "live").length, 9)
  assert.equal(server.calls.filter(url => url.includes("get_info?")).length, 9)
})

await check("所有接口失败保留旧值和成功时间，完整性结果报告失败", async () => {
  const { live, server, models } = fixture("all-failure")
  await live.refresh(models, server.at)
  server.at += 4 * 60_000
  server.batch = "fail"
  for (const ref of refsOf(models)) server.failedRooms.add(ref.roomId)
  const result = await live.refreshDetailed(models, server.at, { force: true })
  assert.deepEqual(result, { started: [], total: 9, refreshed: 0, failed: 9, skipped: 0 })
  for (const ref of refsOf(models)) {
    assert.equal(live.lookup(ref).label, "未开播")
    assert.equal(live.lookup(ref).checkedAt, NOW)
  }
})

await check("Date 输入写入毫秒，重启后继续命中缓存", async () => {
  const { live, server, file, models } = fixture("date", 1)
  await live.refresh(models, new Date(server.at))
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(raw.rooms["101"].checkedAt, NOW)
  const restarted = new LiveStatus({ file, now: () => NOW + 1000 })
  assert.equal(restarted.lookup(parseEntry("https://live.bilibili.com/101")).label, "未开播")
  const failure = fixture("date-failure", 1)
  failure.server.failedRooms.add("101")
  await failure.live.refresh(failure.models, new Date(NOW))
  assert.equal(JSON.parse(fs.readFileSync(failure.file, "utf8")).rooms["101"].failedAt, NOW)
})

await check("旧 ISO 缓存保留直播状态并正确应用 TTL 和失败退避", async () => {
  const { live, file, server, models } = fixture("iso", 2)
  fs.writeFileSync(file, JSON.stringify({ initialized: true, rooms: {
    101: { uid: "1101", live: 1, checkedAt: new Date(NOW - 1000).toISOString(), failedAt: 0 },
    102: { failedAt: new Date(NOW - 1000).toISOString() },
  }, uidRoom: { 1101: "101" } }))
  assert.equal(live.lookup(parseEntry("https://live.bilibili.com/101"))?.label, "直播中")
  const result = await live.refreshDetailed(models, NOW)
  assert.deepEqual(result, { started: [], total: 2, refreshed: 0, failed: 0, skipped: 2 })
  assert.equal(server.calls.length, 0)
})

await check("TTL、解析限额、退避计为跳过，force 可绕过退避", async () => {
  const { live, server, models } = fixture("limits", 3)
  const first = await live.refreshDetailed(models, NOW, { maxResolve: 2 })
  assert.deepEqual(first, { started: [], total: 3, refreshed: 2, failed: 0, skipped: 1 })
  const fresh = await live.refreshDetailed(models.slice(0, 1).map(m => ({ ...m, anchors: m.anchors.slice(0, 2) })), NOW + 1000)
  assert.equal(fresh.skipped, 2)
  server.failedRooms.add("103")
  const failed = await live.refreshDetailed(models, NOW + 1000)
  assert.equal(failed.failed, 1)
  const backedOff = await live.refreshDetailed(models, NOW + 2000)
  assert.equal(backedOff.skipped, 3)
  server.failedRooms.clear()
  const forced = await live.refreshDetailed(models, NOW + 3000, { force: true })
  assert.equal(forced.refreshed, 3)
  const eleven = fixture("eleven", 11)
  assert.equal((await eleven.live.refreshDetailed(eleven.models, NOW, { force: true })).skipped, 1)
  assert.equal((await eleven.live.refreshDetailed(eleven.models, NOW, {
    force: true, maxResolve: Number.MAX_SAFE_INTEGER,
  })).refreshed, 11)
})

await check("短号与 UID-only 保持身份映射，未知 UID 的失败准确计数", async () => {
  const file = path.join(ENV.dir, "identity.json")
  let failBatch = false
  const live = new LiveStatus({ file, now: () => NOW, fetchImpl: async (url, options) => {
    if (String(url).includes("get_info?")) {
      const rawRoom = new URL(url).searchParams.get("room_id")
      const roomId = rawRoom === "42" ? "101" : rawRoom
      return reply({ room_id: roomId, uid: String(Number(roomId) + 1000), live_status: 1 })
    }
    if (failBatch) return { ok: false, status: 412 }
    const { uids } = JSON.parse(options.body)
    return reply(Object.fromEntries(uids.filter(uid => uid !== 9999).map(uid => [uid,
      uid === 1101 ? { live_status: 1 } : { room_id: String(uid - 1000), live_status: 1 },
    ])))
  } })
  const models = [{ name: "测试榜", anchors: [{ name: "甲", entry: ["https://live.bilibili.com/42"] },
    { name: "乙", entry: ["https://space.bilibili.com/1111"] },
    { name: "丙", entry: ["https://space.bilibili.com/1101"] }] }]
  const initial = await live.refreshDetailed(models, NOW, { force: true })
  assert.equal(initial.total, 3)
  assert.equal(initial.refreshed, 3)
  assert.equal(live.roomOf(parseEntry("https://live.bilibili.com/42")), "101")
  assert.equal(live.roomOf(parseEntry("https://space.bilibili.com/1111")), "111")
  failBatch = true
  const recovered = await live.refreshDetailed(models, NOW + 4 * 60_000, { force: true })
  assert.equal(recovered.refreshed, 3)
  assert.equal(live.roomOf(parseEntry("https://live.bilibili.com/42")), "101")
  assert.equal(live.roomOf(parseEntry("https://space.bilibili.com/1111")), "111")
  const unknown = [{ name: "测试榜", anchors: [{ name: "丙", entry: ["https://space.bilibili.com/9999"] }] }]
  const savedLogger = globalThis.logger
  const warnings = []
  globalThis.logger = { ...savedLogger, warn: message => warnings.push(message) }
  try {
    assert.deepEqual(await live.refreshDetailed(unknown, NOW, { force: true }),
      { started: [], total: 1, refreshed: 0, failed: 1, skipped: 0 })
    assert.ok(warnings.some(message => message.includes("uid:9999") && message.includes("1/1")))
  } finally {
    globalThis.logger = savedLogger
  }
})

await check("房间补查产生一次 pending，新房间与首次基线不误报", async () => {
  const { live, server, models } = fixture("pending", 1)
  server.live = 1
  assert.deepEqual(await live.refresh(models, NOW), [])
  server.live = 0
  await live.refresh(models, NOW + 1000, { force: true })
  server.batch = "fail"
  server.live = 1
  const started = await live.refresh(models, NOW + 2000, { force: true })
  assert.equal(started.length, 1)
  assert.deepEqual(await live.refresh(models, NOW + 3000, { force: true }), [])
  assert.equal(live.takePending().length, 1)
  assert.deepEqual(live.takePending(), [])
  const newRoom = modelsOf(2)
  assert.deepEqual(await live.refresh(newRoom, NOW + 4000, { force: true }), [])
})

await finish()
