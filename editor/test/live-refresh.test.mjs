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
    await req("/api/save", { who: OWNER, body: { sheet: sheetName, rows: [{ row: rowB.row, values: { ...rowB, note: "再改一次" } }] } })
    const after = await req("/api/version", { query: { fast: "1" } })
    check("写表之后 `?fast=1` 报的是新指纹（缓存按 mtime:size 失效）", after.json.version !== cheap.json.version, `${cheap.json.version} → ${after.json.version}`)
  } finally {
    ed.child.kill()
    await wait(300)
  }
}

/* ------------------------------ 页面 ------------------------------ */

/**
 * 页面侧：一个可变的"远端表" + 假时钟
 *
 * `remote` 就是服务端那一份（`dataFor` 每次读它），改它就是"别人改了表"；
 * `version` 单独放，方便让"指纹变了"与"数据变了"分别发生。
 */
const runPage = async () => {
  const remote = makeData({ role: "admin", readonly: false }, "v1")
  /** 再摆一行（第 11 行）：行级冲突那条要验"只挂起撞车的那一行，别的行照旧存" */
  remote.sheets[0].rows.push({
    row: 11,
    seq: 2,
    nickname: "丙",
    gameName: "丙的游戏",
    anchor: "阿修Axiu",
    goal: "困难满花",
    strength: "低配",
    note: "",
    status: "排队中",
    fp: "1".repeat(16),
  })
  remote.sheets[0].taken = [10, 11]
  let version = "v1"
  const timers = makeFakeTimers()
  const h = bootPage({
    dataFor: () => remote,
    versionReply: () => ({ status: 200, body: { ok: true, version } }),
    /**
     * 让保存**失败**（500）：这一组要验的是"合并时不许动我的草稿"，
     * 而保存成功会重读数据、把草稿清掉（那时就没有"我正在改"这回事了）。
     */
    saveReply: () => ({ status: 500, body: { ok: false, error: "（套件：故意失败）" } }),
    timers,
  })
  await h.ready()
  /** 初始加载：一次 `/api/data` */
  const dataReads = () => h.reads().length
  check("页面开局先读一次数据、并排上探测", dataReads() === 1 && timers.pending >= 1, `reads=${dataReads()} pending=${timers.pending}`)

  /* --- 探测：版本没变就只问一句，不拉数据 --- */
  version = "v1"
  const versionCalls = () => h.calls.filter(c => c.url.includes("api/version")).length
  timers.advance(5000)
  await h.ready()
  check("到点探一次表版本", versionCalls() === 1, `version=${versionCalls()}`)
  check("版本没变 ⇒ **不**去拉整份数据（省流量）", dataReads() === 1, `reads=${dataReads()}`)

  /* --- 别人改了他那一行：我没草稿 ⇒ 直接更新 --- */
  version = "v2"
  remote.sheets[0].rows[0].note = "别人写的备注"
  remote.sheets[0].rows[0].fp = "b".repeat(16)
  remote.version = "v2"
  timers.advance(5000)
  await h.ready()
  check("版本变了 ⇒ 拉一次数据并合并", dataReads() === 2, `reads=${dataReads()}`)
  check("我没碰过的行 ⇒ 界面上直接变成别人的值", h.cellValue(10, "note") === "别人写的备注", h.cellValue(10, "note"))
  check("合并之后版本号跟着更新（否则每 5 秒白拉一次）", h.probe.version === "v2", h.probe.version)
  check("轻提示说明「别人的改动已经进来了」", () => {
    const t = h.liveText()
    if (!t.includes("已自动更新")) throw new Error(`#liveHint 里是「${t}」`)
  })

  /* --- 我改过的行：一个字都不许动 --- */
  h.type(h.rowNo(10), "note", "我正在打的东西")
  remote.sheets[0].rows[0].note = "别人又改了"
  remote.sheets[0].rows[0].fp = "c".repeat(16)
  remote.version = "v3"
  version = "v3"
  /**
   * 分成两段推进：先让自动保存到点（桩里故意让它 500 ⇒ 草稿留住），`flush` 之后它的续体才算跑完，
   * 再让探测到点。合成一段推的话，假时钟里"保存还在飞"（请求的续体还在微任务队列里），
   * 而"有保存在飞时不探"是**产品口径**（见 `pollVersion`）——那验的就不是合并了。
   */
  timers.advance(1500)
  await h.ready()
  timers.advance(3500)
  await h.ready()
  check("我改过的行**不被远程覆盖**", h.cellValue(10, "note") === "我正在打的东西", h.cellValue(10, "note"))
  check("两边都改过 ⇒ 记进冲突集合、行上打标记", h.probe.clashes.length === 1 && h.rowNo(10).className.includes("clash"), JSON.stringify(h.probe.clashes))
  check("提示条给两个动作（用表里的 / 保留我的）", () => {
    const t = h.liveText()
    const btns = h.liveButtons().map(b => b.textContent).join("/")
    if (!t.includes("两边都改过")) throw new Error(`文案里没有"两边都改过"：${t}`)
    if (btns !== "用表里的/保留我的") throw new Error(`按钮是「${btns}」`)
  })

  /* --- 还没决定时保存：基线必须还是**我读到的那一版**（不许偷偷拿别人的当基线） --- */
  h.type(h.rowNo(10), "note", "我正在打的东西2")
  timers.advance(1500)
  await h.ready()
  const pending = h.posts("api/save").at(-1)
  check(
    "「两边都改过」还没决定时：保存带的仍是**旧**基线（决定了才换）",
    pending?.body?.base?.[10] === "b".repeat(16),
    JSON.stringify(pending?.body?.base ?? null),
  )

  /* --- 「保留我的」：值不变、但基准换成对方那一版（下次保存不再撞车） --- */
  h.liveButtons()[1].onclick()
  await h.ready()
  check("「保留我的」之后冲突标记消失、我的值还在", h.probe.clashes.length === 0 && h.cellValue(10, "note") === "我正在打的东西2", JSON.stringify(h.probe.clashes))

  /* --- 保存请求带上行指纹 --- */
  timers.advance(1500)
  await h.ready()
  const saves = h.posts("api/save")
  check(
    "保存请求带 `base`：基线换成了对方那一版（「保留我的」之后不会再撞车）",
    saves.length >= 1 && saves[saves.length - 1].body?.base?.[10] === "c".repeat(16),
    JSON.stringify(saves[saves.length - 1]?.body ?? null),
  )

  /* --- 页面不在前台 ⇒ 不探（省电省流量） --- */
  const before = versionCalls()
  h.document.hidden = true
  timers.advance(5000)
  await h.ready()
  check("`document.hidden` 时不探", versionCalls() === before, `${before} → ${versionCalls()}`)
  h.document.hidden = false
  h.fire("visibilitychange")
  /** 立刻补探排的是 0 毫秒的计时器：假时钟要推一格它才跑 */
  timers.advance(0)
  await h.ready()
  check("切回前台立刻补探一次", versionCalls() === before + 1, `${before} → ${versionCalls()}`)

  /* --- 探测失败 ⇒ 退避（5s → 10s） --- */
  const t3 = makeFakeTimers()
  const h3 = bootPage({
    dataFor: () => remote,
    versionReply: () => ({ status: 500, body: { ok: false, error: "（套件：探测失败）" } }),
    timers: t3,
  })
  await h3.ready()
  const vCalls = () => h3.calls.filter(c => c.url.includes("api/version")).length
  t3.advance(5000)
  await h3.ready()
  check("探测失败先记一笔、不打扰用户", vCalls() === 1 && h3.probe.pollFail === 1, `calls=${vCalls()} fail=${h3.probe.pollFail}`)
  t3.advance(5000)
  await h3.ready()
  check("失败之后退避到 10 秒：过半程不该再探", vCalls() === 1, `calls=${vCalls()}`)
  t3.advance(5000)
  await h3.ready()
  check("再走完第二个 5 秒才探（共 10 秒）", vCalls() === 2, `calls=${vCalls()}`)

  /* --- 行级 409：只挂起那几行，其余行照旧自动存 --- */
  const t2 = makeFakeTimers()
  const h2 = bootPage({
    dataFor: () => remote,
    versionReply: () => ({ status: 200, body: { ok: true, version } }),
    /** 只让第 11 行撞车（第 10 行照旧能存） */
    saveReply: (n, body) => {
      const rows = (body?.rows ?? []).map(r => r.row)
      if (rows.includes(11)) return { status: 409, body: { ok: false, conflict: true, rows: [11], error: "第 11 行在你编辑期间被别人改过" } }
      return { status: 200, body: { ok: true, written: rows.length, cleared: 0, ignored: [], notices: [], version: "v9" } }
    },
    timers: t2,
  })
  await h2.ready()
  h2.type(h2.rowNo(10), "note", "我的-10")
  h2.type(h2.rowNo(11), "note", "我的-11")
  check("前置：两行都有草稿", h2.probe.edited.size === 2, JSON.stringify([...h2.probe.edited.keys()]))
  t2.advance(1500)
  await h2.ready()
  check(
    "行级冲突只挂起撞车的那一行",
    h2.probe.blocked.length === 1 && h2.probe.blocked[0].endsWith("\u000011"),
    JSON.stringify(h2.probe.blocked),
  )
  check("提示条按「只有这几行没保存」来说", () => {
    const t = h2.conflictText()
    if (!t.includes("第 11 行")) throw new Error(`提示条里没有行号：${t}`)
  })
  check("状态的文案是「未保存（有改动）」而不是「已保存」", () => {
    const t = h2.el("saveState").textContent
    if (!t.includes("未保存")) throw new Error(`状态字是「${t}」`)
  })
  /** 剩下的行接着存：这一发里**不该**再有第 11 行，其余行照旧写进去 */
  t2.advance(1500)
  await h2.ready()
  const lastSave = h2.posts("api/save").at(-1)
  const lastRows = (lastSave?.body?.rows ?? []).map(r => r.row)
  check(
    "其余行照旧自动保存（这一发里没有撞车那一行）",
    lastRows.includes(10) && !lastRows.includes(11),
    JSON.stringify(h2.posts("api/save").map(c => (c.body?.rows ?? []).map(r => r.row))),
  )
}

/* ------------------------------ 入口 ------------------------------ */

try {
  console.log("服务端：")
  await runServer()
  console.log("页面：")
  await runPage()
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 实时刷新/行级冲突 验证失败 ${failed} 项` : "\n✅ 实时刷新/行级冲突 验证通过")
process.exitCode = failed ? 1 : 0
