/**
 * 出站身份**对账**：名单推送与填报入口，都必须按编辑器闸门的口径走
 *
 * 为什么要有这一套（2026-10-08 复审报告 §2-#1 + §5-#2）：编辑器侧把"带身份却不带时间窗
 * （`w/ws`）的请求"收紧成**只放行认领过那条链接的设备**之后，插件侧还有推送只带了
 * `k/u/s`——`model/roster.js`（每日群名单同步）——被 410 挡死；而编辑器侧的套件替请求
 * **自动补了 `w/ws`**，于是两边各自全绿、跨层契约没人盯。
 *
 * 现在写入口已经全部改成进程内直调（`editor/service.js` 的注册表），插件不再向编辑器发
 * HTTP 请求，出站链接只剩**发给用户的填报入口**。这一套于是盯两件事：
 *
 *   1. 名单推送真的走到了编辑器（假 service 记调用）：用机器人身份、只推一次，
 *      **失败不重试**（HTTP 超时/重试那一层已随出站请求一起消失）；
 *   2. 填报入口的两种链接（群里那条长链接、私聊那条长链）仍然带身份 + 当期时间窗，
 *      否则编辑器那边还是 410（那层闸没有因为写入口搬家而放宽）。
 *
 * 编辑器那一侧的真实行为由 `editor/test/*` 走真进程覆盖。两边合起来才是一条完整的链路。
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
const { check, finish } = createChecker("出站身份对账")

const { registerEditorService, resetEditorService } = await import("../editor/service.js")
const { config } = await import("../components/config.js")
const { pushRoster, ROSTER_QQ } = await import("../model/roster.js")
const { fillEntry } = await import("../components/fill-entry.js")
const { decodeIdentity, verifyIdentity, verifyWindow } = await import("../model/identity.js")

const KEY = config.editor.sign_key
const MEMBER = { qq: "10001", nick: "小伙01" }
/** 桩 Bot：一个群、一个成员（名单推送要有内容才发得出去） */
globalThis.Bot = {
  pickGroup: () => ({ getMemberMap: () => new Map([[MEMBER.qq, { user_id: MEMBER.qq, card: MEMBER.nick, nickname: "" }]]) }),
}

/** 进程内的假编辑器：记下调用，按 `failNext` 模拟一次失败 */
const calls = []
let failNext = false
registerEditorService({
  roster: async (caller, body) => {
    calls.push({ caller, body })
    if (failNext) throw new Error("编辑器那边炸了（模拟）")
    return { renamed: 2, removed: 1 }
  },
})

/** 名单推送真调一次（失败会在这里直接冒出来） */
const pushed = await pushRoster()
/** 填报入口的两种形态：群里那条带链接标记的长链接、私聊那条带窗口的长链 */
const entry = fillEntry({ e: { user_id: MEMBER.qq }, nickname: () => MEMBER.nick }, ["幽境危战"], [], { nonce: "TESTLINK" })
const managerEntry = fillEntry({ e: { user_id: MEMBER.qq }, nickname: () => MEMBER.nick }, ["幽境危战"], [], { manager: true })
const urlOf = text => (String(text).match(/https?:\/\/\S+/) ?? [""])[0]

await check("名单推送走进程内直调（对账不是空跑）", () => {
  if (!pushed.ok) throw new Error(`名单推送没成功：${JSON.stringify(pushed)}`)
  if (calls.length !== 1) throw new Error(`编辑器收到 ${calls.length} 次 roster 调用（期望 1）`)
  const { caller, body } = calls[0]
  if (String(caller?.qq) !== ROSTER_QQ) throw new Error(`推送身份不是机器人：${JSON.stringify(caller)}`)
  if (body?.group !== "999888") throw new Error(`推送的群号不对：${JSON.stringify(body?.group)}`)
  if (!Array.isArray(body?.members) || body.members.length !== 1 || body.members[0]?.qq !== MEMBER.qq)
    throw new Error(`推来的名单不对：${JSON.stringify(body?.members)}`)
  if (pushed.count !== 1) throw new Error(`回执里的人数不对：${pushed.count}`)
  if (pushed.renamed !== 2 || pushed.removed !== 1) throw new Error(`对账结果没透传：${JSON.stringify(pushed)}`)
})

await check("推送失败不重试、也不吞错（HTTP 超时那一层已经不存在）", async () => {
  const before = calls.length
  failNext = true
  const bad = await pushRoster()
  failNext = false
  if (bad.ok) throw new Error(`编辑器报错却回了成功：${JSON.stringify(bad)}`)
  if (!/编辑器那边炸了/.test(String(bad.error))) throw new Error(`错误没透出来：${JSON.stringify(bad.error)}`)
  if (calls.length !== before + 1) throw new Error(`失败后被重试了：${calls.length - before} 次`)
  const again = await pushRoster()
  if (!again.ok) throw new Error(`失败一次之后就推不动了：${JSON.stringify(again)}`)
  if (calls.length !== before + 2) throw new Error(`恢复后调用次数不对：${calls.length - before}`)
})

await check("群里那条填报长链接带身份、当期窗口与链接标记（不再走 /s/ 短链）", () => {
  const link = urlOf(entry.link)
  if (link.length > 255) throw new Error(`填报长链接超过 255 字符（QQ 群内会被风控）：${link.length} ${link}`)
  if (link.includes("/s/")) throw new Error(`不该再发短链：${link}`)
  const url = new URL(link)
  const u = url.searchParams.get("u")
  const id = verifyIdentity(u, url.searchParams.get("s"), KEY)
  if (!id || id.qq !== MEMBER.qq) throw new Error(`填报链接的身份不对：${link}`)
  if (!verifyWindow(url.searchParams.get("w"), url.searchParams.get("ws"), { qq: id.qq }, KEY))
    throw new Error(`填报链接没有可用的时间窗：${link}`)
  if (!new URLSearchParams(url.hash.replace(/^#/, "")).get("v"))
    throw new Error(`填报链接没有链接标记：${link}`)
})

await check("私聊那条管理长链接带身份**也**带当期时间窗（5 分钟作废）", () => {
  const url = new URL(urlOf(managerEntry.link))
  const u = url.searchParams.get("u")
  const id = verifyIdentity(u, url.searchParams.get("s"), KEY)
  if (!id || id.qq !== MEMBER.qq) throw new Error(`管理链接的身份不对：${urlOf(managerEntry.link)}`)
  if (!verifyWindow(url.searchParams.get("w"), url.searchParams.get("ws"), { qq: id.qq }, KEY))
    throw new Error(`管理链接没有可用的时间窗：${urlOf(managerEntry.link)}`)
})

/** 注册表是进程级单例：收掉，别把假 service 留给别的套件 */
resetEditorService()
/** 临时目录跟着套件清掉（与其它套件同一个口径：跑完不脏 %TEMP%） */
fs.rmSync(env.dir, { recursive: true, force: true })
await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
