/**
 * 配置加载：config/config.yaml（不存在时从 config/config.yaml.example 生成）
 *
 * 同步加载，便于插件构造时决定是否注册定时任务。
 * 本文件在 components/ 下，插件根需向上一级解析（不能把 import.meta.dirname 直接当插件根）。
 *
 * **读配置有两个入口，别混**：
 *   - `config`：模块加载时求值一次的**内存快照**，给运行期高频读取用（各模块 import 它，是活绑定）；
 *     就地改写它即可热重载（`reloadConfig()`）。
 *   - `readCurrentConfig()`：**每次重新读文件**再合并默认值。锅巴面板与"需要看到外部改动"的地方用它——
 *     内存快照看不到别人写的文件（`#排队初始化` 写密钥、手工编辑、面板保存都算"别人"）。
 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { log } from "./logger.js"

export const pluginRoot = path.resolve(import.meta.dirname, "..")
export const configDir = path.join(pluginRoot, "config")
export const configPath = path.join(configDir, "config.yaml")
export const examplePath = path.join(configDir, "config.yaml.example")

/**
 * 数据目录：**固定** `<插件根>/data`（Windows 就是 `<Yunzai>\plugins\abyss-queue\data`）
 *
 * 绑定 / 进度快照 / 快照备份都在这儿。`data/` 已被 git 忽略，所以 `#排队更新`
 * 只动代码不动数据；数据一旦落到插件外面，更新与备份就会各按各的路径找，哪一份都不是完整的。
 */
export const dataDir = path.join(pluginRoot, "data")

/**
 * 数据文件落点：**全是常量**，配置里没有对应的键
 *
 * 绑定 / 进度快照 / 快照备份都固定长在 `<插件根>/data` 下。为什么不做成配置项：
 * 数据一旦能配到插件外面，`#更新 abyss`（只动代码）与备份 / 迁移就会各按各的路径找，
 * 哪一份都不是完整的——所以这里直接拼出来，**没有"能填的地方"**，比"填错了再挡回来"更可靠。
 *
 * 回归套件要重定向到临时目录，走 `ABYSS_QUEUE_*` 环境变量（见下），
 * 那条路仍由 `testPathsAllowed()` 与 `confineDataPath()` 把守。
 */
const atData = rel => path.join(dataDir, rel)

/**
 * 这次要用的配置文件路径：`ABYSS_QUEUE_CONFIG`（只给回归套件）优先，否则 `config/config.yaml`
 *
 * **读与写必须共用它**：一处硬编码 `configPath`、另一处走这个解析，套件里就会"面板把值写进仓库配置、
 * 插件却从临时配置读"——看着像"面板保存不生效"。
 */
export const resolveConfigPath = () => process.env.ABYSS_QUEUE_CONFIG || configPath

/**
 * 目标路径是不是在插件目录内（含插件根自身）
 *
 * 用 `path.relative` 判而不是字符串前缀：`D:\x\abyss-queue-2` 不是 `D:\x\abyss-queue` 的子路径。
 */
export const insidePlugin = (target, root = pluginRoot) => {
  const rel = path.relative(root, path.resolve(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * 唯一放行"数据落到插件外"的开关：`ABYSS_QUEUE_TEST_PATHS=1`
 *
 * **只有回归套件该设**（`test/env.mjs` 会把数据放进系统临时目录，绝不动仓库里的真数据）。
 * 生产部署不设它：设了这条规则就等于不存在。
 */
export const testPathsAllowed = () => /^(1|true|yes|on)$/i.test(String(process.env.ABYSS_QUEUE_TEST_PATHS ?? "").trim())

/**
 * 把**环境变量**里的路径收进插件目录：出圈就记 error 并**回落到插件内默认值**
 *
 * 为什么是回落而不是抛错：机器人得能起来。写表那侧由编辑器把关（它直接拒绝启动），
 * 这边（绑定 / 备份 / 进度快照）只是运行时数据，回落到插件内既保住了"数据不出去"，
 * 也不会因为一个写错的环境变量让整个机器人挂掉。回落**必须留痕**，否则"设了却没生效"没人看得出来。
 *
 * 数据落点本身已经是常量（见 `atData`），所以这里**只服务于回归套件**：
 * 生产不该设任何 `ABYSS_QUEUE_*` 路径变量；设了也在 `testPathsAllowed()` 那道闸外，
 * 由本函数挡回插件内并记 error。
 *
 * 导出是为了让回归套件能直接断言（`editor/test/data-confinement.test.mjs`）。
 *
 * @param {string} label 变量名（日志里要写清是哪个变量）
 * @param {string} raw 变量里写的值；相对路径按插件根解析；留空表示"不设"（调用方自行处理）
 * @param {string} fallbackRel 回落值（相对插件根）
 * @param {object} [opts] `log` 可换一个日志出口（套件用）
 * @returns {string} 绝对路径（插件内）
 */
export function confineDataPath(label, raw, fallbackRel, { log } = {}) {
  const fallback = path.join(pluginRoot, fallbackRel)
  const value = String(raw ?? "").trim()
  if (!value) return fallback
  const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(pluginRoot, value)
  if (insidePlugin(abs) || testPathsAllowed()) return abs
  const say = log ?? (typeof globalThis.logger?.error === "function" ? m => globalThis.logger.error(m) : m => console.error(m))
  say(
    `[abyss-queue] 配置项 ${label} 指向插件目录之外：${abs}；已回落到插件内默认值 ${fallback} —— ` +
      `数据必须留在插件目录内（${dataDir}），不要把它配到外面`,
  )
  return fallback
}

export const DEFAULT_CONFIG = {
  /**
   * 数据来源：云端编辑器（插件只读它，不碰任何本地表格文件）
   *
   * 机器人每次按 ttl_ms 从 `<url>/api/snapshot?k=<token>` 拉一份 xlsx 快照，
   * 拿去解析成 models；写表只发生在云端编辑器（部署在云服务器上）。
   * 本机联调可以把 url 指到 http://127.0.0.1:7788（本机编辑器）。
   */
  remote: {
    // 云端编辑器地址（例：https://example.com/queue）
    url: "",
    // 访问口令：与编辑器进程的 ABYSS_EDITOR_TOKEN 一致（它会出现在每个人的链接里）
    token: "",
    /**
     * 身份签名密钥：与编辑器进程的 ABYSS_EDITOR_SIGN_KEY 一致。
     * **不配就退回用 token 签**——那样任何拿到链接的人都能伪造别人的身份（包括主人），
     * 正式部署请另配一段随机串（例：openssl rand -hex 24）。
     */
    sign_key: "",
    /**
     * 管理口令：编辑器页面上打开 `?a=<这段>` 即「主人」身份（维护白名单的备用入口）。
     * 留空 = 不开这个入口。它同进程注入给编辑器，与 `token` / `sign_key` 一样属于**特权凭证**：
     * 三者互不相同才允许对外启动（见 `editor/config.js` 的 `secretsIndependent`）。
     */
    admin_token: "",
    /**
     * 群里发短链：`<url>/s/<16 字符码>`（码不透明、编辑器不用存映射，验过后换成带身份的完整地址）。
     * **编辑器要同时更新**（本仓库同一份代码）；云端还没更新时改成 false，退回长链接。
     */
    short_link: true,
    /**
     * 填报入口做成可点的**文字**（QQ 的 markdown 段：「点此填表」四个字点开就是编辑器）。
     * 默认关：多数群 / 账号不认机器人发的 markdown（实测 NTQQ 回「发送者版本过低」），
     * 虽然会自动退回纯文本链接，但每次都要先失败一次，白等一条错误日志。
     * 你那边确认能用再打开。
     */
    link_markdown: false,
    // 内存快照有效期（毫秒）：这期间连续命令不再重复拉取
    ttl_ms: 30000,
    // 单次拉取超时（毫秒）
    timeout_ms: 15000,
    /**
     * 编辑器随机器人启动（可选）：插件加载后探不到编辑器，就按这个路径把它拉起来。
     * 例：`D:/Program Files/Yunzai/Yunzai/plugins/abyss-queue/data/自定义启动脚本.cmd`
     * （.mjs 用 node 跑，.vbs 用 wscript，.cmd/.bat 用 cmd；数据目录固定在插件内，见 AGENTS.md）
     */
    autostart: "",
  },
  /**
   * 云端快照的本地备份：**默认开启**，每次成功拿到快照就往 `<插件根>/data/backup` 写一份
   *
   * 数据以云端为准，本地这份是防手滑 / 防服务端事故用的：按日期命名覆盖写，
   * 只留最近几份（超出份数由代码里的常量决定，不开放配置）。
   * 关掉它请显式设 `snapshot_backup.enable: false` —— 备不备份是**开关**，不是份数。
   */
  snapshot_backup: {
    enable: true,
  },
  // 默认榜（`#排队 全部` 不带榜名时使用）
  default_sheet: "幽境危战",
  /**
   * 群成员名单：机器人把指定群的成员推给在线编辑器
   *
   * 编辑器拿它当「群昵称候选」，并按 QQ 每天对账（改了名片同步表里的群昵称、退群删掉那一行）。
   * `group` 留空 = 关闭这个功能（本地编辑器本来就不接收名单，也就没有候选）。
   */
  roster: {
    // 群号（在群里用 #查看群号 之类拿，或直接看群资料）
    group: "",
    /**
     * 每天到这个时刻（本地时间，"HH:MM"）推一次
     *
     * 由唯一那条定时任务（`notify.cron`）在每个 tick 里拿它与当前时间比——**到点之后一整天都算数**，
     * 所以机器人半夜关着、早上才起来也会补做一次。另有启动后 20 秒的一次 kick（那次不吃"当天已推"的标记）。
     */
    at: "05:00",
  },
  // 列表显示条数（图片模式下即最大行数；0 表示全部）
  list_limit: 20,
  // 是否用图片渲染队列 / 主播 / 菜单；渲染后端不可用时自动回退文本
  render_image: true,
  // 出图分辨率倍数（设备像素比）：2 = 两倍宽高的高清图，CSS 布局不变；1 = 不放大（按 CSS 尺寸出图）
  render_scale: 2,
  // 图片模式下每列的截断宽度（按显示宽度计，中文算 2；0 = 不截断）
  // 「群昵称」与「帮帮完成情况」两列共用这一个值：它们从来是一起调的，没必要分成两个键
  render_max: 40,
  /**
   * 编辑器页脚：自由 HTML（编辑器原样插进页面底部，并在后面自动追加一行规范署名）
   *
   * 与 `editor/config.js` 的 `DEFAULTS.footerHtml` **同一份默认值**：两边都要它——
   * 插件侧要有一份"当前值"好让锅巴把三份配置填成同一份，编辑器侧并排部署时读不到插件配置就用自己的。
   */
  footer: {
    html: '<div>© 2026 <a href="https://github.com/Hyposelenia-Moon">缄月</a> &amp; <a href="https://github.com/AxiuCN">阿修Axiu</a> · 由 <a href="https://github.com/Hyposelenia-Moon/abyss-queue">abyss-queue</a> 提供</div>',
  },
  // 主播别名：正名 → 别名（按正则整串匹配、忽略大小写）
  // 表里/群里对同一位主播的其它写法（老昵称、简称）登记在这里，读的时候会归一成正名
  anchor_aliases: {},
  /**
   * 通知与唯一那条定时任务
   *
   * 四件事全在 `notify.cron` 那一条 tick 里按内部时间判断做（见 modules/notify.js）：
   * 完成情况轮询、榜开启提醒、月末催办、群成员名单同步。
   */
  notify: {
    /** 总开关：false = 三条 @ 通知全关（`groups` 一并失效，也不再提示"没配群号"）。名单同步不受它影响 */
    enable: true,
    /** 三条 @ 通知发到哪些群；留空 = 不发 */
    groups: [],
    /** 唯一那条定时任务的周期：多久检查一次（完成情况 / 开榜 / 到点没到点都靠它） */
    cron: "*/3 * * * *",
    /** 月末催办的时刻（本地时间，"HH:MM"）：每月最后一天到这个点之后当天发一次 */
    monthly_at: "12:00",
    /** 关掉月末催办（开榜提醒与完成轮询不受影响） */
    monthly_enable: true,
  },
}

const isPlainObject = v => v && typeof v === "object" && !Array.isArray(v)

function merge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === undefined || v === null) continue
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v
  }
  return out
}

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, "utf8")) ?? {}
}

/**
 * 解析失败时的**安全错误文案**
 *
 * `yaml` 库会把"出错那行/那段原文"整段塞进异常消息（`... at line 12, column 12:` 后面跟原行）。
 * 配置里那行常常就是 `token:` / `sign_key:`——**原文照抄出去等于把口令打进日志和锅巴弹窗**。
 * 所以这里只留"哪份文件 + 解析器给的原因（到第一个换行为止）"，**不带任何行内容**。
 */
function explainParseError(file, err) {
  const reason = String(err?.message ?? err).split("\n")[0].trim()
  return `解析不了 ${file}：${reason}`
}

/**
 * 读一份"用户配置"：**每次都打磁盘**，并带 `.example` 兜底
 *
 * 兜底顺序与文件头的三层结构一致：运行时 `config.yaml`（不存在时先生成）→ 参考 `config.yaml.example` → 默认值。
 *
 * @param {string} file 要读的配置文件
 * @returns {{user: object, error: string|null, file: string}} `error` 非空 = **这份文件读不出来**
 *   （语法坏掉 / 读不动）。调用方必须区别对待：缺键可以用默认值补，
 *   **"整份读不出来"绝不能被当成"用户什么都没配"**——那会在下一次保存时把用户的配置整份写成空值。
 */
function readUserConfig(file) {
  try {
    if (file === configPath) ensureConfig()
    if (fs.existsSync(file)) return { user: readYaml(file), error: null, file }
    /** 运行时那份还没生成（或读不到）时退到参考文件，别让整份配置变成"全默认" */
    if (fs.existsSync(examplePath)) return { user: readYaml(examplePath), error: null, file: examplePath }
    return { user: {}, error: null, file }
  } catch (err) {
    const message = explainParseError(file, err)
    globalThis.logger?.error?.(`[abyss-queue] 读取配置失败：${message}`)
    return { user: {}, error: message, file }
  }
}

/** 默认值 + 用户配置 → 一份完整配置（数据落点常量与套件重定向都在这里定） */function buildConfig(user) {
  const config = merge(DEFAULT_CONFIG, user)

  /** 数据文件落点：`<插件根>/data` 下的常量（见文件头的 `atData`） */
  config.storePath = atData("bindings.json")
  config.notifyStatePath = atData("progress.json")
  config.backupDir = atData("backup")
  /**
   * 编辑器那份白名单（`owner` / `admins`）：机器人侧也要按它决定 `#排队` 往哪儿发
   * （主人 / 白名单管理员 ⇒ 私聊），所以落点与上面几个同档，**同样没有配置项**。
   * 见 `model/whitelist.js`。
   */
  config.adminsPath = atData("abyss-editor-admins.json")
  /**
   * 私聊链接的旁路状态（最近一次发给了谁 / 哪个窗口 / 消息 id）：本人发 `#排队` 时记一次。
   * 见 `modules/manager-link.js`。
   */
  config.managerLinkPath = atData("manager-link.json")

  /**
   * 只有回归套件能重定向数据落点，走环境变量（**不是配置项**）
   *
   * 生产的路径上面已经拼死了，所以这里不该有任何值；真设了也在 `testPathsAllowed()`
   * 那道闸外，由 `confineDataPath` 挡回插件内并记 error。
   * `ABYSS_QUEUE_XLSX_PATH` 是套件用的本地表路径（插件侧不读表，只给表格层套件）。
   */
  if (testPathsAllowed()) {
    const env = name => String(process.env[name] ?? "").trim()
    if (env("ABYSS_QUEUE_STORE_FILE"))
      config.storePath = confineDataPath("ABYSS_QUEUE_STORE_FILE", env("ABYSS_QUEUE_STORE_FILE"), "data/bindings.json")
    if (env("ABYSS_QUEUE_STATE_FILE"))
      config.notifyStatePath = confineDataPath("ABYSS_QUEUE_STATE_FILE", env("ABYSS_QUEUE_STATE_FILE"), "data/progress.json")
    if (env("ABYSS_QUEUE_BACKUP_DIR"))
      config.backupDir = confineDataPath("ABYSS_QUEUE_BACKUP_DIR", env("ABYSS_QUEUE_BACKUP_DIR"), "data/backup")
    if (env("ABYSS_QUEUE_ADMINS_FILE"))
      config.adminsPath = confineDataPath("ABYSS_QUEUE_ADMINS_FILE", env("ABYSS_QUEUE_ADMINS_FILE"), "data/abyss-editor-admins.json")
    if (env("ABYSS_QUEUE_MANAGER_LINK_FILE"))
      config.managerLinkPath = confineDataPath(
        "ABYSS_QUEUE_MANAGER_LINK_FILE",
        env("ABYSS_QUEUE_MANAGER_LINK_FILE"),
        "data/manager-link.json",
      )
    config.xlsxPath = env("ABYSS_QUEUE_XLSX_PATH")
      ? path.resolve(pluginRoot, env("ABYSS_QUEUE_XLSX_PATH"))
      : ""
  } else {
    config.xlsxPath = ""
  }
  /** 快照备份：显式 `snapshot_backup.enable: false` 才关（留空 = 开着） */
  if (config.snapshot_backup?.enable === false) config.backupDir = ""
  return config
}

/**
 * 首次启动：从 config.yaml.example 生成运行时配置（**只补缺，不覆盖**）
 *
 * `existsSync` 判的是"文件在不在"，**不看内容**：所以这里只会在"根本没有那份文件"时复制。
 * 空白/只有注释/语法坏掉的 `config.yaml` 也**不会**被参考文件盖掉——那种文件可能是主人正在改的现场，
 * 也可能是保存失败留下的残片，拿参考文件糊上去只会让人更查不出原因。要恢复请主人自己删掉它。
 */
export function ensureConfig() {
  if (fs.existsSync(configPath) || !fs.existsSync(examplePath)) return false
  fs.mkdirSync(configDir, { recursive: true })
  fs.copyFileSync(examplePath, configPath)
  log("info", `[abyss-queue] 已从 config.yaml.example 生成 config.yaml，请先填写 remote.url（云端编辑器地址）`)
  return true
}

/**
 * **按当前文件内容**算出一份完整配置（不碰内存里那个 `config`）
 *
 * 锅巴面板读值、以及任何"必须看到别人刚写进去的东西"的地方都用它：
 * `#排队初始化` 生成密钥、维护者手工编辑、面板自己保存——这些都只改文件，
 * 而 `config` 是模块加载那一刻的快照，不会自己知道。
 *
 * @param {string} [file] 要读的文件（默认 `resolveConfigPath()`）
 * @returns {{config: object, error: string|null, file: string}} `error` 非空 = 那份文件读不出来；
 *   **要写回它之前必须先看这个字段，读不出来就别写**（否则等于拿"全默认"覆盖用户的配置）。
 */
export function readCurrentConfigWithStatus(file = resolveConfigPath()) {
  const read = readUserConfig(file)
  return { config: buildConfig(read.user), error: read.error, file: read.file }
}

/** 只要配置本体时用它（读不出来会退化成"全默认"，**不要**拿它的结果去覆盖用户文件） */
export function readCurrentConfig(file = resolveConfigPath()) {
  return readCurrentConfigWithStatus(file).config
}

export function loadConfig() {
  const read = readUserConfig(resolveConfigPath())
  return buildConfig(read.user)
}

export const config = loadConfig()

/* ------------------------- 给锅巴用的读写助手 ------------------------- */

/**
 * defSet 模板里那份"带 ${变量} 占位符"的配置模板
 *
 * 锅巴保存时读它 → 替换占位符 → 写运行时 `config/config.yaml`（**注释按模板完整保留**）。
 */
export const defSetPath = path.join(pluginRoot, "defSet", "config.yaml")

/**
 * 锅巴 field（点分隔的配置路径）→ defSet 模板变量名（下划线）
 *
 * 为什么写成函数而不是手写一张映射表：映射表会漏、会跟 schema 漂移，
 * 而"点换下划线"是一条规则，两边同时用同一份实现就永远不会对不上。
 */
export const fieldToVar = field => String(field).replace(/\./g, "_")

/** 按点分路径读配置（不会因为中间层缺失而抛错） */
export function readField(src, field) {
  let cur = src
  for (const seg of String(field).split(".")) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[seg]
  }
  return cur
}

/**
 * 把一个标量/数组/对象转成能安全写进 YAML 的字面量
 *
 * 字符串一律 `JSON.stringify`（双引号 + 转义），这样含 `#`、`:`、`"`、换行的值也不会写坏 YAML；
 * 数组与对象用手写的**单行 YAML**（`{名: ["别名"]}` / `[1, 2]`）而不是 `JSON.stringify` 的紧凑形式：
 * 两者都能被 YAML 解析，但单行 + 逗号后带空格的形式与 `config.yaml.example` 里人写的一致，
 * 锅巴保存后三份文件的行数、骨架才对得上（紧凑 JSON 会少掉空格，逐行比就漂了）。
 */
export function yamlValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  if (value === null || value === undefined) return '""'
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(yamlValue).join(", ")}]`
  return `{${Object.entries(value)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`)
    .join(", ")}}`
}

/**
 * 按 defSet 模板渲染出一份完整配置文本（锅巴保存走这条路）
 *
 * 没给的键**按文件当前值**兜底（`readCurrentConfig()`），不按内存快照：
 * 面板提交的是整张表单，但"模板里有、表单没提交"的键（例如跨层的 `footer.html`）必须照旧保留，
 * 而它的当前值只可能来自文件。
 *
 * @param {object} values 以"点分路径"为键的值（未给的键用文件当前值兜底）
 * @returns {string} 可直接写进 config/config.yaml 的文本
 */
export function renderDefSet(values = {}, template = fs.readFileSync(defSetPath, "utf8")) {
  const current = readCurrentConfig()
  let out = template
  for (const field of CONFIG_FIELDS) {
    const value = field in values ? values[field] : readField(current, field)
    out = out.replace(new RegExp(`\\$\\{${fieldToVar(field)}\\}`, "g"), yamlValue(value))
  }
  return out
}

/**
 * 锅巴面板要管的**全部配置键**（点分路径，与 `defSet/config.yaml` 里的占位符一一对应）
 *
 * 只列插件键：编辑器的启动参数（`port` / `bind` / `mount` / …）**故意不在里面**——
 * 它们从命令行与环境变量取、编辑器不读 `config.yaml`，放进面板会变成"改了不生效"
 * （口径见 `docs/开发说明.md` 的「配置键归属」）。
 */
export const CONFIG_FIELDS = [
  // 连接
  "remote.url",
  "remote.token",
  "remote.sign_key",
  "remote.admin_token",
  "remote.short_link",
  "remote.link_markdown",
  // 群号与通知
  "roster.group",
  "notify.enable",
  "notify.groups",
  "notify.cron",
  "notify.monthly_enable",
  "notify.monthly_at",
  // 展示
  "default_sheet",
  "list_limit",
  "render_image",
  "render_scale",
  "render_max",
  "anchor_aliases",
  "footer.html",
  // 高级
  "remote.ttl_ms",
  "remote.timeout_ms",
  "roster.at",
  "remote.autostart",
  "snapshot_backup.enable",
]

/**
 * `CONFIG_FIELDS` 里**由编辑器读**的键：写进 `config.yaml` 当作编辑器的输入
 *
 * `footer.html` 是唯一跨层的键——既在 `DEFAULT_CONFIG`（三份配置同构要靠它填出同一份），
 * 又与 `editor/config.js` 的 `DEFAULTS.footerHtml` **逐字相同**（并排部署时编辑器读不到插件配置就用自己那份）。
 * 编辑器的页脚在插件加载时取走，所以它也在 `RESTART_ONLY_FIELDS` 里。
 * 校验"面板字段 ↔ 配置键"时按这个集合排除。
 */
export const CROSS_LAYER_FIELDS = ["footer.html"]

/**
 * 就地重读配置（`ABYSS_QUEUE_CONFIG` / `config/config.yaml` 当前内容）
 *
 * 就地改写同一个对象，保证 `config` 这个绑定（以及各模块已 import 的引用）始终有效——
 * 15 个模块 import 的都是这**一个**对象，改它即全局生效。
 *
 * 调用点三类：回归套件写好临时配置后（见 test/env.mjs）、锅巴保存之后、以及文件 watcher 热重载。
 */
export function reloadConfig() {
  const next = loadConfig()
  for (const k of Object.keys(config)) if (!(k in next)) delete config[k]
  Object.assign(config, next)
  return config
}

/**
 * 改完要重启才生效的键
 *
 * **两类，原因不同**：
 *   - `notify.cron`：它决定**唯一那条定时任务**的周期，而 cron 是插件实例化时交给框架的
 *     （`apps/queue.js` 的 `task[].cron`），运行期改不了；
 *   - `remote.token` / `remote.sign_key` / `remote.admin_token` / `footer.html`：**编辑器在插件加载时
 *     把它们取走**（宿主 `modules/editor-host.js` 注入三个凭证，`editor/config.js` 读页脚）。
 *     插件侧会热重载、编辑器侧不会——不重启就是"插件拿着新口令、编辑器还认旧口令"，
 *     现场表现是填表链接直接 403。
 *
 * 热重载日志与锅巴保存回执都按它提醒，且**只提这次真正变了的键**（面板提交的是整张表单，
 * 按"在不在表单里"判会把每次保存都标成要重启，提醒就没意义了）。
 */
export const RESTART_ONLY_FIELDS = ["notify.cron", "remote.token", "remote.sign_key", "remote.admin_token", "footer.html"]

/**
 * 盯住配置文件，改动后热重载
 *
 * **用轮询（`fs.watchFile`），不用 chokidar / `fs.watch`。** 试过两条 OS-watcher 的路，在这台机器上
 * 都会把进程搞崩，而且崩在**原生层**（接不住）：
 *   - `chokidar.watch(文件)`：文件被删时底层 `FSWatcher` 发 `error`（`EPERM: watch`），
 *     chokidar 5 没把它转成自己的 `error` 事件 → 未捕获异常（离线套件收尾删临时配置时实测崩）；
 *   - `chokidar.watch(目录)`：退出时 libuv 断言 `!_wcsnicmp(filename, dir, dirlen)` 直接 abort。
 * 轮询的代价是"最多晚一个间隔生效"（配置文件不是热路径，完全够用），换来的是
 * **文件被删、被原子替换、被外部覆盖都不崩**，也不需要 OS 句柄。
 *
 * `persistent: false`：**别让轮询把进程吊住**——机器人本来就长期在跑，但离线套件（会 import `index.js`
 * 的那些）跑完必须能自己退出。关闭函数再 `unwatchFile` 一次，句柄落得干净。
 *
 * @param {object} [opts]
 * @param {number} [opts.debounceMs] 变更后的防抖（锅巴保存会连续触发多次写）
 * @param {number} [opts.intervalMs] 轮询间隔
 * @returns {() => void} 关闭函数（套件/热重载方用完要调）
 */
export function watchConfig({ debounceMs = 200, intervalMs = 700 } = {}) {
  const file = resolveConfigPath()
  let timer = null
  const onChange = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        const before = JSON.stringify(config)
        /** 重启类键改之前的值：提醒只提这次真的变了的（比对很便宜，而"每次都提醒"等于没提醒） */
        const beforeRestart = RESTART_ONLY_FIELDS.map(f => JSON.stringify(readField(config, f)))
        reloadConfig()
        if (JSON.stringify(config) === before) return
        const restart = RESTART_ONLY_FIELDS.filter((f, i) => JSON.stringify(readField(config, f)) !== beforeRestart[i])
        log(
          "info",
          `[abyss-queue] 配置已热重载（${file}）` +
            (restart.length ? `；${restart.join("、")} 的改动要重启机器人才生效` : ""),
        )
      } catch (err) {
        log("warn", `[abyss-queue] 配置热重载失败，继续用上一份：${err?.message ?? err}`)
      }
    }, debounceMs)
  }
  fs.watchFile(file, { interval: intervalMs, persistent: false }, (cur, prev) => {
    /** 文件被删（`cur.nlink === 0`）也照样重读：读不到就退回上一份，不崩 */
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size && cur.nlink === prev.nlink) return
    onChange()
  })
  return () => {
    if (timer) clearTimeout(timer)
    fs.unwatchFile(file)
  }
}
