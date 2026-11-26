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
 * 这里**不再有假云端**：写入口（插队 / 整理 / 保存 / 标记完成 / 清榜 / 开榜 / 口令兑换 / 主播库）
 * 全部改成进程内直调（`editor/service.js` 的注册表），插件读表也直接读本地 xlsx。
 * `editor.public_url` 仍保留一个固定值——只用于拼填报入口链接（`components/fill-entry.js`），
 * 插件不会真的向它发请求。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { reloadConfig } from "../components/config.js"

/** 模板占位：把绝对路径写成 posix 风格，YAML 里更安全 */
const posix = p => p.replace(/\\/g, "/")

/**
 * 只用于拼链接的编辑器地址：写入口已经进程内化，这个地址不会被真的请求。
 * 带 `/queue` 前缀与正式部署一致（套件里也有断言盯着前缀没丢）。
 */
const EDITOR_URL = "http://127.0.0.1:7788/queue"

/** 为某个套件准备隔离配置，返回临时目录与关键路径 */
export async function ensureEnv({
  /** 临时目录前缀，便于在 %TEMP% 里辨认是哪个套件 */
  prefix = "abyss-queue-test-",
  /** 指向的表格：默认指向同目录下的副本，调用方随后自己拷贝 */
  fixtureName = "queue.xlsx",
  /** 额外写入的配置项（例如 notify / roster） */
  extra = {},
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const fixture = path.join(dir, fixtureName)
  const store = path.join(dir, "bindings.json")
  const config = path.join(dir, "config.yaml")

  const lines = ["default_sheet: 幽境危战", "list_limit: 20"]
  /**
   * 编辑器地址不再指向桩服务：这里只需要一个**能拼出链接**的地址
   * （`components/fill-entry.js` 拼填报入口时读它），`token` / `sign_key` 同理由插件侧签名使用。
   * sign_key 也给一份：正式部署要求「口令 + 签名密钥」齐备才会发个人链接。
   */
  lines.push("editor:", `  public_url: "${EDITOR_URL}"`, '  token: "test-editor-token"', '  sign_key: "test-sign-key"')
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
  /** 机器人侧那份群成员名单缓存（`data/roster.json`）：同理，别写到仓库的 `data/` 里 */
  process.env.ABYSS_QUEUE_ROSTER_FILE ||= path.join(dir, "roster.json")
  /** 直播状态缓存 / 开播提醒订阅名单（同属"数据只待在插件内"的落点） */
  process.env.ABYSS_QUEUE_ANCHOR_LIVE_FILE ||= path.join(dir, "anchor-live.json")
  process.env.ABYSS_QUEUE_LIVE_ALERTS_FILE ||= path.join(dir, "live-alerts.json")
  /**
   * 快照备份也要指到临时目录：套件经 `index.js` 拉一次云端快照，`model/local.js` 就会往
   * `config.backupDir` 写一份——不指的话落点是仓库 `data/backup`（跑一次套件脏一次仓库）。
   * 已经自己指定过的套件（`backup.test.mjs` 等要断言保留策略，各用各的目录）保持原值。
   */
  process.env.ABYSS_QUEUE_BACKUP_DIR ||= path.join(dir, "backup")
  /**
   * 重启标记：`boot()` 的退出钩子在**子进程退出时**写下它，不重定向就会落进仓库 `data/`
   * （`bootstrap.test.mjs` / `workflow.test.mjs` import `index.js` 就会触发）。
   * 兜底值由 `_helper.mjs` 在模块求值时设好了（那才是每个套件都会跑到的位置），
   * 这里指向本套件自己的临时目录，跑完跟着 `dir` 一起清掉。生产口径仍是 `<插件根>/data` 内。
   */
  process.env.ABYSS_QUEUE_RESTART_FLAG = path.join(dir, "restart.flag")
  /**
   * 本地表路径**永远**指向本套件的临时副本：
   * 插件读表已经改成直接读本地 xlsx（见 `model/local.js`），不再经假云端取快照；
   * 写入口也都改成进程内直调了，所以这里不再需要任何 HTTP 桩。
   */
  process.env.ABYSS_QUEUE_XLSX_PATH = fixture
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
  if (live.editor?.public_url !== EDITOR_URL)
    throw new Error(`隔离失败：编辑器地址是 ${live.editor?.public_url}，而非 ${EDITOR_URL}`)
  if (path.resolve(live.xlsxPath) !== path.resolve(fixture))
    throw new Error(`隔离失败：表格仍指向 ${live.xlsxPath}，而非测试副本 ${fixture}`)
  /**
   * 重启标记不在 `config` 上（它不是配置键，见 components/boot.js），所以这里直接问它：
   * 求值 boot.js 会把标记按当时的变量定死，落点不对就说明变量没设在该求值之前。
   */
  const { restartFlagPath } = await import("../components/boot.js")
  if (path.resolve(restartFlagPath()) !== path.resolve(process.env.ABYSS_QUEUE_RESTART_FLAG))
    throw new Error(`隔离失败：重启标记仍指向 ${restartFlagPath()}，而非 ${process.env.ABYSS_QUEUE_RESTART_FLAG}`)

  return { dir, fixture, store, config }
}
