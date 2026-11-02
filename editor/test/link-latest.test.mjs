/**
 * 链接"**最新一条有效**"：每个 QQ 只有最新发出的那一条能写，旧的一律只读
 *
 * 发链接时生成一个随机标记（`#v=`），机器人把它记在登记簿里（`model/editor-links.js`），
 * 编辑器只认最新那一条可写；没有 `v` 的老链接一律只读。
 *
 * 分两层：
 *   - **模块层**：`issueLink` / `latestLinkOf`（登记簿）、`fillEntry`（普通长链接带 `v`；管理员那份不带）；
 *   - **真编辑器**：最新那条可写；**被新的取代 ⇒ 只读 + 拒写**；
 *     老链接（没有 `v`）⇒ 只读；**登记簿里没有这个 QQ ⇒ 不据此拒人**；管理员不受这条约束。
 *
 * 用法：node editor/test/link-latest.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { shared } from "./plugin.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"
/** 端口一律现要：套件之间不抢固定端口（见 test/_helper.mjs） */
import { freePort } from "../../test/_helper.mjs"
import { cookieJar } from "./harness.mjs"

const { signedEditorQuery, decodeIdentity } = await shared("model/identity.js")
const { fillEntry } = await shared("components/fill-entry.js")
const { config } = await shared("components/config.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-links-"))
const TOKEN = "links-token"
const SIGN_KEY = "links-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }
const BOT = { qq: "0", nick: "群成员名单" }
const MEMBER = { qq: "5001", nick: "群里的人" }

const admins = path.join(tmp, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

let failed = 0
/**
 * 断言：`ok` 收**布尔**或**回调 / async 回调**（抛错即失败）
 *
 * 回调那种写法必须真的执行（AGENTS.md §3.7：写成 `if (ok)` 的话回调永远是"真值"，
 * 断言一条都没跑还印 ✅）。
 */
const check = (name, ok, detail = "") => {
  const pass = () => console.log(`  ✅ ${name}`)
  const fail = why => {
    failed++
    console.log(`  ❌ ${name}${detail || why ? `\n     ${detail || why}` : ""}`)
  }
  if (typeof ok !== "function") return ok ? pass() : fail("")
  let out
  try {
    out = ok()
  } catch (err) {
    return fail(err?.message ?? String(err))
  }
  if (out && typeof out.then === "function") return out.then(pass, err => fail(err?.message ?? String(err)))
  return pass()
}
const wait = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------ 模块层 ------------------------------ */

const moduleLayer = async () => {
  const now = Date.now()

  /** 登记簿（插件侧那一半）：本机文件落在插件 data 下，套件靠 ABYSS_QUEUE_TEST_PATHS 指到临时目录 */
  const { issueLink, latestLinkOf } = await shared("model/editor-links.js")
  check("登记簿：登记之后能读出最新那一条；两次签发的标记不同", () => {
    const a = issueLink(MEMBER.qq, now)
    const b = issueLink(MEMBER.qq, now + 1000)
    if (!a.v || a.v.length !== 8) throw new Error(`标记长度不对：${JSON.stringify(a)}`)
    if (!/^\d{6}$/.test(a.code)) throw new Error(`填表口令不是 6 位数字：${JSON.stringify(a)}`)
    if (!/^\d{6}$/.test(b.code)) throw new Error(`填表口令不是 6 位数字：${JSON.stringify(b)}`)
    if (a.v === b.v) throw new Error("两次签发的标记一样（那就分不出新旧了）")
    if (latestLinkOf(MEMBER.qq) !== b.v) throw new Error(`最新的是 ${latestLinkOf(MEMBER.qq)}，期望 ${b.v}`)
  })

  /** 填报入口：普通长链接带 `v`；管理员那一份（私聊长地址）**不带** */
  const oldRemote = config.remote
  config.remote = { url: "https://example.com/queue", token: "tok", sign_key: SIGN_KEY }
  const ctx = { e: { user_id: MEMBER.qq }, nickname: () => MEMBER.nick }
  try {
    check("填报入口：普通长链接把标记带上（`#v=`）", () => {
      const entry = fillEntry(ctx, ["剧诗"], [], { now, nonce: "AAA" })
      if (!entry.link.includes("#v=AAA")) throw new Error(entry.link)
      if (entry.link.includes("/s/")) throw new Error(`不该再走短链：${entry.link}`)
      if (!entry.link.includes("w=") || !entry.link.includes("ws=")) throw new Error(`应当带时间窗：${entry.link}`)
    })
    check("填报入口：没给标记（老调用方）⇒ 链接里没有 v（照旧能用，只是只读）", () => {
      const entry = fillEntry(ctx, ["剧诗"], [], { now })
      if (entry.link.includes("#v=")) throw new Error(entry.link)
    })
    check("填报入口：**管理员那一份不带标记**（判据是白名单 + 5 分钟窗口，与链接新旧无关）", () => {
      const entry = fillEntry(ctx, ["剧诗"], [], { now, nonce: "AAA", manager: true })
      if (entry.link.includes("v=AAA")) throw new Error(entry.link)
      if (!entry.link.includes("w=") || !entry.link.includes("ws=")) throw new Error(`应当走带窗口的长地址：${entry.link}`)
    })
    check("填报入口：名片回落成 QQ 号时，链接身份改用候选里的群昵称", () => {
      /** 现场：复制到浏览器后页面把 QQ 号当群昵称显示；链接本身就不该签 QQ。 */
      const qqCtx = {
        e: { user_id: MEMBER.qq },
        nickname: () => MEMBER.qq,
        nicknames: () => [MEMBER.qq, MEMBER.nick],
      }
      const entry = fillEntry(qqCtx, ["剧诗"], [], { now, nonce: "AAA" })
      const url = new URL(String(entry.link).replace(/^.*?：/, ""))
      const who = decodeIdentity(url.searchParams.get("u"))
      if (who?.nick !== MEMBER.nick) throw new Error(`签成了「${who?.nick}」：${entry.link}`)
    })
  } finally {
    config.remote = oldRemote
  }
}

/* ------------------------------ 真编辑器 ------------------------------ */

const startEditor = async () => {
  const dir = path.join(tmp, "editor")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "queue.xlsx")
  fs.copyFileSync(SRC, file)
  const cfg = path.join(dir, "config.yaml")
  fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")
  const port = await freePort()
  const args = [
    path.resolve(import.meta.dirname, "..", "editor.mjs"),
    "--port", String(port),
    "--token", TOKEN,
    "--sign-key", SIGN_KEY,
    "--file", file,
    "--admins", admins,
    "--roster-qq", "0",
  ]
  const env = { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" }
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", d => (log += d))
  child.stderr.on("data", d => (log += d))
  return { port, dir, child, log: () => log }
}

const jars = new Map()
const jarOf = who => {
  const key = who ? `qq:${who.qq}` : "(无身份)"
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}

const makeReq = port => async (p, { who = null, body = null, method, link = "", query = {} } = {}) => {
  const q = [`k=${TOKEN}`, ...Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)]
  if (who) {
    const id = sharedSign(who)
    q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
    if (id.w) q.push(`w=${id.w}`, `ws=${encodeURIComponent(id.ws)}`)
  }
  const jar = jarOf(who)
  const init = { method: method ?? (body ? "POST" : "GET"), headers: { ...jar.headers } }
  /** 链接标记走请求头（`x-abyss-link`）：页面就是这么发的 */
  if (link) init.headers["x-abyss-link"] = link
  if (body) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`http://127.0.0.1:${port}${p}?${q.join("&")}`, init)
  jar.take(res)
  const text = await res.text()
  let out = null
  try {
    out = JSON.parse(text)
  } catch {
    out = { __raw: text.slice(0, 200) }
  }
  return { status: res.status, json: out }
}

const { signIdentity, signWindow } = await shared("model/identity.js")
const sharedSign = who => {
  const id = signIdentity(who, SIGN_KEY)
  const win = signWindow(who, SIGN_KEY)
  return { ...id, w: win?.w, ws: win?.ws }
}
const signedQueryOf = who =>
  Object.fromEntries(
    new URLSearchParams(signedEditorQuery({ qq: who.qq, nick: who.nick, token: TOKEN, signKey: SIGN_KEY })),
  )

const runEditor = async () => {
  const ed = await startEditor()
  const req = makeReq(ed.port)
  const linksFile = path.join(ed.dir, "abyss-editor-links.json")
  const writeLinks = obj => fs.writeFileSync(linksFile, JSON.stringify(obj), "utf8")
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await wait(500)
      try {
        up = (await req("/healthz")).status === 200
      } catch {}
    }
    if (!up) throw new Error(`编辑器没起来：\n${ed.log()}`)

    /** 前置：推一份名单（本群守卫要求"他在名单里"；不然写表被拒就分不清是哪一条规矩拦的了） */
    const rosterQuery = signedEditorQuery({ qq: BOT.qq, nick: BOT.nick, token: TOKEN, signKey: SIGN_KEY })
    const pushed = await fetch(`http://127.0.0.1:${ed.port}/api/roster?${rosterQuery}`, {
      method: "POST",
      headers: { ...jarOf(BOT).headers, "content-type": "application/json" },
      body: JSON.stringify({ group: "999888", members: [{ qq: MEMBER.qq, nick: MEMBER.nick }] }),
    })
    jarOf(BOT).take(pushed)
    check("前置：名单推上去了", (await pushed.json()).ok === true)

    const sheet = (await req("/api/data", { who: OWNER })).json.sheets[0]
    const sheetName = sheet.name
    const rowA = sheet.rows[0].row
    const values = { ...sheet.rows[0], note: "最新链接写的" }

    /**
     * 普通人的长链接：这条链接第一次打开就必须可写。
     * 回归现场「群内普通人直接打开链接 ⇒ 只读、没有新增一行」——长地址少了 `v`。
     */
    const longCtx = { e: { user_id: MEMBER.qq }, nickname: () => MEMBER.nick }
    const oldRemote = config.remote
    const codeLink = `http://127.0.0.1:${ed.port}/queue/?k=${encodeURIComponent(TOKEN)}`
    writeLinks({ [MEMBER.qq]: { v: "EEEEEEEE", at: Date.now(), code: "123456", link: codeLink } })
    {
      const entryPage = await fetch(`http://127.0.0.1:${ed.port}/queue/`)
      const entryText = await entryPage.text()
      check("固定入口页：无口令也给 6 位数字填表口令输入页", () =>
        entryText.includes("6 位数字填表口令") && !entryText.includes("访问口令不对"),
      )
      check("固定入口页：链接末尾的 #code 会填入口令，缺失时保留手输", () =>
        entryText.includes("location.hash") &&
        entryText.includes("input.value=seed") &&
        entryText.includes('id="code"'),
      )
      check("固定入口页：不会拿本地访问口令自动跳进只读页", () =>
        !entryText.includes("abyss-editor-token"),
      )
      const resolved = await fetch(`http://127.0.0.1:${ed.port}/api/link-code?code=123456`)
      const out = await resolved.json()
      check("固定入口页：口令换回完整链接", () =>
        resolved.status === 200 && out.ok === true && out.url === codeLink,
      )
      writeLinks({ [MEMBER.qq]: { v: "EEEEEEEE", at: Date.now() - 6 * 60 * 1000, code: "123456", link: codeLink } })
      const expired = await fetch(`http://127.0.0.1:${ed.port}/api/link-code?code=123456`)
      check("固定入口页：超过 5 分钟的口令失效", () => expired.status === 410)
      writeLinks({ [MEMBER.qq]: { v: "EEEEEEEE", at: Date.now(), code: "123456", link: codeLink } })
    }
    try {
      config.remote = {
        ...oldRemote,
        url: `http://127.0.0.1:${ed.port}/queue`,
        token: TOKEN,
        sign_key: SIGN_KEY,
      }
      const entry = fillEntry(longCtx, ["剧诗"], [], { nonce: "EEEEEEEE" })
      const longUrl = new URL(String(entry.link).replace(/^.*?：/, ""))
      check("普通长链接带 v（不再被当成没标记的老链接）", () => {
        const hashV = new URLSearchParams(longUrl.hash.replace(/^#/, "")).get("v")
        if (!hashV) throw new Error(entry.link)
        if (!longUrl.searchParams.get("w") || !longUrl.searchParams.get("ws")) throw new Error(`缺时间窗：${entry.link}`)
      })
      /** 页面启动时会把 hash 里的 v 并进请求；这里照做，验证服务端判定 */
      const { k: _k, ...longQuery } = Object.fromEntries(longUrl.searchParams.entries())
      const hashV = new URLSearchParams(longUrl.hash.replace(/^#/, "")).get("v")
      if (hashV) longQuery.v = hashV
      const longView = await req("/api/data", { query: longQuery })
      check(
        "普通长链接直接打开：不是只读、没有 staleLink",
        longView.json?.perm?.staleLink === false && longView.json?.perm?.readonly === false && longView.json?.perm?.role === "self",
        JSON.stringify(longView.json?.perm),
      )
    } finally {
      config.remote = oldRemote
    }

    /**
     * 现场：复制到浏览器后，页面「群昵称」显示成 QQ 号。
     * 链接身份里的 `n` 是签发时写死的；服务端有群名单时必须以名单现用名为准。
     */
    writeLinks({ [MEMBER.qq]: { v: "BBBBBBBB", at: Date.now() } })
    const badNickView = await req("/api/data", {
      who: { qq: MEMBER.qq, nick: MEMBER.qq },
      link: "BBBBBBBB",
    })
    check(
      "链接身份里是 QQ 号时，页面仍按群名单显示群昵称",
      badNickView.json?.perm?.nick === MEMBER.nick,
      JSON.stringify(badNickView.json?.perm),
    )

    /** ① **最新那一条**：链接里的 v 与登记簿一致，页面据此可写 */
    writeLinks({ [MEMBER.qq]: { v: "AAAAAAAA", at: Date.now() } })
    const q1 = { ...signedQueryOf(MEMBER), v: "AAAAAAAA" }
    const freshView = await req("/api/data", { query: q1 })
    check(
      "最新那一条：不是只读、也没有 staleLink",
      freshView.json?.perm?.staleLink === false && freshView.json?.perm?.readonly === false && freshView.json?.perm?.role === "self",
      JSON.stringify(freshView.json?.perm),
    )
    const okSave = await req("/api/save", { query: q1, method: "POST", body: { sheet: sheetName, rows: [{ row: rowA, values }] } })
    check("最新那一条：写得进去", okSave.json?.ok === true, JSON.stringify(okSave.json))

    /** ② 换成新的标记 ⇒ 手里这条**被取代**：只读 + 拒写 */
    writeLinks({ [MEMBER.qq]: { v: "CCCCCCCC", at: Date.now() } })
    const staleView = await req("/api/data", { query: q1 })
    check(
      "被新的取代 ⇒ staleLink + 只读",
      staleView.json?.perm?.staleLink === true && staleView.json?.perm?.readonly === true,
      JSON.stringify(staleView.json?.perm),
    )
    const staleSave = await req("/api/save", { query: q1, method: "POST", body: { sheet: sheetName, rows: [{ row: rowA, values }] } })
    check(
      "被新的取代 ⇒ 拒写，并说清「回群里重发」",
      staleSave.status === 400 && String(staleSave.json.error).includes("取代") && String(staleSave.json.error).includes("#排队"),
      JSON.stringify(staleSave.json),
    )

    /** ③ 拿**新的**那条来：又能写（同一个人、同一台设备，不用做别的） */
    const q2 = { ...signedQueryOf(MEMBER), v: "CCCCCCCC" }
    const newView = await req("/api/data", { query: q2 })
    check("换成新的那一条：恢复可写", newView.json?.perm?.staleLink === false && newView.json?.perm?.readonly === false, JSON.stringify(newView.json?.perm))

    /** ④ **老链接**（没有 `v`）：只读 */
    const oldQuery = signedQueryOf(MEMBER)
    const oldView = await req("/api/data", { query: oldQuery })
    check("老链接：只读（`v` 分不出新旧，等于没编号的钥匙）", oldView.json?.perm?.staleLink === true && oldView.json?.perm?.readonly === true, JSON.stringify(oldView.json?.perm))

    /** ⑤ 登记簿里**没有这个 QQ**：判不了 ⇒ **不据此拒人**（宁放松一次，不能把人锁死） */
    writeLinks({})
    const unknown = await req("/api/data", { who: MEMBER, link: "DDDDDDDD" })
    check(
      "登记簿里没有他 ⇒ 不据此拒人（照旧按本群成员那档处理）",
      unknown.json?.perm?.staleLink === false && unknown.json?.perm?.readonly === false && unknown.json?.perm?.roam === true,
      JSON.stringify(unknown.json?.perm),
    )

    /** ⑥ **管理员不受这条约束**：登记簿里写的是别人的标记，主人照样能改 */
    writeLinks({ [OWNER.qq]: { v: "OWNERAAA", at: Date.now() } })
    const ownerView = await req("/api/data", { who: OWNER, link: "WRONGONE" })
    check("管理员：链接新旧与本条规矩无关（照旧能改）", ownerView.json?.perm?.staleLink === false && ownerView.json?.perm?.role === "admin", JSON.stringify(ownerView.json?.perm))
    const ownerSave = await req("/api/save", {
      who: OWNER,
      link: "WRONGONE",
      body: { sheet: sheetName, rows: [{ row: rowA, values: { ...values, note: "主人写的" } }] },
    })
    check("管理员：这条链接标记不对也写得进去", ownerSave.json?.ok === true, JSON.stringify(ownerSave.json))
  } finally {
    ed.child.kill()
    await wait(300)
  }
}

/* ------------------------------ 入口 ------------------------------ */

try {
  console.log("模块层：")
  await moduleLayer()
  console.log("真编辑器：")
  await runEditor()
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 链接新旧 验证失败 ${failed} 项` : "\n✅ 链接新旧 验证通过")
process.exitCode = failed ? 1 : 0
