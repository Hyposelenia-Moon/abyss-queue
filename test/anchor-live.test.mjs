/** 主播直播：anchor-live / live-dedupe / live-refresh-tick / live-refresh-completeness 合并成一个套件（原文件见 git 历史） */
import { ensureEnv } from "./env.mjs"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import { installFrameworkStubs } from "./_helper.mjs"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("主播直播")

await (async () => {
  const ENV = await ensureEnv({ prefix: "abyss-live-" })
  const { config } = await import("../components/config.js")
  config.anchor_live.push = true
  config.anchor_live.enable = true
  config.liveAlertsPath = path.join(ENV.dir, "live-alerts.json")
  config.anchorLivePath = path.join(ENV.dir, "anchor-live.json")
  /** 表里写旧名、用户订阅/查询写正名时也要认成同一位（复审 P2-1） */
  config.anchor_aliases = { 阿修Axiu: ["阿修", "旧阿修"] }
  const { parseEntry, collectBiliRefs } = await import("../components/live-entry.js")
  const { splitItems } = await import("../components/text.js")
  const { LiveStatus } = await import("../model/live-status.js")
  const { liveAlertOf, setLiveAlert, setLiveAlertAnchors, isLiveAlertOn } = await import("../model/live-alerts.js")
  const { liveLinesForMenu, liveStatusLines, notifyAnchorLive } = await import("../modules/anchor-live.js")
  const { anchorDetailView, anchorsAllView, mineView, renderAnchorDetail, renderAnchorsAll, renderMine } = await import("../components/render.js")
  console.log(`临时目录：${ENV.dir}\n`)
  // 断言文本里含某个链接：把两边的 URL 解析出来比 host + path
  const hasUrl = (text, url) => {
    const want = new URL(url)
    for (const [hit] of String(text ?? "").matchAll(/https?:\/\/[^\s）)，。、"']+/g)) {
      let got
      try {
        got = new URL(hit)
      } catch {
        continue
      }
      if (got.host === want.host && got.pathname === want.pathname) return true
    }
    return false
  }
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
    check("只有平台名 / 会议号：不猜 id（会议号那类写法随平台收敛一起删了）", () => {
      assert.equal(parseEntry("B站").kind, "other")
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
  check("只留 B 站：抖音链接不算平台，单独成项照旧显示", () => {
    assert.deepEqual(splitItems(["B站", "https://live.douyin.com/123"]), ["B站", "https://live.douyin.com/123"])
    const e = parseEntry("B站/抖音（付费）https://live.douyin.com/123")
    assert.equal(e.platform, "")
    assert.equal(e.kind, "other")
  })
  check("只留 B 站：每格各写「平台+链接」时只有 B 站那项认得出平台", () => {
    const entries = splitItems(["B站https://live.bilibili.com/1", "抖音（付费）https://live.douyin.com/2"])
    assert.equal(entries.length, 2)
    assert.equal(parseEntry(entries[0]).platform, "B站")
    assert.equal(parseEntry(entries[0]).kind, "bili-live")
    assert.equal(parseEntry(entries[1]).platform, "")
    assert.equal(parseEntry(entries[1]).kind, "other")
  })
  check("只留 B 站：每格各写「平台+链接」时只有 B 站那项认得出平台", () => {
    const entries = splitItems(["B站https://live.bilibili.com/1", "抖音（付费）https://live.douyin.com/2"])
    assert.equal(entries.length, 2)
    assert.equal(parseEntry(entries[0]).platform, "B站")
    assert.equal(parseEntry(entries[0]).kind, "bili-live")
    assert.equal(parseEntry(entries[1]).platform, "")
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
        { row: 13, nickname: "丁", anchor: "公共队列", status: "排队中" },
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
    await check("订阅者被 @，未订阅/已完成/「公共队列」都不 @", async () => {
      const n = await run()
      assert.equal(n, 1)
      const text = JSON.stringify(sent[0].msg)
      assert.ok(text.includes("20001"), text)
      assert.ok(!text.includes("20002"), text)
      assert.ok(!text.includes("20003"), text)
      assert.ok(text.includes("阿修Axiu"), text)
      assert.ok(hasUrl(text, "https://live.bilibili.com/1960"), text)
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
    check("可按主播订阅：只命中订阅的那一位", () => {
      setLiveAlertAnchors("456", ["阿修Axiu"])
      assert.equal(isLiveAlertOn("456", "阿修Axiu"), true)
      assert.equal(isLiveAlertOn("456", "听雨"), false)
      assert.deepEqual(liveAlertOf("456"), { on: true, all: false, anchors: ["阿修Axiu"] })
      setLiveAlertAnchors("456", ["阿修Axiu", "听雨"])
      assert.equal(isLiveAlertOn("456", "听雨"), true)
      setLiveAlertAnchors("456", [])
      assert.equal(liveAlertOf("456").on, false)
    })
    check("旧版订阅没有 anchors 字段时仍按全部主播处理", () => {
      setLiveAlert("789", true)
      assert.equal(liveAlertOf("789").all, true)
      assert.equal(isLiveAlertOn("789", "任意主播"), true)
      setLiveAlert("789", false)
    })
    check("订阅里的旧名与输入别名都归一到正名", () => {
      /** 直接写旧名，模拟改别名配置前留下的订阅文件 */
      setLiveAlertAnchors("456", ["旧阿修"])
      assert.deepEqual(liveAlertOf("456"), { on: true, all: false, anchors: ["阿修Axiu"] })
      assert.equal(isLiveAlertOn("456", "阿修"), true)
      assert.equal(isLiveAlertOn("456", "旧阿修"), true)
      assert.equal(isLiveAlertOn("456", "听雨"), false)
      setLiveAlertAnchors("456", [])
    })
    check("主播订阅不会把未订阅主播的开播推给本人", async () => {
      setLiveAlertAnchors("20001", ["不存在的主播"])
      sent.length = 0
      assert.equal(await run(), 0)
      assert.equal(sent.length, 0)
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
      assert.ok(!hasUrl(text, "https://live.bilibili.com/1960"), text)
    })
    check("单主播详情：开播状态只出现一次，详情保留链接", () => {
      const view = anchorDetailView([model], "阿修Axiu", { liveLookup: lookup })
      const text = renderAnchorDetail(view)
      assert.ok(!text.includes("直播状态："), text)
      assert.ok(text.includes("开播状态：\n直播中 · https://live.bilibili.com/1960"), text)
      assert.ok(hasUrl(text, "https://live.bilibili.com/1960"), text)
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
  console.log("\n【4.1】核心强项口径：单榜取该榜 C 列，合并多榜才取 I 列总说明")
  {
    const drama = {
      name: "幻想真境剧诗",
      anchors: [
        {
          name: "阿修Axiu",
          recommend: "强烈推荐",
          skills: "承接全类型账号，痛苦号专职",
          totalSkills: "爱越权的权狗",
          entry: [],
        },
        {
          name: "御坂5432号",
          recommend: "可选",
          skills: "正常练度、足数量的主c，月谕24r，卓越20r，不满花打折",
          totalSkills: "付费帮帮，按需排队",
          entry: [],
        },
      ],
      rows: [],
    }
    check("单榜：阿修显示剧诗的 C 列强项，而不是 I 列总说明", () => {
      const view = anchorsAllView([drama])
      assert.equal(view.anchors.find(a => a.name === "阿修Axiu").skills, "承接全类型账号，痛苦号专职")
    })
    check("单榜：御坂也显示剧诗的 C 列强项", () => {
      const view = anchorsAllView([drama])
      assert.equal(
        view.anchors.find(a => a.name === "御坂5432号").skills,
        "正常练度、足数量的主c，月谕24r，卓越20r，不满花打折",
      )
    })
    check("单榜：C 列为空时才回退到 I 列总说明", () => {
      const onlyTotal = {
        name: "幻想真境剧诗",
        anchors: [{ name: "阿修Axiu", recommend: "强烈推荐", skills: "", totalSkills: "爱越权的权狗", entry: [] }],
        rows: [],
      }
      assert.equal(anchorsAllView([onlyTotal]).anchors[0].skills, "爱越权的权狗")
    })
    check("合并多榜：仍优先 I 列总说明", () => {
      const other = {
        name: "幽境危战",
        anchors: [{ name: "阿修Axiu", recommend: "强烈推荐", skills: "路边丝与路边白", entry: [] }],
        rows: [],
      }
      const view = anchorsAllView([drama, other])
      assert.equal(view.anchors.find(a => a.name === "阿修Axiu").skills, "爱越权的权狗")
    })
    check("合并多榜显式关闭总说明：回落到主榜 C 列", () => {
      const other = {
        name: "幽境危战",
        anchors: [{ name: "阿修Axiu", recommend: "强烈推荐", skills: "路边丝与路边白", entry: [] }],
        rows: [],
      }
      const view = anchorsAllView([drama, other], { useTotalSkills: false })
      assert.equal(view.anchors.find(a => a.name === "阿修Axiu").skills, "路边丝与路边白")
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
})()

await (async () => {
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
})()

await (async () => {
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
})()

await (async () => {
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
})()

finish()
