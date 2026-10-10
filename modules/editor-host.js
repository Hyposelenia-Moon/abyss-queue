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

/** 运行期复探的间隔（默认 5 分钟；传 0 = 关掉） */
const INTERLOCK_WATCH_MS = 5 * 60_000

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
 * 判据是"那儿有 HTTP 回应"：`200` / `403` 都算有（后者 = 有个要口令的服务在那儿，只是口令不同），
 * 连不上（ECONNREFUSED 等）才算没有。
 *
 * **探针不带口令**：它要回答的只是"7788 上有没有东西在服务"，`403` 已经足够；
 * 而 7788 可能被**别的**服务占用，那时我们的口令就被送给了它——没必要冒这个险。
 */
export async function standaloneEditorAlive({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${STANDALONE_PORT}${EDITOR_MOUNT}/healthz`, {
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
 * 越界告警：私聊主人（编辑器自己发不出去，见 `editor/alert.js`）
 *
 * 收件人是**编辑器给的那份主人名单**（它读的是白名单文件，随时可改），宿主只负责发。
 * 一条都发不出去（没加机器人好友 / 框架没有 `pickFriend`）时只记 warn——
 * **告警发不出去绝不影响保存的判定**：拒绝早就在服务端落实了。
 *
 * @param {object} opts
 * @param {string[]} opts.owners 主人 QQ（编辑器按自己的白名单现读）
 * @param {string} opts.text 要说的话
 * @param {(level: string, msg: string) => void} [opts.logImpl] 日志出口
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function sendOwnerAlert({ owners = [], text = "", logImpl = log, pickFriend = null } = {}) {
  const pick = pickFriend ?? (qq => globalThis.Bot?.pickFriend?.(Number(qq) || qq))
  const list = [...new Set((owners ?? []).map(q => String(q ?? "").trim()).filter(Boolean))]
  if (!list.length) {
    logImpl("warn", "[abyss-queue] 编辑器要告警主人，但主人名单是空的——这条告警只留在日志里")
    return { sent: 0, failed: 0 }
  }
  let sent = 0
  let failed = 0
  for (const qq of list) {
    try {
      const friend = pick(qq)
      if (!friend?.sendMsg) throw new Error("框架没有 Bot.pickFriend（不能私聊）")
      await friend.sendMsg(text)
      sent++
    } catch (err) {
      failed++
      logImpl("warn", `[abyss-queue] 越界告警发不出去（qq=${qq}）：${err?.message ?? err}`)
    }
  }
  return { sent, failed }
}

/**
 * 运行期互锁：挂载成功后**低频复探** 7788，命中只告警、不自动卸载
 *
 * 启动期那一次探针挡不住"宿主起来**之后**才被拉起的旧编辑器"（残留的计划任务 / vbs），
 * 而那种情况下两个进程各持独立写队列改同一张 xlsx——last-writer-wins、`.bak` 与 versions 交错。
 *
 * 这里**不自动卸载**：卸载等于把主人正在用的编辑器撤掉，那是人的决定；只在**状态翻转**时各记一条
 * （出现 → error，消失 → info），免得每 5 分钟刷一条同样的日志。
 *
 * `unref()` 是硬要求：绝不能让这个定时器把进程（尤其是离线套件）吊住。
 *
 * @returns {{stop: () => void}} 收工用（套件与优雅退出）
 */
export function startInterlockWatch({
  fetchImpl = globalThis.fetch,
  logImpl = log,
  intervalMs = INTERLOCK_WATCH_MS,
} = {}) {
  if (!(intervalMs > 0)) return { stop() {} }
  let alarmed = false
  const timer = setInterval(async () => {
    const alive = await standaloneEditorAlive({ fetchImpl })
    if (alive && !alarmed) {
      alarmed = true
      logImpl(
        "error",
        `[abyss-queue] 127.0.0.1:${STANDALONE_PORT} 上出现了独立编辑器：同一张表现在有两个写者` +
          `（宿主里的 + 那个进程）。请停掉它（并清掉拉起它的计划任务 / vbs），再重启机器人。`,
      )
    } else if (!alive && alarmed) {
      alarmed = false
      logImpl("info", `[abyss-queue] 127.0.0.1:${STANDALONE_PORT} 上那个独立编辑器已经没了（互锁恢复常态）`)
    }
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

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
  interlockWatchMs = INTERLOCK_WATCH_MS,
} = {}) {
  const mount = EDITOR_MOUNT
  if (mounted) return { mounted: true, reason: "already-mounted", mount }

  /** 只有"复用 bot 端口"这一套才谈得上接管（非 TRSS / 框架还没起 server 时安静跳过） */
  if (!server || typeof server.on !== "function") {
    logImpl("warn", "[abyss-queue] 编辑器不挂到 bot 端口（框架没有可共享的 http server）——本次不挂载，/queue 会 404")
    return { mounted: false, reason: "no-shared-server" }
  }
  if (!express || typeof express !== "function") {
    logImpl("warn", "[abyss-queue] 编辑器不挂到 bot 端口（框架没有可共享的 express）——本次不挂载，/queue 会 404")
    return { mounted: false, reason: "no-shared-express" }
  }

  /** 双轨期互锁：老链还在服务就先不挂，免得同一张表两个写者 */
  if (await standaloneEditorAlive({ fetchImpl })) {
    logImpl("warn", `[abyss-queue] 127.0.0.1:${STANDALONE_PORT} 上已有独立编辑器在服务，本次不挂到 bot 端口（避免两个写者）——/queue 会 404，先停掉那个进程再重启机器人`)
    return { mounted: false, reason: "standalone-running" }
  }

  const table = editorTablePath()
  let handler
  /** 兜底 500 也要带的那三个安全头（与 handler 同一份实现，见下面兜底那一段） */
  let applySecurityHeaders = null
  try {
    /**
     * **先注入、再动态 import**：注入的键名就是参数名（见 `editor/injected.js`）。
     * 表路径固定、口令与签名密钥只有 `config.remote` 一份来源。
     */
    const { injectEditorConfig, injectEditorLog, injectOwnerAlert } = await import("../editor/injected.js")
    injectEditorConfig({
      "--file": table,
      "--token": config.remote?.token ?? "",
      "--sign-key": config.remote?.sign_key ?? "",
      /** 空串也**照样注入**：这样 bot 环境里若恰好有 `ABYSS_EDITOR_ADMIN_TOKEN`，也不会被编辑器捡走 */
      "--admin-token": config.remote?.admin_token ?? "",
      "--mount": mount,
    })
    /**
     * 日志出口也交给宿主：宿主模式下编辑器没有自己的日志文件，而"谁在什么时候改了表"
     * 必须留得下来（写操作的审计行见 `editor/audit.js`，走框架 logger 因而有时间戳与等级）。
     */
    injectEditorLog(line => logImpl("info", line))
    /**
     * 越界告警的出口也交给宿主：编辑器**发不出私聊**（它可能独立跑，手里没有 `Bot`），
     * 所以只负责"该告警了、告给谁、说什么"，发送由宿主用框架的私聊接口做
     * （见 `editor/alert.js` 与 `editor/editor.mjs` 的 `alertOwner`）。
     */
    injectOwnerAlert(({ text, owners }) => sendOwnerAlert({ owners, text, logImpl }))
    ;({ handler } = await import("../editor/editor.mjs"))
    /**
     * 异常兜底那一路（下面 `dispatchEditor`）**不经 `handler`**，所以拿不到 handler 开头统一设的
     * 三个安全响应头——单独取一份，兜底时自己补上（同一份 `SECURITY_HEADERS`，别在这里抄一遍）。
     */
    ;({ applySecurityHeaders } = await import("../editor/http/respond.js"))
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
    logImpl("warn", "[abyss-queue] 编辑器不挂到 bot 端口（这个 server 上没有 request 监听器，形态不对）——本次不挂载，/queue 会 404")
    return { mounted: false, reason: "no-request-listener" }
  }

  const dispatchEditor = (req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      /** 编辑器内部异常不许冒到框架的 request 监听器上（那会变成未捕获异常） */
      logImpl("error", `[abyss-queue] 编辑器请求处理失败：${err?.stack ?? err}`)
      try {
        if (res.headersSent) res.end()
        else {
          /**
           * 三个安全头（X-Frame-Options / Referrer-Policy / X-Content-Type-Options）**照设**：
           * `handler` 是在它自己开头统一设的，而这一路是 handler 抛异常之后的兜底，走不到那里。
           * 这一页只是 `text/plain`，但"编辑器路径下的响应都带这三个头"这条口径不该有例外
           * （2026-10-08 复审报告 §2-#4）。
           */
          applySecurityHeaders?.(res)
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
    /**
     * 转发给框架原来的监听器，但**响应已经写出去了就不再往下转**。
     *
     * 为什么要这一道：挂载之后若有人（框架代码 / 别的插件）又 `server.on("request")`，
     * Node 会把同一条请求发给**所有**监听器——两个人都处理，先写完的那个之后任何写入都是
     * `ERR_HTTP_HEADERS_SENT`，写接口还会双重落盘。这里挡不住后来者（我们不是事件循环的主人），
     * 但至少自己不做"第二个写响应的人"，也不会把已经结束的响应再交出去一次。
     * 真正的纪律写在 `AGENTS.md` §3.10：**挂载之后不得再直接 `server.on("request")`**。
     */
    for (const listener of previous) {
      if (res.writableEnded || res.headersSent) break
      listener.call(server, req, res)
    }
  })
  mounted = true

  logImpl("info", `[abyss-queue] 编辑器已挂到 bot 端口：${mount}（表 ${table}）`)
  /** 运行期复探：挡"宿主起来之后才冒出来的旧编辑器"（见 startInterlockWatch 的注释） */
  startInterlockWatch({ fetchImpl, logImpl, intervalMs: interlockWatchMs })
  return { mounted: true, reason: "mounted", mount, table }
}
