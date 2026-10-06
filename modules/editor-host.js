/**
 * 把编辑器挂到 bot 自己的 HTTP server 上（**随框架启停**，与锅巴同一形态）
 *
 * ## 为什么在 `http.Server` 这一层接管，而不是 `Bot.express.use()`
 *
 * 框架的 express 在构造时就按顺序装了四个 body parser，**没有路径过滤**
 * （`lib/bot.js:50-53`：`urlencoded` / `json` / `raw` / `text`）。我们后加的中间件一定排在它们之后，
 * 而编辑器是**自己读原始请求体**的（`editor/http/respond.js` 的 `collectBody` 用 `req.on("data")/("end")`）。
 * 流已经被 parser 读完，之后再加监听**一个事件都收不到**——不是"读到空 body"，而是**请求永久挂起**
 * （保存 / 上传全都会卡死，实测复现过）。
 *
 * 所以这里把 `server` 上原来的 `request` 监听器摘下来，换成"是 `/queue` 就交给编辑器、其余原样转发"。
 * 编辑器因此跑在 express **之前**，能原生读流；框架自己的路由与中间件对其它一切照旧。
 *
 * ## 三条硬规矩
 *
 * 1. **先注入、再动态 import**：静态 `import` 会在注入之前把 `createConfig()` 跑掉（那时它只看 argv /
 *    环境变量），两边就会各用各的口令——同一件事有两个来源，就是这类事故的温床。
 * 2. **接住编辑器的 `EditorConfigError`**：配置不合法（缺表 / 没口令 / 凭证复用）时记日志并**不挂载**，
 *    bot 继续跑。编辑器在别人家里不许把宿主带走。
 * 3. **同一张表不允许两个写者**：`127.0.0.1:7788` 上已经有独立编辑器在服务时**不挂载**，
 *    免得同一份 xlsx 被两套进程同时写。
 *
 * 挂载**不做**的事：不碰 `Bot.express` 的 `quiet` / `skip_auth`（那两条是给"走 express 中间件"的插件用的；
 * 我们不走 express），也不接管框架对其它路径的鉴权。
 */
import path from "node:path"
import { EDITOR_MOUNT } from "../components/constants.js"
import { config, pluginRoot } from "../components/config.js"
import { log } from "../components/logger.js"

/** 编辑器挂载前缀（唯一定义在 `components/constants.js`；nginx 上对外同样是 `/queue`） */
export { EDITOR_MOUNT }

/** 表落点：**固定** `<插件根>/data/queue.xlsx`（编辑器部署参数不再可配） */
export const editorTablePath = () => path.join(pluginRoot, "data", "queue.xlsx")

/** 老链（独立进程）的默认端口：双轨期互锁探针用它 */
const STANDALONE_PORT = 7788

/** 互锁探针的超时（本地回环，正常是毫秒级） */
const PROBE_TIMEOUT_MS = 800

/**
 * 这条请求该不该由编辑器接
 *
 * 只认"`/queue` 本身或它下面的路径"：`/queueX` 不算（否则会把别的插件的路径也吞掉）。
 */
export const isEditorPath = (url, mount = EDITOR_MOUNT) => {
  const pathname = String(url ?? "").split("?")[0]
  return pathname === mount || pathname.startsWith(`${mount}/`)
}

/**
 * 双轨期互锁：老链的独立编辑器还在服务吗
 *
 * 判据是"那儿有 HTTP 回应"：`200` = 口令也对得上；`403` = 确实有个编辑器（口令不同）。
 * 连不上（ECONNREFUSED 等）才算没有。
 */
export async function standaloneEditorAlive({ fetchImpl = globalThis.fetch, token = config.remote?.token ?? "" } = {}) {
  const query = token ? `?k=${encodeURIComponent(token)}` : ""
  try {
    const res = await fetchImpl(`http://127.0.0.1:${STANDALONE_PORT}${EDITOR_MOUNT}/healthz${query}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.status === 200 || res.status === 403
  } catch {
    return false
  }
}

/** 已经挂过就不再挂（插件只加载一次；这里防的是重复调用） */
let mounted = false

/**
 * 启动宿主：注入配置 → 加载编辑器 → 在 bot 的 server 上按前缀接管
 *
 * @param {object} [deps]
 * @param {object} [deps.server] 框架的 `http.Server`（默认 `globalThis.Bot?.server`）
 * @param {object} [deps.express] 框架的 express app（默认 `globalThis.Bot?.express`；只用来确认"这是共享端口那套"）
 * @param {Function} [deps.fetchImpl] 互锁探针用的 fetch（默认全局 fetch）
 * @param {Function} [deps.logImpl] 日志函数（默认 `components/logger.js` 的 `log`）
 * @returns {Promise<{mounted: boolean, reason: string, mount?: string, table?: string, detail?: string[]}>}
 */
export async function startEditorHost({
  server = globalThis.Bot?.server,
  express = globalThis.Bot?.express,
  fetchImpl = globalThis.fetch,
  logImpl = log,
} = {}) {
  const mount = EDITOR_MOUNT
  if (mounted) return { mounted: true, reason: "already-mounted", mount }

  /** 只有"复用 bot 端口"这一套才谈得上接管（非 TRSS / 框架还没起 server 时安静跳过） */
  if (!server || typeof server.on !== "function") {
    logImpl("info", "[abyss-queue] 编辑器不挂到 bot 端口（框架没有可共享的 http server）")
    return { mounted: false, reason: "no-shared-server" }
  }
  if (!express || typeof express !== "function") {
    logImpl("info", "[abyss-queue] 编辑器不挂到 bot 端口（框架没有可共享的 express）")
    return { mounted: false, reason: "no-shared-express" }
  }

  /** 双轨期互锁：老链还在服务就先不挂，免得同一张表两个写者 */
  if (await standaloneEditorAlive({ fetchImpl })) {
    logImpl("info", `[abyss-queue] 127.0.0.1:${STANDALONE_PORT} 上已有独立编辑器在服务，本次不挂到 bot 端口（避免两个写者）`)
    return { mounted: false, reason: "standalone-running" }
  }

  const table = editorTablePath()
  let handler
  try {
    /**
     * **先注入、再动态 import**：注入的键名就是参数名（见 `editor/injected.js`）。
     * 表路径固定、口令与签名密钥只有 `config.remote` 一份来源。
     */
    const { injectEditorConfig } = await import("../editor/injected.js")
    injectEditorConfig({
      "--file": table,
      "--token": config.remote?.token ?? "",
      "--sign-key": config.remote?.sign_key ?? "",
      /** 空串也**照样注入**：这样 bot 环境里若恰好有 `ABYSS_EDITOR_ADMIN_TOKEN`，也不会被编辑器捡走 */
      "--admin-token": config.remote?.admin_token ?? "",
      "--mount": mount,
    })
    ;({ handler } = await import("../editor/editor.mjs"))
  } catch (err) {
    /**
     * 编辑器的 fail-closed（`EditorConfigError`，带 `lines`）：记日志 + **不挂载**，
     * bot 继续跑。缺表 / 没口令 / 凭证复用都走这里。
     */
    const detail = Array.isArray(err?.lines) ? err.lines : [String(err?.message ?? err)]
    logImpl("error", `[abyss-queue] 编辑器没挂上（bot 继续跑）：${detail.join(" / ")}`)
    return { mounted: false, reason: "config-invalid", detail }
  }

  /**
   * 在 http.Server 这一层接管：把原来的 `request` 监听器摘下来（框架那份是 express app），
   * 换成"是编辑器路径就交出去、其余原样转发"。
   */
  const previous = server.listeners("request")
  if (!previous.length) {
    logImpl("info", "[abyss-queue] 编辑器不挂到 bot 端口（这个 server 上没有 request 监听器，形态不对）")
    return { mounted: false, reason: "no-request-listener" }
  }

  const dispatchEditor = (req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      /** 编辑器内部异常不许冒到框架的 request 监听器上（那会变成未捕获异常） */
      logImpl("error", `[abyss-queue] 编辑器请求处理失败：${err?.stack ?? err}`)
      try {
        if (res.headersSent) res.end()
        else {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          res.end("editor error")
        }
      } catch {
        /* 连接已经断了就算了 */
      }
    })
  }

  server.removeAllListeners("request")
  server.on("request", (req, res) => {
    if (isEditorPath(req.url, mount)) return dispatchEditor(req, res)
    for (const listener of previous) listener.call(server, req, res)
  })
  mounted = true

  logImpl("info", `[abyss-queue] 编辑器已挂到 bot 端口：${mount}（表 ${table}）`)
  return { mounted: true, reason: "mounted", mount, table }
}
