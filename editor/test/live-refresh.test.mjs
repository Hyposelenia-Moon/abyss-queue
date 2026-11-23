/**
 * 实时刷新（别人的改动自动进来）+ 行级冲突（我改的那几行有没有被人动过）
 *
 * 分两半，缺一半都说明不了问题：
 *   - **服务端**（起一个真编辑器）：`/api/data` 下发行指纹；带 `base` 的保存按**行**判冲突
 *     （别人改了别的行不再连坐）；不带 `base` 的照旧整表指纹（老口径留给机器人 / 旧页面）；
 *     `/api/version?fast=1` 的缓存口径与全量一致。
 *   - **页面**（`page-vm.mjs` 的 node:vm 脚手架）：探测节奏（5 秒、页面不可见不探、失败退避）、
 *     变了才拉数据、合并时**有草稿的行一个字都不动**、"两边都改过"的两个动作各是什么意思、
 *     保存请求带上行指纹、行级 409 **只挂起那几行**（其余行照旧自动保存）。
 *
 * 用法：node editor/test/live-refresh.test.mjs [xlsx路径]
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
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"

const { signIdentity, signWindow } = await shared("model/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-live-"))
const TOKEN = "live-token"
const SIGN_KEY = "live-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }

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
const flush = () => new Promise(r => setImmediate(r))
const wait = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------ 服务端 ------------------------------ */

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
  ]
  const env = { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" }
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", d => (log += d))
  child.stderr.on("data", d => (log += d))
  return { port, child, log: () => log }
}

const jars = new Map()
const jarOf = who => {
  const key = who ? `qq:${who.qq}` : "(无身份)"
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}

const makeReq = port => async (p, { who = null, body = null, method, query = {} } = {}) => {
  const q = [`k=${TOKEN}`, ...Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)]
  if (who) {
    const id = signIdentity(who, SIGN_KEY)
    q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
    const win = signWindow(who, SIGN_KEY)
    if (win) q.push(`w=${win.w}`, `ws=${encodeURIComponent(win.ws)}`)
  }
  const jar = jarOf(who)
  const init = { method: method ?? (body ? "POST" : "GET"), headers: { ...jar.headers } }
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

const runServer = async () => {
  const ed = await startEditor()
  const req = makeReq(ed.port)
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await wait(500)
      try {
        up = (await req("/healthz")).status === 200
      } catch {}
    }
    if (!up) throw new Error(`编辑器没起来：\n${ed.log()}`)

    const first = (await req("/api/data", { who: OWNER })).json
    const sheetName = first.sheets[0].name
    const rows = first.sheets[0].rows
    if (rows.length < 2) throw new Error("这一榜的行太少，测不了「改别的行不连坐」")
    const rowA = rows[0]
    const rowB = rows[1]

    check("每一行都带指纹（页面拿它当基线）", rows.every(r => /^[0-9a-f]{16}$/.test(String(r.fp ?? ""))), JSON.stringify(Object.keys(rows[0] ?? {})))
    /**
     * 指纹只由那 7 列的值决定 ⇒ 表没变时连着读两次必须一模一样。
     *
     * 注意**不能拿第一次那份比**：第一次 `/api/data` 自己会顺手对账（按群名片改昵称、
     * 到点把「等待开启」翻成「排队中」），表确实变了，指纹跟着变才是对的。
     */
    await check("同一行连着两次读到的指纹一样（指纹只由那 7 列的值决定）", async () => {
      const one = (await req("/api/data", { who: OWNER })).json
      const two = (await req("/api/data", { who: OWNER })).json
      const a = one.sheets[0].rows.find(x => x.row === rowA.row)
      const b = two.sheets[0].rows.find(x => x.row === rowA.row)
      if (String(a.fp) !== String(b.fp)) throw new Error(`${a.fp} ≠ ${b.fp}`)
    })

    /**
     * **行级判据的核心**：别人改的是**别的行**时，我拿着旧整表 version 也照样能存。
     *
     * 老口径（只比整表指纹）在这一步必然 409——多人同时填表时这是天天发生的事。
     */
    const moveB = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: rowB.row, values: { ...rowB, note: "别人改的" } }] },
    })
    check("前置：另一行被别人改了", moveB.json.ok === true, JSON.stringify(moveB.json))
    const notConnected = await req("/api/save", {
      who: OWNER,
      body: {
        sheet: sheetName,
        /** 故意的：整表 version 还是**旧**的（别人刚改过别的行），但这一行的指纹是对的 */
        version: first.version,
        base: { [rowA.row]: rowA.fp },
        rows: [{ row: rowA.row, values: { ...rowA, note: "我改的-不连坐" } }],
      },
    })
    check(
      "别人改了**别的行** ⇒ 我这一行照旧存得进去（不连坐）",
      notConnected.json.ok === true,
      `HTTP ${notConnected.status} ${JSON.stringify(notConnected.json)}`,
    )
    const afterMine = (await req("/api/data", { who: OWNER })).json.sheets[0].rows.find(r => r.row === rowA.row)
    check("那一行的值真的写进去了", afterMine?.note === "我改的-不连坐", JSON.stringify(afterMine))

    /** 同**一行**被别人动过：必须挡住，而且只报那一行 */
    const fresh = (await req("/api/data", { who: OWNER })).json
    const freshSheet = fresh.sheets[0]
    const freshA = freshSheet.rows.find(r => r.row === rowA.row)
    await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: rowA.row, values: { ...freshA, note: "别人又改了" } }] },
    })
    const clash = await req("/api/save", {
      who: OWNER,
      body: {
        sheet: sheetName,
        base: { [freshA.row]: freshA.fp },
        rows: [{ row: freshA.row, values: { ...freshA, note: "我基于旧值的改动" } }],
      },
    })
    check("同一行被别人改过 ⇒ 409 且只报那一行", clash.status === 409 && (clash.json.rows ?? []).join() === String(freshA.row), JSON.stringify(clash.json))
    const live = (await req("/api/data", { who: OWNER })).json.sheets[0].rows.find(r => r.row === freshA.row)
    check("被拒的那一行一个字都没写进去", live?.note === "别人又改了", JSON.stringify(live))

    /** 老口径（不带 `base`）：照旧整表指纹连坐 */
    const legacy = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, version: fresh.version, rows: [{ row: rowB.row, values: { ...rowB, note: "老客户端" } }] },
    })
    check("不带 base（机器人 / 旧页面）：照旧整表指纹 409", legacy.status === 409 && !legacy.json.rows, JSON.stringify(legacy.json))

    /** 新增行：`base` 给空串 = "我读到的是空行"，表里已经被别人填上就该挡 */
    const now = (await req("/api/data", { who: OWNER })).json.sheets[0]
    const used = new Set(now.rows.map(r => r.row))
    let free = 0
    for (let r = now.dataStart; r <= now.dataEnd; r++) if (!used.has(r)) { free = r; break }
    if (!free) throw new Error("这一榜没有空行可用")
    const occupy = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: free, values: { nickname: "刚填上的人", gameName: "游戏名", anchor: now.anchors[0], goal: now.options.goal[0], status: "排队中" } }] },
    })
    const occupied = await req("/api/save", {
      who: OWNER,
      body: {
        sheet: sheetName,
        base: { [free]: "" },
        rows: [{ row: free, values: { nickname: "我也想占这行", gameName: "游戏名", anchor: now.anchors[0], goal: now.options.goal[0], status: "排队中" } }],
      },
    })
    check("前置：空行刚被别人填上", occupy.json.ok === true, JSON.stringify(occupy.json))
    check("我以为这一行是空的、其实刚被人填上 ⇒ 409（老口径会静默覆盖）", occupied.status === 409, JSON.stringify(occupied.json))

    /** 探测用的便宜版本：写表之后必须跟上（否则页面永远拉不到新数据） */
    const cheap = await req("/api/version", { query: { fast: "1" } })
    const exact = await req("/api/version")
    const newest = (await req("/api/data", { who: OWNER })).json.version
    check("`?fast=1` 与全量指纹一致、且等于当前那一版", cheap.json.version === exact.json.version && cheap.json.version === newest, `${cheap.json.version} / ${exact.json.version} / ${newest}`)
    const current = (await req("/api/data", { who: OWNER })).json.sheets
      .find(s => s.name === sheetName).rows.find(r => r.nickname === rowB.nickname)
    if (!current) throw new Error("待更新行已不存在")
    const saved = await req("/api/save", {
      who: OWNER,
      body: { sheet: sheetName, rows: [{ row: current.row, values: { ...current, note: "再改一次" } }] },
    })
    if (saved.status !== 200 || saved.json.ok !== true) throw new Error(`保存失败：${JSON.stringify(saved)}`)
    const after = await req("/api/version", { query: { fast: "1" } })
    check("写表之后 `?fast=1` 报的是新指纹（缓存按 mtime:size 失效）", after.json.version !== cheap.json.version, `${cheap.json.version} → ${after.json.version}`)
  } finally {
    ed.child.kill()
    await wait(300)
  }
}

/* ------------------------------ 页面 ------------------------------ */

/**
 * 页面侧已退场（2026-11 九页重写，保留记录以免有人照着旧文档找回这套能力）
 *
 * 旧页面有一整套「每 5 秒探 /api/version → 变了才拉数据 → 有草稿的行一个字不动 →
 * 两边都改过就挂起那一行、给『用表里的 / 保留我的』两个动作」的机制。重写后的编辑器
 * **不再做自动刷新**：保存失败就把状态字写成「保存失败：…」并 toast，草稿留在
 * `st.dirty` 里等人重试；行级 base 指纹仍会发给服务端（服务端行为由上面的服务端断言守着），
 * 但页面自己不开定时器、不弹常驻冲突条。
 *
 * 所以本套件现在**只测服务端那一半**（行指纹、行级判据、老口径 409、?fast=1 缓存）。
 * 哪天把自动刷新加回来，再把 runPage 那一段按新实现重写。
 */

/* ------------------------------ 入口 ------------------------------ */

try {
  console.log("服务端：")
  await runServer()
  
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 实时刷新/行级冲突 验证失败 ${failed} 项` : "\n✅ 实时刷新/行级冲突 验证通过")
process.exitCode = failed ? 1 : 0
