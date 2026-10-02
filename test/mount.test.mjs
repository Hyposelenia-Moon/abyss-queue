/**
 * 一次性：验证编辑器能否挂在子路径（模拟 nginx 的 proxy_pass 行为）
 * 用法：node test/.probe-mount.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = process.argv[2] ?? "D:/文件/游戏/原神/2026年10月三路深渊排队.xlsx"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-mount-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const TOKEN = "mount-token-7"
const EDITOR_PORT = 7801
const PROXY_PORT = 7802

const editor = spawn(
  process.execPath,
  [path.join(HERE, "..", "tools", "editor.mjs"), "--port", String(EDITOR_PORT), "--token", TOKEN, "--mount", "/queue"],
  { env: { ...process.env, ABYSS_EDITOR_FILE: fixture }, stdio: ["ignore", "pipe", "pipe"] },
)
let editorOut = ""
editor.stdout.on("data", d => (editorOut += d))
editor.stderr.on("data", d => (editorOut += d))

/**
 * 模拟 nginx：
 *   location /queue { proxy_pass http://127.0.0.1:7788; }   ← 不带尾部斜杠，路径原样转发
 * 所以代理只做端口转发，不改路径。
 */
const proxy = http.createServer((req, res) => {
  const up = http.request(
    { host: "127.0.0.1", port: EDITOR_PORT, path: req.url, method: req.method, headers: req.headers },
    r => {
      res.writeHead(r.statusCode, r.headers)
      r.pipe(res)
    },
  )
  up.on("error", err => {
    res.writeHead(502)
    res.end(`proxy error: ${err.message}`)
  })
  req.pipe(up)
})
await new Promise(r => proxy.listen(PROXY_PORT, "127.0.0.1", r))

const wait = ms => new Promise(r => setTimeout(r, ms))
const get = async p => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}${p}`)
  const text = await res.text()
  return { status: res.status, text, ct: res.headers.get("content-type") ?? "" }
}

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}

try {
  let ready = false
  for (let i = 0; i < 40; i++) {
    await wait(400)
    try {
      const r = await get(`/queue/healthz?k=${TOKEN}`)
      if (r.status === 200) {
        ready = true
        break
      }
    } catch {}
  }
  if (!ready) throw new Error(`编辑器或代理没起来：\n${editorOut}`)

  const h = await get(`/queue/healthz?k=${TOKEN}`)
  check("挂在 /queue 下：健康检查通", () => {
    if (h.status !== 200) throw new Error(`HTTP ${h.status}`)
    const j = JSON.parse(h.text)
    if (!j.ok) throw new Error(h.text)
  })

  const api = await get(`/queue/api/data?k=${TOKEN}`)
  check("挂在 /queue 下：数据接口返回 JSON（未被 SPA 兜底）", () => {
    if (!api.ct.includes("json")) throw new Error(`content-type=${api.ct}`)
    const j = JSON.parse(api.text)
    if (!Array.isArray(j.sheets) || j.sheets.length !== 3) throw new Error("工作表数量不对")
  })

  const page = await get(`/queue/?k=${TOKEN}`)
  check("挂在 /queue 下：首页是编辑器界面", () => {
    if (page.status !== 200) throw new Error(`HTTP ${page.status}`)
    if (!page.text.includes("排队表")) throw new Error("首页不是编辑器")
    /** 前端必须用相对地址，否则挂子路径时请求会打到站点根 */
    if (!page.text.includes("withToken('api/data')")) throw new Error("前端没有用相对地址")
  })

  const noK = await get("/queue/")
  check("挂在 /queue 下：无口令给出口令页", () => {
    if (noK.status !== 200) throw new Error(`HTTP ${noK.status}`)
    if (!noK.text.includes("访问口令")) throw new Error("不是口令输入页")
    if (!noK.text.includes("location.pathname")) throw new Error("口令提交没有保留子路径")
  })

  const bad = await get(`/queue/api/data?k=wrong`)
  check("挂在 /queue 下：错误口令 403", () => {
    if (bad.status !== 403) throw new Error(`HTTP ${bad.status}`)
  })

  /** 根路径也要照常可用（本机测试直接访问 127.0.0.1:7801） */
  const root = await fetch(`http://127.0.0.1:${EDITOR_PORT}/healthz?k=${TOKEN}`)
  check("同一份代码直接挂根路径也可用", () => {
    if (root.status !== 200) throw new Error(`HTTP ${root.status}`)
  })
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  proxy.close()
  editor.kill()
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 子路径挂载验证失败 ${failed} 项` : "\n✅ 子路径挂载验证通过（nginx proxy_pass 不带尾部斜杠的场景）")
process.exit(failed ? 1 : 0)
