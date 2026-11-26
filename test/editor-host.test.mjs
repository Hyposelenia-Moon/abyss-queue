/** 编辑器宿主回归：把编辑器挂到 **bot 自己的 HTTP server** 上（S2b） */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { createChecker, Paths } from "./_helper.mjs"

/** express 是这个套件的宿主；没装就按「缺前置」跳过，而不是让整个文件 import 崩掉（云端沙箱里很常见）。 */
let express = null
try {
  express = (await import("express")).default
} catch {
  express = null
}

const { check, finish } = createChecker("编辑器宿主")

/** 探针口令（只活在这次运行里；不是任何真实部署的口令） */
const TOKEN = "host-test-token"
const SIGN_KEY = "host-test-sign-key"
const ADMIN_TOKEN = "host-test-admin-token"

/** 隔离配置：宿主会把这里的 `editor.*` 注入编辑器（**这是唯一来源**） */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-host-"))
const configFile = path.join(tmp, "config.yaml")
fs.writeFileSync(configFile, `editor:\n  token: "${TOKEN}"\n  sign_key: "${SIGN_KEY}"\n  admin_token: "${ADMIN_TOKEN}"\n`, "utf8")
process.env.ABYSS_QUEUE_CONFIG = configFile
// 环境里**故意**放一个不一样的管理口令：宿主把 `--admin-token` 也注入（哪怕配置里是空串），
const ENV_ADMIN_TOKEN = "env-admin-should-be-ignored"
process.env.ABYSS_EDITOR_ADMIN_TOKEN = ENV_ADMIN_TOKEN

const tablePath = path.join(Paths.root, "data", "queue.xlsx")
const dataDir = path.join(Paths.root, "data")
const hashOf = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

/* ---------------------------------------------------------------- 前置 */

const missing = []
if (!express) missing.push("express（宿主套件要挂到 bot 的 server 上）")
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
const { EDITOR_MOUNT, isEditorPath, standaloneEditorAlive, startEditorHost } = await import("../modules/editor-host.js")

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

await check("口令只有 config.editor 一份来源：错的 ?k= 一律 403", async () => {
  const bad = await request("/queue/healthz?k=not-the-token")
  if (bad.status !== 403) throw new Error(`错口令竟然不是 403：${JSON.stringify(bad)}`)
})

await check("凭证只有 config 一份来源：环境变量里的管理口令**不算**", async () => {
  const envAdmin = await request(`/queue/api/save?k=${TOKEN}&a=${ENV_ADMIN_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheet: "幽境危战", rows: [], version: "x" }),
  })
  if (envAdmin.status !== 403) throw new Error(`环境变量里的管理口令竟然管用：${JSON.stringify(envAdmin)}`)
})

// **这一条是整套的意义**：带 body 的请求必须"有回应"。
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
  // **被拒的保存也要留痕**（`513b125`：`abyss-editor-changes.json` 里写 `kind:"reject"`，
  const added = fs.readdirSync(dataDir).filter(f => !beforeData.includes(f) && f !== "abyss-editor-changes.json")
  if (added.length) throw new Error(`data/ 多了文件：${added.join("、")}`)
})

await check("互锁探针：不带口令；200 / 403 都算「有编辑器」，连不上才算没有", async () => {
  const seen = []
  const withStatus = status => async url => {
    seen.push(url)
    return { status }
  }
  if (!(await standaloneEditorAlive({ fetchImpl: withStatus(403) }))) throw new Error("403 应当算「有编辑器」")
  if (!(await standaloneEditorAlive({ fetchImpl: withStatus(200) }))) throw new Error("200 应当算「有编辑器」")
  const dead = await standaloneEditorAlive({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED")
    },
  })
  if (dead) throw new Error("连不上不该算「有编辑器」")
  for (const url of seen) {
    /** 探针只回答"7788 上有没有东西在服务"，口令没必要发出去（7788 可能被别的服务占用） */
    if (/[?&]k=/.test(url)) throw new Error(`探针不该带口令：${url}`)
    if (!url.endsWith("/queue/healthz")) throw new Error(`探针地址不对：${url}`)
  }
})

// 第二次 `startEditorHost()` 会直接返回 `already-mounted`（模块级幂等位）——**这条只钉幂等**。
await check("重复调用不重复挂载（模块级幂等位）", async () => {
  const app2 = Object.assign(express(), { skip_auth: [], quiet: [] })
  const server2 = http.createServer(app2)
  const r = await import("../modules/editor-host.js")
  const out = await r.startEditorHost({ server: server2, express: app2, fetchImpl: async () => ({ status: 403 }), logImpl: () => {} })
  server2.close()
  if (out.reason !== "already-mounted") throw new Error(`不是幂等返回：${JSON.stringify(out)}`)
})

// 半死路径至少要 **warn**：`startEditorHost()` 失败不抛、bot 照常跑，所以"编辑器没挂上、
await check("半死路径：没有可共享的 server → 不挂载且记 warn（不是静默 info）", async () => {
  const fresh = await import(`../modules/editor-host.js?probe=${Date.now()}`)
  const logs = []
  const out = await fresh.startEditorHost({
    server: {},
    express: () => {},
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED")
    },
    logImpl: (level, msg) => logs.push(`${level}|${msg}`),
  })
  if (out.mounted || out.reason !== "no-shared-server") throw new Error(`不该挂载：${JSON.stringify(out)}`)
  if (!logs.some(l => l.startsWith("warn|"))) throw new Error(`半死路径应当记 warn：${JSON.stringify(logs)}`)
})

/** 安全头在**宿主这条路上**也要在：编辑器是在 `http.Server` 层被接管的，别只在独立跑时带上 */
await check("宿主路径的安全头：/queue 的 403 也带 XFO / Referrer-Policy / nosniff", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/queue/healthz`)
  if (res.status !== 403) throw new Error(`没口令应当是 403，实际 ${res.status}`)
  for (const [name, want] of Object.entries({
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })) {
    const got = res.headers.get(name)
    if (got !== want) throw new Error(`${name}=${JSON.stringify(got)}（期望 ${want}）`)
  }
})

// 运行期互锁（审查报告 #5）：挂载成功后**低频复探** 7788。
await check("运行期互锁：挂载后复探到 7788 有新编辑器 → 记一次 error（不自动卸载、不重复刷）", async () => {
  const fresh = await import(`../modules/editor-host.js?watch=${Date.now()}`)
  const logs = []
  const app3 = Object.assign(express(), { skip_auth: [], quiet: [] })
  const server3 = http.createServer(app3)
  let alive = false
  /** 挂载期那次探针 = 连不上（所以能正常挂载）；过一会儿才"冒出来"一个独立编辑器 */
  const fetchImpl = async () => {
    if (!alive) throw new Error("ECONNREFUSED")
    return { status: 403 }
  }
  const out = await fresh.startEditorHost({
    server: server3,
    express: app3,
    fetchImpl,
    logImpl: (level, msg) => logs.push(`${level}|${msg}`),
    interlockWatchMs: 20,
  })
  server3.close()
  if (!out.mounted) throw new Error(`应当挂载成功：${JSON.stringify(out)}`)
  await new Promise(r => setTimeout(r, 60))
  if (logs.some(l => l.startsWith("error|"))) throw new Error(`还没出现就报错：${JSON.stringify(logs)}`)
  alive = true
  await new Promise(r => setTimeout(r, 90))
  const errors = logs.filter(l => l.startsWith("error|"))
  if (errors.length !== 1) throw new Error(`应当只报一次 error，实际 ${errors.length}：${JSON.stringify(logs)}`)
  if (!/7788/.test(errors[0])) throw new Error(`报错里没点明端口：${errors[0]}`)
})

// 分发器的守卫（审查报告 #1）：转发给框架原来的监听器之前，先看响应是不是已经写出去了。
await check("转发守卫：响应已经写完就不再转给后面的监听器（不双重处理）", async () => {
  const fresh = await import(`../modules/editor-host.js?guard=${Date.now()}`)
  const app4 = Object.assign(express(), { skip_auth: [], quiet: [] })
  const server4 = http.createServer()
  let secondRan = 0
  /** 第一个监听器：自己就把响应写完了 */
  server4.on("request", (req, res) => res.end("first"))
  /** 第二个监听器：绝对不该被调到 */
  server4.on("request", () => secondRan++)
  const out = await fresh.startEditorHost({
    server: server4,
    express: app4,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED")
    },
    logImpl: () => {},
  })
  const port4 = await new Promise(resolve => server4.listen(0, "127.0.0.1", () => resolve(server4.address().port)))
  let text = ""
  try {
    const r = await fetch(`http://127.0.0.1:${port4}/whatever`, { signal: AbortSignal.timeout(6000) })
    text = await r.text()
  } finally {
    server4.close()
  }
  if (!out.mounted) throw new Error(`应当挂载成功：${JSON.stringify(out)}`)
  if (text !== "first") throw new Error(`响应被改写了：${JSON.stringify(text)}`)
  if (secondRan) throw new Error(`响应已经写完了还转给后面的监听器 ${secondRan} 次（双重处理）`)
})

/* ---------------------------------------------------------------- 收尾 */

server.close()
fs.rmSync(tmp, { recursive: true, force: true })
await finish()
