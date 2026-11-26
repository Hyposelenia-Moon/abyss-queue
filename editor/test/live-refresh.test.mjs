/** 实时刷新（别人的改动自动进来）+ 行级冲突（我改的那几行有没有被人动过） */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { shared } from "./plugin.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"
/** 端口一律现要：套件之间不抢固定端口（见 test/_helper.mjs） */
import { freePort, createSoftChecker } from "../../test/_helper.mjs"
import { cookieJar } from "./harness.mjs"
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"

const { signIdentity, signWindow } = await shared("model/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-live-"))
const TOKEN = "live-token"
const SIGN_KEY = "live-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }

const admins = path.join(tmp, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

const { check, finish } = createSoftChecker("实时刷新/行级冲突")
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
    // 指纹只由那 7 列的值决定 ⇒ 表没变时连着读两次必须一模一样。
    await check("同一行连着两次读到的指纹一样（指纹只由那 7 列的值决定）", async () => {
      const one = (await req("/api/data", { who: OWNER })).json
      const two = (await req("/api/data", { who: OWNER })).json
      const a = one.sheets[0].rows.find(x => x.row === rowA.row)
      const b = two.sheets[0].rows.find(x => x.row === rowA.row)
      if (String(a.fp) !== String(b.fp)) throw new Error(`${a.fp} ≠ ${b.fp}`)
    })
    // **行级判据的核心**：别人改的是**别的行**时，我拿着旧整表 version 也照样能存。
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

// 页面侧已退场（2026-11 九页重写，保留记录以免有人照着旧文档找回这套能力）

/* ------------------------------ 入口 ------------------------------ */

try {
  console.log("服务端：")
  await runServer()
} catch (err) {
  check.fail()
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

await finish()
