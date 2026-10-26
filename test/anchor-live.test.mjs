import { ensureEnv } from "./env.mjs"
/**
 * 主播直播：入口解析、状态缓存、订阅制开播提醒
 *
 * 全部离线：B 站接口用假 fetch，群消息用注入的 send，成员名单用注入的 directory。
 * 这里钉的是维护者 2026-10-25 的口径：
 *   - 只显示「直播中 / 未开播」，查不到就不显示；
 *   - @ 只有自己订阅过的人才收得到；没人订阅就整条不发；
 *   - 首次刷新只记基线，不把在播的全部报一遍。
 */
import assert from "node:assert/strict"
import path from "node:path"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("主播直播")

const ENV = await ensureEnv({ prefix: "abyss-live-" })
const { config } = await import("../components/config.js")
config.anchor_live.push = true
config.anchor_live.enable = true
config.liveAlertsPath = path.join(ENV.dir, "live-alerts.json")
config.anchorLivePath = path.join(ENV.dir, "anchor-live.json")

const { parseEntry, collectBiliRefs } = await import("../components/live-entry.js")
const { splitItems } = await import("../components/text.js")
const { LiveStatus } = await import("../model/live-status.js")
const { setLiveAlert, isLiveAlertOn } = await import("../model/live-alerts.js")
const { liveLinesForMenu, liveStatusLines, notifyAnchorLive } = await import("../modules/anchor-live.js")
const { anchorDetailView, anchorsAllView, mineView, renderAnchorDetail, renderAnchorsAll, renderMine } = await import("../components/render.js")

console.log(`临时目录：${ENV.dir}\n`)

/** 一条榜模型：一位主播 + 若干排队行 */
const sheet = (rows = []) => ({
  name: "幻想真境剧诗",
  anchors: [{ name: "阿修Axiu", recommend: "强烈推荐", skills: "测试", duty: "", entry: ["B站https://live.bilibili.com/1960"] }],
  rows,
})

console.log("【1】入口解析")
{
  check("B站直播间：取房间号，原文不动", () => {
    const e = parseEntry("B站https://live.bilibili.com/1960956034")
    assert.equal(e.platform, "B站")
    assert.equal(e.kind, "bili-live")
    assert.equal(e.roomId, "1960956034")
    assert.equal(e.text, "B站https://live.bilibili.com/1960956034")
  })
  check("B站个人空间：取 UID", () => {
    const e = parseEntry("https://space.bilibili.com/12345/dynamic")
    assert.equal(e.kind, "bili-space")
    assert.equal(e.uid, "12345")
    assert.equal(e.platform, "B站")
  })
  check("只有平台名 / 会议号：不猜 id", () => {
    assert.equal(parseEntry("B站").kind, "other")
    assert.equal(parseEntry("B站、抖音").roomId, "")
    assert.equal(parseEntry("腾讯会议370-976-3227").kind, "other")
  })
  check("收集引用：同一房间只算一次", () => {
    const refs = collectBiliRefs(["B站https://live.bilibili.com/1960", "https://live.bilibili.com/1960"])
    assert.equal(refs.length, 1)
    assert.equal(refs[0].roomId, "1960")
  })
  check("多平台：B 站链接贴回 B 站，不贴到最后一个抖音", () => {
    assert.deepEqual(splitItems(["B站、抖音（付费）", "https://live.bilibili.com/1960"]), [
      "B站https://live.bilibili.com/1960",
      "抖音（付费）",
    ])
    assert.deepEqual(splitItems(["B站、抖音（付费）", "https://live.douyin.com/123"]), [
      "B站",
      "抖音（付费）https://live.douyin.com/123",
    ])
  })
  check("多平台：抖音链接不会被算成 B 站，单独成项照旧显示", () => {
    assert.deepEqual(splitItems(["B站", "https://live.douyin.com/123"]), ["B站", "https://live.douyin.com/123"])
    const e = parseEntry("B站/抖音（付费）https://live.douyin.com/123")
    assert.equal(e.platform, "抖音")
    assert.equal(e.kind, "other")
  })
  check("多平台：每格各写「平台+链接」时两项各认各的", () => {
    const entries = splitItems(["B站https://live.bilibili.com/1", "抖音（付费）https://live.douyin.com/2"])
    assert.equal(entries.length, 2)
    assert.equal(parseEntry(entries[0]).platform, "B站")
    assert.equal(parseEntry(entries[0]).kind, "bili-live")
    assert.equal(parseEntry(entries[1]).platform, "抖音")
    assert.equal(parseEntry(entries[1]).kind, "other")
  })
}

console.log("\n【2】状态缓存与基线")
{
  const state = { live: 0, fail: false }
  const fetchImpl = async (url, opts) => {
    if (state.fail) throw new Error("boom")
    if (String(url).includes("get_info"))
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { uid: "100", live_status: state.live } }) }
    if (String(url).includes("get_status_info_by_uids")) {
      const body = JSON.parse(opts.body)
      const data = Object.fromEntries(body.uids.map(uid => [String(uid), { room_id: "1960", live_status: state.live }]))
      return { ok: true, status: 200, json: async () => ({ code: 0, data }) }
    }
    throw new Error(`unexpected ${url}`)
  }
  const live = new LiveStatus({ file: config.anchorLivePath, fetchImpl, now: () => 1000, ttl: 1000, stale: 600_000 })
  const models = [sheet()]
  await check("首次刷新只记基线：不开播就不推送", async () => {
    const started = await live.refresh(models, 1000)
    assert.deepEqual(started, [])
    assert.equal(live.lookup(parseEntry("https://live.bilibili.com/1960")).label, "未开播")
  })
  await check("状态变为直播中：lookup 返回「直播中」与新房间", async () => {
    state.live = 1
    const started = await live.refresh(models, 61_000)
    assert.equal(started.length, 1)
    assert.equal(started[0].roomId, "1960")
    const hit = live.lookup(parseEntry("https://live.bilibili.com/1960"))
    assert.equal(hit.state, "live")
    assert.equal(hit.label, "直播中")
  })
  await check("接口失败：保留上一轮状态，不把「查不到」说成「未开播」", async () => {
    state.fail = true
    await live.refresh(models, 62_000)
    assert.equal(live.lookup(parseEntry("https://live.bilibili.com/1960")).label, "直播中")
    state.fail = false
  })
}

console.log("\n【3】@ 只给订阅过的人")
{
  const models = [
    sheet([
      { row: 10, nickname: "甲", anchor: "阿修Axiu", status: "排队中" },
      { row: 11, nickname: "乙", anchor: "阿修Axiu", status: "排队中" },
      { row: 12, nickname: "丙", anchor: "阿修Axiu", status: "本人已完成" },
      { row: 13, nickname: "丁", anchor: "都可以", status: "排队中" },
    ]),
  ]
  const store = {
    qqsOf: (sheetName, row) => ({ 10: ["20001"], 11: ["20002"], 12: ["20003"] })[row] ?? [],
    get: (sheetName, qq) =>
      ({ 20001: { row: 10, nickname: "甲" }, 20002: { row: 11, nickname: "乙" }, 20003: { row: 12, nickname: "丙" } })[qq] ?? null,
  }
  const status = {
    roomOf: e => (String(e?.roomId) === "1960" ? "1960" : ""),
    lookup: () => ({ state: "live", label: "直播中", roomId: "1960", link: "https://live.bilibili.com/1960" }),
  }
  const directory = async () => new Map([["甲", "20001"], ["乙", "20002"], ["丙", "20003"]])
  const sent = []
  const send = async (groups, msg) => sent.push({ groups, msg })
  const run = () => notifyAnchorLive([{ roomId: "1960" }], models, { groups: [20000], store, status, directory, send })

  setLiveAlert("20001", true)
  setLiveAlert("20002", false)
  setLiveAlert("20003", true) // 已完成的人订阅了也不该被 @
  await check("订阅者被 @，未订阅/已完成/「都可以」都不 @", async () => {
    const n = await run()
    assert.equal(n, 1)
    const text = JSON.stringify(sent[0].msg)
    assert.ok(text.includes("20001"), text)
    assert.ok(!text.includes("20002"), text)
    assert.ok(!text.includes("20003"), text)
    assert.ok(text.includes("阿修Axiu"), text)
    assert.ok(text.includes("https://live.bilibili.com/1960"), text)
  })
  await check("没人订阅：整条不发", async () => {
    setLiveAlert("20001", false)
    sent.length = 0
    assert.equal(await run(), 0)
    assert.equal(sent.length, 0)
  })
  check("订阅开关可读可写", () => {
    setLiveAlert("123", true)
    assert.equal(isLiveAlertOn("123"), true)
    setLiveAlert("123", false)
    assert.equal(isLiveAlertOn("123"), false)
  })
}

console.log("\n【4】展示：只显示直播中/未开播")
{
  const model = sheet([{ row: 10, nickname: "甲", anchor: "阿修Axiu", status: "排队中" }])
  const lookup = () => ({ state: "live", label: "直播中", roomId: "1960", link: "https://live.bilibili.com/1960" })
  check("合并列表：入口带状态", () => {
    const view = anchorsAllView([model], { liveLookup: lookup })
    assert.equal(view.anchors[0].entryViews[0].live.label, "直播中")
    assert.equal(view.anchors[0].entryViews[0].live.anchorName, "阿修Axiu")
    assert.equal(view.anchors[0].entry[0], "B站https://live.bilibili.com/1960")
  })
  check("文本列表：有状态时不显示长链接，只显示开播状态", () => {
    const text = renderAnchorsAll(anchorsAllView([model], { liveLookup: lookup }))
    assert.ok(text.includes("开播状态：直播中"), text)
    assert.ok(!text.includes("https://live.bilibili.com/1960"), text)
  })
  check("单主播详情：开播状态只写状态，详情保留链接", () => {
    const view = anchorDetailView([model], "阿修Axiu", { liveLookup: lookup })
    const text = renderAnchorDetail(view)
    assert.ok(text.includes("直播状态：直播中"), text)
    assert.ok(text.includes("开播状态：\n直播中 · https://live.bilibili.com/1960"), text)
    assert.ok(text.includes("https://live.bilibili.com/1960"), text)
  })
  check("菜单里的直播链接行带主播名", () => {
    const lines = liveLinesForMenu([model], [{ sheet: model.name, anchor: "阿修Axiu" }], { lookup })
    assert.equal(lines, "你的主播「阿修Axiu」正在直播：https://live.bilibili.com/1960")
  })
  check("菜单里多选主播：每位开播各给一条链接", () => {
    const multi = {
      name: "幻想真境剧诗",
      anchors: [
        { name: "甲", entry: ["B站https://live.bilibili.com/1"] },
        { name: "乙", entry: ["B站https://live.bilibili.com/2"] },
      ],
      rows: [],
    }
    const lines = liveLinesForMenu([multi], [{ sheet: "幻想真境剧诗", anchor: "甲,乙" }], {
      lookup: entry => ({
        state: "live",
        label: "直播中",
        roomId: entry.roomId,
        link: `https://live.bilibili.com/${entry.roomId}`,
      }),
    })
    assert.equal(
      lines,
      "你的主播「甲」正在直播：https://live.bilibili.com/1\n你的主播「乙」正在直播：https://live.bilibili.com/2",
    )
  })
  check("文本回退逐位输出多选主播的状态", () => {
    const multi = {
      name: "幻想真境剧诗",
      anchors: [
        { name: "甲", entry: ["B站https://live.bilibili.com/1"] },
        { name: "乙", entry: ["B站https://live.bilibili.com/2"] },
      ],
      rows: [{ row: 10, nickname: "甲", anchor: "甲,乙", status: "排队中" }],
    }
    const store = {
      get: (sheet, qq) => (qq === "20001" ? { row: 10, nickname: "甲" } : null),
      qqsOf: (sheet, row) => (row === 10 ? ["20001"] : []),
    }
    const lookup = entry =>
      entry.roomId === "2"
        ? { state: "live", label: "直播中", roomId: "2" }
        : { state: "off", label: "未开播", roomId: "1" }
    const text = renderMine(mineView([multi], store, "20001", "甲", { liveLookup: lookup }))
    assert.ok(text.includes("甲 未开播 / 乙 直播中"), text)
  })
  check("自检输出合并同名主播：三个榜只出一行", () => {
    const a = {
      name: "幻想真境剧诗",
      anchors: [
        { name: "阿修Axiu", entry: ["B站https://live.bilibili.com/1"] },
        { name: "赐次", entry: ["B站https://live.bilibili.com/2"] },
      ],
    }
    const b = {
      name: "幽境危战",
      anchors: [
        { name: "阿修Axiu", entry: ["B站https://live.bilibili.com/1"] },
        { name: "漠天秋", entry: ["B站https://live.bilibili.com/3"] },
      ],
    }
    const lines = liveStatusLines([a, b], entry => ({ label: entry.roomId === "3" ? "直播中" : "未开播" }))
    assert.deepEqual(lines, ["阿修Axiu：未开播", "赐次：未开播", "漠天秋：直播中"])
  })
  check("只显示 B 站：同一入口写着 B站/抖音 也不会把抖音带出来", () => {
    const m = {
      name: "幽境危战",
      anchors: [{ name: "漠天秋", entry: ["B站/抖音（付费）https://live.bilibili.com/1960"] }],
      rows: [],
    }
    const view = anchorsAllView([m], { liveLookup: () => null })
    assert.deepEqual(
      view.anchors[0].entryViews.map(e => e.text),
      ["B站https://live.bilibili.com/1960"],
    )
    assert.ok(!JSON.stringify(view.anchors[0].entryViews).includes("抖音"))
  })
  check("只显示 B 站：文本兜底与详情也不会漏出抖音", () => {
    const onlyOther = {
      name: "幽境危战",
      anchors: [{ name: "漠天秋", entry: ["抖音（付费）https://live.douyin.com/123"] }],
      rows: [],
    }
    const all = renderAnchorsAll(anchorsAllView([onlyOther]))
    assert.ok(!all.includes("抖音"), all)
    const detail = renderAnchorDetail(anchorDetailView([onlyOther], "漠天秋"))
    assert.ok(!detail.includes("抖音"), detail)
    assert.ok(detail.includes("表里还没填 B 站"), detail)
  })
  check("多选主播（阿修Axiu,赐次,听雨）的排队行只带 B 站入口", () => {
    const multi = {
      name: "幻想真境剧诗",
      anchors: [
        { name: "阿修Axiu", entry: ["B站https://live.bilibili.com/1"] },
        { name: "赐次", entry: ["B站https://live.bilibili.com/2"] },
        { name: "听雨", entry: ["抖音"] },
      ],
      rows: [{ row: 10, nickname: "甲", anchor: "阿修Axiu,赐次,听雨", status: "排队中" }],
    }
    const store = {
      get: (sheet, qq) => (qq === "20001" ? { row: 10, nickname: "甲" } : null),
      qqsOf: (sheet, row) => (row === 10 ? ["20001"] : []),
    }
    const view = mineView([multi], store, "20001", "甲", { liveLookup: () => null })
    assert.equal(view.active[0].anchorMultiple, true)
    assert.equal(view.active[0].anchorEntries.length, 2)
    assert.ok(view.active[0].anchorEntry.includes("live.bilibili.com/1"), view.active[0].anchorEntry)
    assert.ok(view.active[0].anchorEntry.includes("live.bilibili.com/2"), view.active[0].anchorEntry)
    assert.ok(!view.active[0].anchorEntry.includes("抖音"), view.active[0].anchorEntry)
  })
  check("单选主播的排队行不带名字（状态列不重复）", () => {
    const store = {
      get: (sheet, qq) => (qq === "20001" ? { row: 10, nickname: "甲" } : null),
      qqsOf: (sheet, row) => (row === 10 ? ["20001"] : []),
    }
    const view = mineView([model], store, "20001", "甲", { liveLookup: lookup })
    assert.equal(view.active[0].anchorMultiple, false)
    assert.equal(view.active[0].anchorEntries[0].live.label, "直播中")
  })
}

console.log("\n【5】缓存身份与自检刷新")
{
  await check("只填个人空间：UID 直接进批量并建立房间映射", async () => {
    const file = path.join(ENV.dir, "live-uid.json")
    const calls = []
    const fetchImpl = async (url, opts) => {
      calls.push(String(url))
      if (String(url).includes("get_info")) throw new Error("UID-only 不应先查 get_info")
      if (String(url).includes("get_status_info_by_uids")) {
        const body = JSON.parse(opts.body)
        assert.deepEqual(body.uids, [12345])
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { 12345: { room_id: "1960", live_status: 1 } } }) }
      }
      throw new Error(`unexpected ${url}`)
    }
    const live = new LiveStatus({ file, fetchImpl, now: () => 1000, ttl: 1000, stale: 600_000 })
    const m = { name: "x", anchors: [{ name: "甲", entry: ["https://space.bilibili.com/12345"] }], rows: [] }
    await live.refresh([m], 1000)
    const e = parseEntry("https://space.bilibili.com/12345")
    assert.equal(live.lookup(e).label, "直播中")
    assert.equal(live.roomOf(e), "1960")
    assert.equal(calls.filter(c => c.includes("get_info")).length, 0)
  })

  await check("短房号归一：开播事件与原链接都使用完整 room_id", async () => {
    const file = path.join(ENV.dir, "live-short.json")
    let liveStatus = 0
    const fetchImpl = async (url) => {
      if (String(url).includes("get_info"))
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { uid: "100", room_id: "1960", live_status: 0 } }) }
      if (String(url).includes("get_status_info_by_uids"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { 100: { room_id: "1960", live_status: liveStatus } } }),
        }
      throw new Error(`unexpected ${url}`)
    }
    const live = new LiveStatus({ file, fetchImpl, now: () => 1000, ttl: 1000, stale: 600_000 })
    const m = { name: "x", anchors: [{ name: "甲", entry: ["B站https://live.bilibili.com/42"] }], rows: [] }
    const entry = parseEntry("B站https://live.bilibili.com/42")
    await live.refresh([m], 1000)
    assert.equal(live.lookup(entry).label, "未开播")
    liveStatus = 1
    const started = await live.refresh([m], 61_000)
    assert.deepEqual(started.map(s => s.roomId), ["1960"])
    assert.equal(live.lookup(entry).label, "直播中")
    assert.equal(live.roomOf(entry), "1960")
  })

  await check("自检 force 忽略 TTL，并把开播事件留给下一轮 tick", async () => {
    const file = path.join(ENV.dir, "live-force.json")
    let liveStatus = 0
    let batchCalls = 0
    const fetchImpl = async (url) => {
      if (String(url).includes("get_info"))
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { uid: "100", room_id: "1960", live_status: 0 } }) }
      if (String(url).includes("get_status_info_by_uids")) {
        batchCalls++
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { 100: { room_id: "1960", live_status: liveStatus } } }),
        }
      }
      throw new Error(`unexpected ${url}`)
    }
    const live = new LiveStatus({ file, fetchImpl, now: () => 1000, ttl: 300_000, stale: 600_000 })
    const m = { name: "x", anchors: [{ name: "甲", entry: ["B站https://live.bilibili.com/1960"] }], rows: [] }
    const entry = parseEntry("B站https://live.bilibili.com/1960")
    await live.refresh([m], 1000)
    liveStatus = 1
    await live.refresh([m], 1500)
    assert.equal(batchCalls, 0, "TTL 内普通刷新不应重新请求")
    assert.equal(live.lookup(entry).label, "未开播")
    const started = await live.refresh([m], 1500, { force: true })
    assert.equal(started.length, 1)
    assert.equal(live.lookup(entry).label, "直播中")
    assert.deepEqual(live.takePending().map(e => e.roomId), ["1960"])
    assert.deepEqual(live.takePending(), [])
  })
}

await ENV.cloud?.close()
await finish()
