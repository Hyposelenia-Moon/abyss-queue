/**
 * 出站签名**对账**：插件发给编辑器的每一条带身份的链接，都要满足编辑器闸门的口径
 *
 * 为什么要有这一套（2026-10-08 复审报告 §2-#1 + §5-#2）：编辑器侧把"带身份却不带时间窗
 * （`w/ws`）的请求"收紧成**只放行认领过那条链接的设备**之后，插件侧还有三处推送只带了
 * `k/u/s`——`model/roster.js`（每日群名单同步）、`model/tidy.js`（每日整理）、
 * `model/move-row.js`（`#插队`）——全被 410 挡死；而编辑器侧的套件替请求**自动补了 `w/ws`**，
 * 于是两边各自全绿、跨层契约没人盯。这一套就是那张对账表：
 *
 *   1. 用**真函数**把三条推送发到假云端（`test/env.mjs` 起的桩服务，会把每个请求的
 *      `k/u/s/w/ws` 留档）；
 *   2. 对每一条**带身份**的出站链接，按编辑器的口径验一遍：必须有 `w/ws`，且用身份里的 QQ
 *      能验得过（`verifyWindow`）；
 *   3. 另外把填报入口的两种链接（群里那条短链、私聊那条长链）也一起对账。
 *
 * 假云端只回空壳，所以这里验的是"插件**拼**出来的链接"，不是编辑器的行为——
 * 编辑器那一侧由 `editor/test/*` 走真进程覆盖。两边合起来才是一条完整的链路。
 *
 * 用法：node test/outbound-window.test.mjs
 */
import { ensureEnv } from "./env.mjs"
import fs from "node:fs"

const env = await ensureEnv({
  prefix: "abyss-queue-outbound-",
  extra: { roster: { group: "999888" } },
})

const { createChecker } = await import("./_helper.mjs")
const { check, finish } = createChecker("出站签名对账")

const { config } = await import("../components/config.js")
const { pushRoster, ROSTER_QQ } = await import("../model/roster.js")
const { tidySheets } = await import("../model/tidy.js")
const { moveRow } = await import("../model/move-row.js")
const { fillEntry } = await import("../components/fill-entry.js")
const { decodeIdentity, verifyIdentity, verifyWindow } = await import("../model/identity.js")

const KEY = config.remote.sign_key
const MEMBER = { qq: "10001", nick: "小伙01" }
/** 桩 Bot：一个群、一个成员（名单推送要有内容才发得出去） */
globalThis.Bot = {
  pickGroup: () => ({ getMemberMap: () => new Map([[MEMBER.qq, { user_id: MEMBER.qq, card: MEMBER.nick, nickname: "" }]]) }),
}

/** 三条推送都真发一次（各自的失败会在这里直接冒出来） */
const pushed = await pushRoster()
const tidied = await tidySheets()
const moved = await moveRow({ caller: MEMBER, sheet: "幽境危战", row: 10, nick: MEMBER.nick })
/** 填报入口的两种形态：群里那条短链、私聊那条带窗口的长链 */
const entry = fillEntry({ e: { user_id: MEMBER.qq }, nickname: () => MEMBER.nick }, ["幽境危战"], [])
const managerEntry = fillEntry({ e: { user_id: MEMBER.qq }, nickname: () => MEMBER.nick }, ["幽境危战"], [], { manager: true })
const urlOf = text => (String(text).match(/https?:\/\/\S+/) ?? [""])[0]

const outbound = env.cloud.state.outbound ?? []
const withIdentity = outbound.filter(o => o.u)
/** 带身份的那些出站链接（按路径去重，便于报错时看清是哪一处） */
const byPath = new Map(withIdentity.map(o => [o.path, o]))

await check("三条推送都真发到了假云端（对账不是空跑）", () => {
  if (!pushed.ok) throw new Error(`名单推送没成功：${JSON.stringify(pushed)}`)
  if (!tidied?.ok) throw new Error(`每日整理没成功：${JSON.stringify(tidied)}`)
  if (!moved?.ok) throw new Error(`插队没成功：${JSON.stringify(moved)}`)
  for (const path of ["/api/roster", "/api/tidy", "/api/move-row"]) {
    if (!byPath.has(path)) throw new Error(`${path} 没发出去（拿到的路径：${JSON.stringify([...byPath.keys()])}）`)
  }
})

await check("每一条带身份的出站链接都带了当期时间窗（身份 + w/ws，对着编辑器的闸口径）", () => {
  for (const o of withIdentity) {
    if (!o.w || !o.ws) throw new Error(`${o.path} 只带了身份、没带时间窗——会被编辑器的闸 410 掉`)
    const id = verifyIdentity(o.u, o.s, KEY)
    if (!id) throw new Error(`${o.path} 的身份验不过`)
    if (!verifyWindow(o.w, o.ws, { qq: id.qq }, KEY)) throw new Error(`${o.path} 的时间窗验不过（qq=${id.qq}）`)
  }
  if (!withIdentity.length) throw new Error("一条带身份的出站链接都没记到")
})

await check("口令与身份签的是对的人（机器人签自己、插队与填报签发起人）", () => {
  const roster = byPath.get("/api/roster")
  const tidy = byPath.get("/api/tidy")
  const move = byPath.get("/api/move-row")
  if (roster.k !== config.remote.token) throw new Error("名单推送没带口令")
  if (decodeIdentity(roster.u).qq !== ROSTER_QQ) throw new Error(`名单推送的身份不是机器人：${decodeIdentity(roster.u).qq}`)
  if (decodeIdentity(tidy.u).qq !== ROSTER_QQ) throw new Error(`每日整理的身份不是机器人：${decodeIdentity(tidy.u).qq}`)
  if (decodeIdentity(move.u).qq !== MEMBER.qq) throw new Error(`插队的身份不是发起人：${decodeIdentity(move.u).qq}`)
})

await check("群里那条填报短链不带身份参数（`/s/` 那条路由在闸之前，自己现签窗口）", () => {
  const link = urlOf(entry.link)
  if (!/\/s\/[A-Za-z0-9_-]{16}/.test(link)) throw new Error(`不是短链：${link}`)
  if (/[?&](u|s|k|w|ws)=/.test(link)) throw new Error(`短链里不该带身份 / 口令 / 窗口：${link}`)
})

await check("私聊那条管理长链接带身份**也**带当期时间窗（5 分钟作废）", () => {
  const url = new URL(urlOf(managerEntry.link))
  const u = url.searchParams.get("u")
  const id = verifyIdentity(u, url.searchParams.get("s"), KEY)
  if (!id || id.qq !== MEMBER.qq) throw new Error(`管理链接的身份不对：${urlOf(managerEntry.link)}`)
  if (!verifyWindow(url.searchParams.get("w"), url.searchParams.get("ws"), { qq: id.qq }, KEY))
    throw new Error(`管理链接没有可用的时间窗：${urlOf(managerEntry.link)}`)
})

await env.cloud.close()
/** 临时目录跟着套件清掉（与其它套件同一个口径：跑完不脏 %TEMP%） */
fs.rmSync(env.dir, { recursive: true, force: true })
await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
