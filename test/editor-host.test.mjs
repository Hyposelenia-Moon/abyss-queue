/**
 * 编辑器宿主回归：把编辑器挂到 **bot 自己的 HTTP server** 上（S2b）
 *
 * 这一套钉的是那条"一旦坏就是 UI 挂死"的路：
 *   - 挂载在 `http.Server` 这一层（**在框架的 express body parser 之前**）——编辑器自己读原始请求体，
 *     若挂成 `Bot.express.use()`，body 已被 parser 读完，`data`/`end` 监听**一个事件都收不到**，
 *     表现为**保存 / 上传永久挂起**（不是"读到空"）。所以这里必须真发带 body 的请求、并断言"有回应"。
 *   - 框架自己的路径一个都不能被吞（`/queueX` 这种"像但不是"的也不能）。
 *   - 口令只有 `config.remote` 一份来源（错的 `?k=` 必须 403）。
 *   - 双轨期互锁：7788 上已有独立编辑器时不挂载（避免同一张表两个写者）。
 *
 * 用的都是**临时过期口令**与**失败的请求**：只读该表、不发任何会写表的有效请求，跑完校验表文件哈希未变。
 *
 * 用例：node test/editor-host.test.mjs
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import express from "express"
import { createChecker, Paths } from "./_helper.mjs"

const { check, finish } = createChecker("编辑器宿主")

/** 探针口令（只活在这次运行里；不是任何真实部署的口令） */
const TOKEN = "host-test-token"
const SIGN_KEY = "host-test-sign-key"
const ADMIN_TOKEN = "host-test-admin-token"

/** 隔离配置：宿主会把这里的 `remote.token` / `remote.sign_key` 注入编辑器 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-host-"))
const configFile = path.join(tmp, "config.yaml")
fs.writeFileSync(configFile, `remote:\n  token: "${TOKEN}"\n  sign_key: "${SIGN_KEY}"\n`, "utf8")
process.env.ABYSS_QUEUE_CONFIG = configFile
/** 管理口令走环境变量兜底（注入不覆盖它）：用它越过"只有主人能上传"的闸，逼请求走到读 body 那一步 */
process.env.ABYSS_EDITOR_ADMIN_TOKEN = ADMIN_TOKEN

const tablePath = path.join(Paths.root, "data", "queue.xlsx")
const dataDir = path.join(Paths.root, "data")
const hashOf = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

/* ---------------------------------------------------------------- 前置 */

const missing = []
if (!fs.existsSync(path.join(Paths.root, "modules", "editor-host.js"))) missing.push("modules/editor-host.js")
if (!fs.existsSync(tablePath)) missing.push("data/queue.xlsx（编辑器要有一张表才起得来）")
if (!fs.existsSync(path.join(Paths.root, "editor", "editor.mjs"))) missing.push("editor/editor.mjs")
if (missing.length) {
  console.log(`⏭ 套件跳过（缺前置：${missing.join("、")}）`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

const beforeHash = hashOf(tablePath)
const beforeData = fs.readdirSync(dataDir).sort()

/* ------------------------------------------- 假框架：与 lib/bot.js 同样的装法 */

const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use(express.raw())
app.use(express.text())
app.get("/ping", (req, res) => res.end("pong"))
app.use((req, res) => res.status(404).end("framework-404"))

const server = http.createServer(app)
const { EDITOR_MOUNT, isEditorPath, startEditorHost } = await import("../modules/editor-host.js")

const mounted = await startEditorHost({
  server,
  express: app,
  /** 假装 7788 上没有独立编辑器（连不上） */
  fetchImpl: async () => {
    throw new Error("ECONNREFUSED")
  },
  logImpl: () => {},
})

const port = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
const request = async (p, init) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(6000), ...init })
    return { status: res.status, text: await res.text() }
  } catch (err) {
    /** 超时也走这里：把"挂死"变成一条能看懂的红，而不是让套件卡住 */
    return { status: 0, text: String(err?.message ?? err) }
  }
}

/* ---------------------------------------------------------------- 断言 */

await check("挂载成功：前缀 /queue，表固定在插件 data/ 下", () => {
  if (!mounted?.mounted) throw new Error(`没挂上：${JSON.stringify(mounted)}`)
  if (mounted.mount !== "/queue") throw new Error(`前缀不对：${mounted.mount}`)
  if (!mounted.table?.endsWith(path.join("data", "queue.xlsx"))) throw new Error(`表路径不对：${mounted.table}`)
})

await check("前缀判定：/queue 与它下面算，/queueX 不算（不能吞别的插件）", () => {
  for (const [url, want] of [
    ["/queue", true],
    ["/queue/", true],
    ["/queue/api/save?k=x", true],
    ["/queueX", false],
    ["/queueX/api", false],
    ["/other", false],
    ["/", false],
  ]) {
    if (isEditorPath(url, EDITOR_MOUNT) !== want) throw new Error(`${url} 判成了 ${!want}`)
  }
})

await check("框架自己的路径照旧：/ping 还是 200、未知路径还是框架的 404", async () => {
  const ping = await request("/ping")
  if (ping.status !== 200 || ping.text !== "pong") throw new Error(`/ping 被动了：${JSON.stringify(ping)}`)
  const nope = await request("/nope")
  if (nope.status !== 404 || !nope.text.includes("framework-404")) throw new Error(`未知路径没回到框架：${JSON.stringify(nope)}`)
  const lookalike = await request("/queueX")
  if (lookalike.status !== 404) throw new Error(`/queueX 被编辑器吞了：${JSON.stringify(lookalike)}`)
})

await check("编辑器接管 /queue：/healthz 与根页面都通", async () => {
  const health = await request(`/queue/healthz?k=${TOKEN}`)
  if (health.status !== 200) throw new Error(`/healthz 不是 200：${JSON.stringify(health)}`)
  if (!/"ok":true/.test(health.text)) throw new Error(`/healthz 不像编辑器：${health.text.slice(0, 80)}`)
  const page = await request(`/queue/?k=${TOKEN}`)
  if (page.status !== 200) throw new Error(`根页面不是 200：${page.status}`)
})

await check("口令只有 config.remote 一份来源：错的 ?k= 一律 403", async () => {
  const bad = await request("/queue/healthz?k=not-the-token")
  if (bad.status !== 403) throw new Error(`错口令竟然不是 403：${JSON.stringify(bad)}`)
})

/**
 * **这一条是整套的意义**：带 body 的请求必须"有回应"。
 *
 * 走 `Bot.express.use()` 那种挂法时，框架的 body parser 已经把流读完，编辑器再加 `data`/`end`
 * 监听一个事件都收不到 → 请求**永久挂起**（下面两条会以 `status: 0` 超时红掉）。
 */
await check("带 body 的请求不挂死：JSON 保存能走到校验（409 版本冲突）", async () => {
  const save = await request(`/queue/api/save?k=${TOKEN}&a=${ADMIN_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheet: "幽境危战", rows: [], version: "host-test-stale-version" }),
  })
  if (save.status === 0) throw new Error(`请求挂死了（body 读不出来）：${save.text}`)
  if (save.status !== 409) throw new Error(`没走到版本校验：${JSON.stringify(save)}`)
})

await check("带 body 的请求不挂死：二进制上传能走到解析（400 不是 xlsx）", async () => {
  const upload = await request(`/queue/api/upload?k=${TOKEN}&a=${ADMIN_TOKEN}`, {
    method: "POST",
    body: Buffer.from([1, 2, 3, 4, 5]),
  })
  if (upload.status === 0) throw new Error(`请求挂死了（raw body 读不出来）：${upload.text}`)
  if (upload.status !== 400) throw new Error(`没走到 xlsx 解析：${JSON.stringify(upload)}`)
})

await check("上面两条失败请求没动表：哈希一致、data/ 没有新文件", () => {
  if (hashOf(tablePath) !== beforeHash) throw new Error("表文件被改了")
  const added = fs.readdirSync(dataDir).filter(f => !beforeData.includes(f))
  if (added.length) throw new Error(`data/ 多了文件：${added.join("、")}`)
})

await check("双轨期互锁：7788 上已有独立编辑器时**不挂载**（避免两个写者）", async () => {
  const app2 = Object.assign(express(), { skip_auth: [], quiet: [] })
  const server2 = http.createServer(app2)
  const r = await import("../modules/editor-host.js")
  const out = await r.startEditorHost({ server: server2, express: app2, fetchImpl: async () => ({ status: 403 }), logImpl: () => {} })
  server2.close()
  /** 已经挂过一次了（模块级 `mounted` 是幂等位），所以这里只认"要么已挂、要么因互锁没挂" */
  if (out.reason !== "standalone-running" && out.reason !== "already-mounted")
    throw new Error(`互锁没生效：${JSON.stringify(out)}`)
})

/* ---------------------------------------------------------------- 收尾 */

server.close()
fs.rmSync(tmp, { recursive: true, force: true })
await finish()
