/**
 * 回归套件的隔离环境（**必须是测试文件的第一个 import**）
 *
 * 为什么要单独一个文件：`components/config.js` 在模块求值时就调用 loadConfig() 读
 * `ABYSS_QUEUE_CONFIG`，而 ESM 的静态 import 全部先于测试文件的顶层代码执行。
 * 因此「先 import、再在顶层设环境变量」是无效的——配置会落到仓库里的
 * config/config.yaml，测试就会读写**用户的真实绑定文件**。
 *
 * 这里把临时配置的生成放在模块顶层（本文件被求值时立即执行），
 * 后续任何 import 插件代码时配置已经就位。
 *
 * 插件的数据来源是**云端快照**，所以默认模式下这里会起一个"假云端"：
 * 一个只认 `/…/api/snapshot?k=<token>` 的小 HTTP 服务，把临时副本当云端表吐出去。
 * 表格层套件（workbook）测的是本地读写，用 `cloud: false` 走 xlsx_path 那条路。
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { reloadConfig } from "../components/config.js"

/** 模板占位：把绝对路径写成 posix 风格，YAML 里更安全 */
const posix = p => p.replace(/\\/g, "/")

/**
 * 假云端：`/queue/api/snapshot?k=<token>` 返回文件内容
 * 故意挂在带前缀的路径下，顺带证明插件不依赖站点根路径
 */
export async function startStubCloud(file, { token = "test-cloud-token", mount = "/queue" } = {}) {
  const state = { hits: 0, lastError: "" }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
    const pathname = url.pathname.startsWith(mount) ? url.pathname.slice(mount.length) || "/" : url.pathname
    if (pathname !== "/api/snapshot") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      return res.end("not found")
    }
    if (url.searchParams.get("k") !== token) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
      return res.end("forbidden")
    }
    try {
      const buf = fs.readFileSync(file)
      state.hits++
      res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      res.end(buf)
    } catch (err) {
      state.lastError = err.message
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      res.end(err.message)
    }
  })
  await new Promise(r => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}${mount}`,
    token,
    port,
    state,
    close: () => new Promise(r => server.close(r)),
  }
}

/** 为某个套件准备隔离配置，返回临时目录与关键路径 */
export async function ensureEnv({
  /** 临时目录前缀，便于在 %TEMP% 里辨认是哪个套件 */
  prefix = "abyss-queue-test-",
  /** 指向的表格：默认指向同目录下的副本，调用方随后自己拷贝 */
  fixtureName = "queue.xlsx",
  /** 额外写入的配置项（例如 push） */
  extra = {},
  /** 是否保留备份（含写入的套件建议 false，省一次全表拷贝） */
  backup = false,
  /** true = 起假云端并配 remote（插件默认形态）；false = 配 xlsx_path（表格层套件用） */
  cloud = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const fixture = path.join(dir, fixtureName)
  const store = path.join(dir, "bindings.json")
  const config = path.join(dir, "config.yaml")

  const stub = cloud ? await startStubCloud(fixture) : null

  const lines = [`store_file: "${posix(store)}"`, `backup: ${backup}`, "default_sheet: 幽境危战", "list_limit: 20"]
  if (stub) {
    lines.push("remote:", `  url: "${stub.url}"`, `  token: "${stub.token}"`, "  ttl_ms: 0", "  timeout_ms: 5000")
  } else {
    lines.push(`xlsx_path: "${posix(fixture)}"`)
  }
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`)
    else if (v && typeof v === "object") {
      lines.push(`${k}:`)
      for (const [k2, v2] of Object.entries(v))
        lines.push(`  ${k2}: ${Array.isArray(v2) ? `[${v2.join(", ")}]` : v2}`)
    } else lines.push(`${k}: ${v}`)
  }
  fs.writeFileSync(config, `${lines.join("\n")}\n`, "utf8")

  /** 必须在任何插件模块被求值之前设置 */
  process.env.ABYSS_QUEUE_CONFIG = config
  /** Node 先求值依赖模块：config.js 早已按仓库配置读过一次，这里必须重载 */
  reloadConfig()

  /** 防复发自检：配置没被重载时，套件会去读写用户的真实绑定/表格，必须当场拦下 */
  const live = reloadConfig()
  if (path.resolve(live.storePath) !== path.resolve(store))
    throw new Error(`隔离失败：绑定仍指向 ${live.storePath}，而非 ${store}`)
  if (stub) {
    if (live.remote?.url !== stub.url) throw new Error(`隔离失败：云端地址是 ${live.remote?.url}，而非 ${stub.url}`)
  } else if (path.resolve(live.xlsxPath) !== path.resolve(fixture)) {
    throw new Error(`隔离失败：表格仍指向 ${live.xlsxPath}，而非测试副本 ${fixture}`)
  }

  return { dir, fixture, store, config, cloud: stub }
}
