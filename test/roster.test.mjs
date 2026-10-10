/**
 * 机器人推群成员名单：签名身份、成员映射、空名单不推
 *
 * 用桩 Bot + 桩 HTTP 服务，不碰任何真实群与编辑器。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("群成员名单推送")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-roster-push-"))
const TOKEN = "roster-push-token"
const SIGN_KEY = "roster-push-sign-key"

/** 桩云端：把收到的请求留下面 */
const seen = []
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", c => (body += c))
  req.on("end", () => {
    seen.push({ url: req.url, method: req.method, body })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, renamed: 2, removed: 1 }))
  })
})
await new Promise(r => server.listen(0, "127.0.0.1", r))
const cloud = `http://127.0.0.1:${server.address().port}`

const cfg = path.join(dir, "config.yaml")
fs.writeFileSync(
  cfg,
  [
    `remote:`,
    `  url: "${cloud}"`,
    `  token: "${TOKEN}"`,
    `  sign_key: "${SIGN_KEY}"`,
    `  ttl_ms: 0`,
    `roster:`,
    `  group: "999888"`,
    `  cron: "0 5 * * *"`,
    "",
  ].join("\n"),
  "utf8",
)
process.env.ABYSS_QUEUE_CONFIG = cfg
/**
 * 机器人侧那份名单缓存（`data/roster.json`）也指到临时目录：**隔离的一部分，不是方便**
 * （不指的话这一套会往仓库的 `data/` 写文件，跑一次脏一次）。
 */
process.env.ABYSS_QUEUE_TEST_PATHS = "1"
process.env.ABYSS_QUEUE_ROSTER_FILE = path.join(dir, "roster.json")

const { config, reloadConfig } = await import("../components/config.js")
reloadConfig()
const { pushRoster, collectMembers, rosterScanSource, ROSTER_QQ, cachedRoster, forgetRoster, reloadRosterFromDisk } = await import(
  "../model/roster.js"
)
const { verifyIdentity } = await import("../model/identity.js")

/** 名单缓存落点（断言直接读这个文件） */
const ROSTER_FILE = config.rosterPath

/** 桩 Bot：一个群、三个人（其中一个只有昵称没有群名片） */
const members = new Map([
  ["10001", { user_id: "10001", card: "小伙01", nickname: "小号" }],
  ["10002", { user_id: "10002", card: "", nickname: "随伦" }],
  ["10003", { user_id: "10003", card: "拾起那梦与忆", nickname: "拾起" }],
])
globalThis.Bot = { pickGroup: () => ({ getMemberMap: () => members }) }

check("取成员：群名片优先，没有名片用昵称", async () => {
  const list = await collectMembers("999888", globalThis.Bot)
  const byQq = new Map(list.map(m => [m.qq, m.nick]))
  if (list.length !== 3) throw new Error(`拿到 ${list.length} 人`)
  if (byQq.get("10001") !== "小伙01") throw new Error(`群名片没优先：${byQq.get("10001")}`)
  if (byQq.get("10002") !== "随伦") throw new Error(`昵称兜底不对：${byQq.get("10002")}`)
})

await check("推送：带口令与机器人身份的签名、内容正确", async () => {
  const out = await pushRoster()
  if (!out.ok) throw new Error(out.error || "推送失败")
  if (seen.length !== 1) throw new Error(`云端收到 ${seen.length} 次请求`)
  const url = new URL(seen[0].url, cloud)
  if (url.searchParams.get("k") !== TOKEN) throw new Error("没带口令")
  const id = verifyIdentity(url.searchParams.get("u"), url.searchParams.get("s"), SIGN_KEY)
  if (!id) throw new Error("签名验不过")
  if (id.qq !== ROSTER_QQ) throw new Error(`签名身份不是机器人：${id.qq}`)
  const body = JSON.parse(seen[0].body)
  if (body.group !== "999888") throw new Error(`群号不对：${body.group}`)
  if (body.members.length !== 3) throw new Error(`成员数不对：${body.members.length}`)
  if (!body.members.some(m => m.qq === "10001" && m.nick === "小伙01")) throw new Error("成员内容不对")
  if (out.renamed !== 2 || out.removed !== 1) throw new Error("云端回报没透传：" + JSON.stringify(out))
})

check("空名单不推（避免被当成全员退群）", async () => {
  const before = seen.length
  globalThis.Bot = { pickGroup: () => ({ getMemberMap: () => new Map() }) }
  const out = await pushRoster()
  if (out.ok) throw new Error("空名单却报成功")
  if (seen.length !== before) throw new Error("空名单也发请求了")
})

/**
 * 机器人侧留一份名单（`<插件根>/data/roster.json`）
 *
 * 为什么要落盘：@ 人靠"群昵称 → QQ"，原先只有内存缓存 ⇒ **重启后到下一次扫描之间等于没有**，
 * 通知会退化成"只写名字不发 @"；而且"本地到底有没有名单"在插件侧无从查起。
 */
await check("扫成功的那份名单落盘：文件里有群号、时间与 qq/nick", async () => {
  globalThis.Bot = { pickGroup: () => ({ getMemberMap: () => members }) }
  forgetRoster()
  const out = await pushRoster()
  if (!out.ok) throw new Error(out.error || "推送失败")
  const saved = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"))
  if (String(saved.group) !== "999888") throw new Error(`群号不对：${saved.group}`)
  if (!(Number(saved.at) > 0)) throw new Error(`没记时间：${saved.at}`)
  if ((saved.members ?? []).length !== 3) throw new Error(`成员数不对：${JSON.stringify(saved.members)}`)
  if (!saved.members.some(m => m.qq === "10001" && m.nick === "小伙01")) throw new Error("成员内容不对")
})

await check("重启之后（内存清空）能从盘上把名单读回来，@ 不必等下一次扫描", () => {
  reloadRosterFromDisk()
  const cache = cachedRoster("999888")
  if (!cache) throw new Error("盘上那份没读回来")
  if (cache.members.length !== 3) throw new Error(`成员数不对：${cache.members.length}`)
  /** 群号对不上（换了群）就不该拿旧名单去 @ */
  if (cachedRoster("111111") !== null) throw new Error("换了群还把旧名单认下来")
})

await check("盘上那份坏了 / 空了：当没有，不抛错", () => {
  fs.writeFileSync(ROSTER_FILE, "{ 这不是 JSON", "utf8")
  reloadRosterFromDisk()
  if (cachedRoster("999888") !== null) throw new Error("坏文件也读出来了")
  fs.writeFileSync(ROSTER_FILE, JSON.stringify({ group: "999888", at: Date.now(), members: [] }), "utf8")
  reloadRosterFromDisk()
  if (cachedRoster("999888") !== null) throw new Error("空名单也读出来了")
  forgetRoster()
})

/**
 * 框架给的成员形状要全部吃下来
 *
 * 真机踩过：TRSS 的 `getMemberMap()` 返回的是**以 QQ 为键的普通对象**，
 * 直接 `[...map.values()]` 抛 `map.values is not a function` → 群名单一次都没推成功、@ 人退化成纯文本。
 * 这几条就是为了让"桩是 Map、真机是对象"这种偏差再也测不出来。
 */
const { listMembers } = await import("../model/roster.js")

await check("成员形状：Map（老桩那种）", async () => {
  const list = await listMembers({ getMemberMap: () => members })
  if (list.length !== 3 || list[0].qq !== "10001") throw new Error(JSON.stringify(list))
})

await check("成员形状：以 QQ 为键的普通对象（**真机那种**）", async () => {
  const obj = Object.fromEntries([...members].map(([qq, m]) => [qq, { card: m.card, nickname: m.nickname }]))
  const list = await listMembers({ getMemberMap: () => obj })
  if (list.length !== 3) throw new Error(`拿到 ${list.length} 人`)
  const byQq = new Map(list.map(m => [m.qq, m.card || m.nickname]))
  if (byQq.get("10002") !== "随伦") throw new Error(`键里的 QQ 没兜住：${JSON.stringify(list)}`)
})

await check("成员形状：值里自带 user_id 的对象", async () => {
  const list = await listMembers({ getMemberMap: () => ({ a: { user_id: "10009", card: "甲" } }) })
  if (list.length !== 1 || list[0].qq !== "10009") throw new Error(JSON.stringify(list))
})

await check("成员形状：数组 / 只有异步 getMemberList", async () => {
  const asArray = await listMembers({ getMemberMap: () => [{ user_id: "10011", card: "乙" }] })
  if (asArray[0]?.qq !== "10011") throw new Error(JSON.stringify(asArray))
  const viaList = await listMembers({ getMemberList: async () => [{ user_id: "10012", nickname: "丙" }] })
  if (viaList[0]?.qq !== "10012") throw new Error(JSON.stringify(viaList))
})

/**
 * 2026-10 现场：主人发 `#排队同步名单` 回「同步失败：取到的成员是空的，先不推（避免被当成全员退群）」
 *
 * 根因是"方法存在就直接返回、空结果不再兜底"：在这个框架版本上 `getMemberMap()` 给了**空对象**
 * （成员还没缓存），而真正拿得到成员的是 `getMemberList()`；另一些适配器把它做成**异步**（返回 Promise）。
 * 下面几条盯住"**空就换下一个来源**"，以及全空时给出的排障信息（下次一眼能看出是框架没缓存还是群号不对）。
 */
await check("getMemberMap 是空的 ⇒ 换 getMemberList 再取（现场那个 bug）", async () => {
  const list = await listMembers({ getMemberMap: () => ({}), getMemberList: async () => [...members.values()] })
  if (list.length !== 3) throw new Error(`没换来源：${JSON.stringify(list)}`)
})

await check("getMemberMap 返回 Promise（异步版）⇒ await 之后照旧能用", async () => {
  const list = await listMembers({ getMemberMap: async () => members })
  if (list.length !== 3 || list[0].qq !== "10001") throw new Error(JSON.stringify(list))
})

await check("成员挂在 group.group 上（套一层）也能取到", async () => {
  const list = await listMembers({ getMemberMap: () => ({}), group: { getMemberMap: () => members } })
  if (list.length !== 3) throw new Error(JSON.stringify(list))
})

await check("群对象什么都没有：走框架级兜底 Bot.getGroupMemberList / Bot.gl.get", async () => {
  const viaBot = { pickGroup: () => ({}), getGroupMemberList: async () => [...members.values()] }
  const a = await collectMembers("999888", viaBot)
  if (a.length !== 3) throw new Error(`Bot.getGroupMemberList 没兜住：${JSON.stringify(a)}`)
  const viaGl = { pickGroup: () => ({}), gl: { get: () => ({ getMemberMap: () => members }) } }
  const b = await collectMembers("999888", viaGl)
  if (b.length !== 3) throw new Error(`Bot.gl.get 没兜住：${JSON.stringify(b)}`)
})

await check("扫不到成员：错误里带上群号与每个来源的形状 / 数量（排障用）", async () => {
  let err = null
  try {
    await collectMembers("999888", { pickGroup: () => ({ getMemberMap: () => ({}), getMemberList: () => [] }) })
  } catch (e) {
    err = e
  }
  const msg = String(err?.message ?? "")
  if (!err) throw new Error("扫不到却当成功了")
  if (!msg.includes("999888")) throw new Error(`没说群号：${msg}`)
  if (!/getMemberMap→object\(0\)/.test(msg)) throw new Error(`没列出各来源的形状与数量：${msg}`)
  if (!msg.includes("Bot.getGroupMemberList")) throw new Error(`没列出框架级兜底也试过：${msg}`)
})

await check("扫成功的来源能报出来（日志里那句「来源 X」）", async () => {
  await collectMembers("999888", { pickGroup: () => ({ getMemberMap: () => members }) })
  if (rosterScanSource() !== "getMemberMap") throw new Error(`报出来的来源是 ${rosterScanSource()}`)
})

/**
 * 状态文件的写入是**临时文件 + 原子替换**（2026-10-09 终审的观察 1）
 *
 * 这份套件正好会写 `roster.json`（`model/queue-state.js` 的 `writeJson`），所以顺手把这条不变量钉在这里：
 * 把 `fs.writeFileSync` 换成"只落半截再抛"来模拟"写到一半进程崩了 / 磁盘满"，断言
 * **目标文件仍是原来那份**（而不是被截成半截 JSON——那一读就当"没有"，绑定 / 进度 / 名单缓存一起丢），
 * 并且**不留中间产物**。
 */
await check("状态文件是原子替换：写到一半崩了也不破坏原来那份、不留 .tmp", async () => {
  const { writeJson } = await import("../model/queue-state.js")
  const file = path.join(dir, "atomic-state.json")
  writeJson(file, { keep: "原来的内容" })
  const before = fs.readFileSync(file, "utf8")

  const real = fs.writeFileSync
  fs.writeFileSync = (p, data, enc) => {
    real(p, String(data).slice(0, 8), enc) // 只落半截
    throw new Error("模拟：写到一半崩了")
  }
  try {
    /** 补丁一定要真的生效，否则这条断言会变成空转（把"直接写目标文件"改回来也测不出来） */
    if (fs.writeFileSync === real) throw new Error("没法替换 fs.writeFileSync，这条用例失去意义")
    writeJson(file, { keep: "写完这一份就崩" }) // 这个写入口自己吞错并记日志
  } finally {
    fs.writeFileSync = real
  }

  if (fs.readFileSync(file, "utf8") !== before) throw new Error(`目标文件被写坏了：${fs.readFileSync(file, "utf8")}`)
  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith(".tmp"))
  if (leftovers.length) throw new Error(`留下了中间产物：${leftovers.join("、")}`)
})

check("没配群号就不推", async () => {
  config.roster.group = ""
  const before = seen.length
  const out = await pushRoster()
  if (out.ok || !out.skipped) throw new Error(JSON.stringify(out))
  if (seen.length !== before) throw new Error("没配群号也发请求了")
})

server.close()
fs.rmSync(dir, { recursive: true, force: true })
await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
