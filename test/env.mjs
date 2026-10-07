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
 * 表格层套件（workbook）测的是本地读写，用 `cloud: false` 走 `ABYSS_QUEUE_XLSX_PATH` 那条路。
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
    /**
     * 插队（`POST <mount>/api/move-row`）：`#插队` 走的就是这一条
     *
     * 只把请求体记下来（`state.moves`），回一个"挪到了目标行"的空壳——
     * 插队的位置由**编辑器**算，插件只负责把"哪一榜、哪一行、怎么挪"发过来（见 model/move-row.js）。
     * 套件要断言的是"发没发、发的是什么、没该发的时候有没有发"，不是真去挪一张表。
     */
    if (pathname === "/api/move-row" && req.method === "POST") {
      const chunks = []
      req.on("data", c => chunks.push(c))
      req.on("end", () => {
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          /* 非法 JSON 就当空体：插件那边会当成失败报出来 */
        }
        state.moves = state.moves ?? []
        state.moves.push({ ...body, k: url.searchParams.get("k"), u: url.searchParams.get("u"), s: url.searchParams.get("s") })
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        res.end(
          JSON.stringify({
            ok: true,
            moved: true,
            sheet: body.sheet,
            from: Number(body.row),
            to: Math.max(1, Number(body.row) - 1),
            nickname: body.nick ?? "",
            crossed: "",
          }),
        )
      })
      return
    }
    /**
     * 群成员名单推送（`POST <mount>/api/roster`）：机器人每天的名单同步会打这个口
     *
     * 只回一个成功的空壳即可——套件关心的是"推没推、推了几个人"，名单的内容由
     * `editor/test` 里那几个走真编辑器的套件覆盖。不接这个口的话，凡是会 tick 的套件
     * 都会在日志里刷一条"推送名单失败"，把真正的失败淹掉。
     */
    if (pathname === "/api/roster" && req.method === "POST") {
      const chunks = []
      req.on("data", c => chunks.push(c))
      req.on("end", () => {
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          /* 非法 JSON 就当空名单 */
        }
        state.rosterPushes = (state.rosterPushes ?? 0) + 1
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: true, count: Array.isArray(body.members) ? body.members.length : 0 }))
      })
      return
    }
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
  /** 额外写入的配置项（例如 notify / roster） */
  extra = {},
  /** true = 起假云端并配 remote（插件默认形态）；false = 配 ABYSS_QUEUE_XLSX_PATH（表格层套件用） */
  cloud = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const fixture = path.join(dir, fixtureName)
  const store = path.join(dir, "bindings.json")
  const config = path.join(dir, "config.yaml")

  const stub = cloud ? await startStubCloud(fixture) : null

  const lines = ["default_sheet: 幽境危战", "list_limit: 20"]
  if (stub) {
    /** sign_key 也给一份：正式部署要求「口令 + 签名密钥」齐备才会发个人链接 */
    lines.push(
      "remote:",
      `  url: "${stub.url}"`,
      `  token: "${stub.token}"`,
      `  sign_key: "stub-sign-key"`,
      "  ttl_ms: 0",
      "  timeout_ms: 5000",
    )
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
  /**
   * 套件的数据全在系统临时目录里（绑定 / 表副本 / 快照备份 / 进度快照）：
   * 生产口径要求"数据只待在插件目录内"，所以这里显式打开套件专用的放行开关
   * （见 components/config.js 的 confineDataPath 与 editor/test/data-confinement.test.mjs）。
   *
   * 落点用 `ABYSS_QUEUE_*` 环境变量指定——**不是配置项**（配置里已经没有路径键了）。
   */
  process.env.ABYSS_QUEUE_TEST_PATHS = "1"
  process.env.ABYSS_QUEUE_STORE_FILE = store
  process.env.ABYSS_QUEUE_STATE_FILE = path.join(dir, "progress.json")
  /**
   * 白名单与私聊链接状态也指到临时目录：**这是隔离的一部分，不是方便**
   *
   * 白名单决定 `#排队` 往群里发还是私聊发（`model/whitelist.js`）：不指的话，维护者本机
   * `data/abyss-editor-admins.json` 里的真实 QQ 会漏进套件——某条断言会不会红取决于
   * "本机恰好是不是这个号是管理员"。私聊链接状态同理（别写到仓库的 `data/`）。
   * 已经自己指定过的套件保持原值。
   */
  process.env.ABYSS_QUEUE_ADMINS_FILE ||= path.join(dir, "abyss-editor-admins.json")
  process.env.ABYSS_QUEUE_MANAGER_LINK_FILE ||= path.join(dir, "manager-link.json")
  /**
   * 快照备份也要指到临时目录：套件经 `index.js` 拉一次云端快照，`model/remote.js` 就会往
   * `config.backupDir` 写一份——不指的话落点是仓库 `data/backup`（跑一次套件脏一次仓库）。
   * 已经自己指定过的套件（`backup.test.mjs` 等要断言保留策略，各用各的目录）保持原值。
   */
  process.env.ABYSS_QUEUE_BACKUP_DIR ||= path.join(dir, "backup")
  /**
   * 重启标记：`boot()` 的退出钩子在**子进程退出时**写下它，不重定向就会落进仓库 `data/`
   * （`init.test.mjs` / `workflow.test.mjs` import `index.js` 就会触发）。
   * 兜底值由 `_helper.mjs` 在模块求值时设好了（那才是每个套件都会跑到的位置），
   * 这里指向本套件自己的临时目录，跑完跟着 `dir` 一起清掉。生产口径仍是 `<插件根>/data` 内。
   */
  process.env.ABYSS_QUEUE_RESTART_FLAG = path.join(dir, "restart.flag")
  if (!stub) process.env.ABYSS_QUEUE_XLSX_PATH = fixture
  /** 配置也指到临时目录：锅巴那条路会**写配置文件**，绝不能写到仓库的 config/config.yaml */
  process.env.ABYSS_QUEUE_CONFIG = config
  /** Node 先求值依赖模块：config.js 早已按仓库配置读过一次，这里必须重载 */
  reloadConfig()

  /** 防复发自检：配置没被重载时，套件会去读写用户的真实绑定/表格，必须当场拦下 */
  const live = reloadConfig()
  if (path.resolve(live.storePath) !== path.resolve(store))
    throw new Error(`隔离失败：绑定仍指向 ${live.storePath}，而非 ${store}`)
  if (path.resolve(live.backupDir) !== path.resolve(process.env.ABYSS_QUEUE_BACKUP_DIR))
    throw new Error(`隔离失败：快照备份仍指向 ${live.backupDir}，而非 ${process.env.ABYSS_QUEUE_BACKUP_DIR}`)
  if (path.resolve(live.adminsPath) !== path.resolve(process.env.ABYSS_QUEUE_ADMINS_FILE))
    throw new Error(`隔离失败：白名单仍指向 ${live.adminsPath}，而非 ${process.env.ABYSS_QUEUE_ADMINS_FILE}`)
  if (stub) {
    if (live.remote?.url !== stub.url) throw new Error(`隔离失败：云端地址是 ${live.remote?.url}，而非 ${stub.url}`)
  } else if (path.resolve(live.xlsxPath) !== path.resolve(fixture)) {
    throw new Error(`隔离失败：表格仍指向 ${live.xlsxPath}，而非测试副本 ${fixture}`)
  }
  /**
   * 重启标记不在 `config` 上（它不是配置键，见 components/boot.js），所以这里直接问它：
   * 求值 boot.js 会把标记按当时的变量定死，落点不对就说明变量没设在该求值之前。
   */
  const { restartFlagFile } = await import("../components/boot.js")
  if (path.resolve(restartFlagFile) !== path.resolve(process.env.ABYSS_QUEUE_RESTART_FLAG))
    throw new Error(`隔离失败：重启标记仍指向 ${restartFlagFile}，而非 ${process.env.ABYSS_QUEUE_RESTART_FLAG}`)

  return { dir, fixture, store, config, cloud: stub }
}
