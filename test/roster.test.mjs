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

const { config, reloadConfig } = await import("../components/config.js")
reloadConfig()
const { pushRoster, collectMembers, ROSTER_QQ } = await import("../components/roster.js")
const { verifyIdentity } = await import("../lib/identity.js")

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
 * 框架给的成员形状要全部吃下来
 *
 * 真机踩过：TRSS 的 `getMemberMap()` 返回的是**以 QQ 为键的普通对象**，
 * 直接 `[...map.values()]` 抛 `map.values is not a function` → 群名单一次都没推成功、@ 人退化成纯文本。
 * 这几条就是为了让"桩是 Map、真机是对象"这种偏差再也测不出来（改动前会抛异常）。
 */
const { listMembers } = await import("../components/roster.js")

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
