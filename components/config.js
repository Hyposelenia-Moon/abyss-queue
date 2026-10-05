/**
 * 配置加载：config/config.yaml（不存在时从 config/config.yaml.example 生成）
 *
 * 同步加载，便于插件构造时决定是否注册定时任务。
 * 本文件在 components/ 下，插件根需向上一级解析（不能把 import.meta.dirname 直接当插件根）。
 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

export const pluginRoot = path.resolve(import.meta.dirname, "..")
export const configDir = path.join(pluginRoot, "config")
export const configPath = path.join(configDir, "config.yaml")
export const examplePath = path.join(configDir, "config.yaml.example")

/**
 * 数据目录：**固定** `<插件根>/data`（Windows 就是 `<Yunzai>\plugins\abyss-queue\data`）
 *
 * 绑定 / 进度快照 / 快照备份 / 字体缓存都在这儿。`data/` 已被 git 忽略，所以 `#更新 abyss`
 * 只动代码不动数据；数据一旦落到插件外面，更新与备份就会各按各的路径找，哪一份都不是完整的。
 */
export const dataDir = path.join(pluginRoot, "data")

/** 回归测试可用环境变量指定另一份配置，避免动到真实配置 */
const activeConfigPath = () => process.env.ABYSS_QUEUE_CONFIG || configPath

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
 * 把配置里的路径收进插件目录：出圈就记 error 并**回落到插件内默认值**
 *
 * 为什么是回落而不是抛错：机器人得能起来。写表那侧由编辑器把关（它直接拒绝启动），
 * 这边（绑定 / 备份 / 进度快照）只是运行时数据，回落到插件内既保住了"数据不出去"，
 * 也不会因为一份写错的配置让整个机器人挂掉。回落**必须留痕**，否则"配了却没生效"没人看得出来。
 *
 * 导出是为了让回归套件能直接断言（`editor/test/data-confinement.test.mjs`）。
 *
 * @param {string} label 配置项名（日志里要写清是哪个键）
 * @param {string} raw 配置里写的值；相对路径按插件根解析；留空表示"不设"（调用方自行处理）
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
    // 云端编辑器地址（例：https://yunzai.axiu.uno/queue）
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
     * 群里发短链：`<url>/s/<16 字符码>`（码不透明、编辑器不用存映射，验过后换成带身份的完整地址）。
     * **编辑器要同时更新**（本仓库同一份代码）；云端还没更新时改成 false，退回原来的长链接。
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
     * 例：D:/Program Files/Yunzai/Yunzai/plugins/abyss-queue/data/editor-launch.mjs
     * （.mjs 用 node 跑，.vbs 用 wscript，.cmd/.bat 用 cmd；数据目录固定在插件内，见 AGENTS.md）
     */
    autostart: "",
  },
  /**
   * 云端快照的本地备份：每次成功拿到快照就往本地写一份
   *
   * 数据以云端为准，本地这份是防手滑/防服务端事故用的：**只留最新的 keep 份**（默认 1 份），
   * 按日期命名覆盖写；dir 留空或 keep=0 表示不备份。
   * 注意别和上面的 `backup`（写表前的 .bak）混了：那个只对编辑器的本地表生效。
   */
  snapshot_backup: {
    // 目录：相对路径按插件根解析；例：data/backup
    dir: "data/backup",
    // 保留份数：1 = 只留最新
    keep: 1,
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
     * 以前这里是 cron（`0 5 * * *`），现在唯一的定时任务（`notify.cron`）在每个 tick 里
     * 拿它与当前时间比——**到点之后一整天都算数**，所以机器人半夜关着、早上才起来也会补做一次。
     * 另有启动后 20 秒的一次 kick（那次不吃"当天已推"的标记）。
     */
    at: "05:00",
  },
  // 列表显示条数（图片模式下即最大行数；0 表示全部）
  list_limit: 20,
  // 是否用图片渲染队列 / 主播 / 菜单；渲染后端不可用时自动回退文本
  render_image: true,
  // 出图分辨率倍数（设备像素比）：2 = 两倍宽高的高清图，CSS 布局不变；1 = 与旧版一致
  render_scale: 2,
  // 图片模式的列截断宽度（显示宽度，中文算 2；0 = 不截断）
  render_name_max: 40,
  render_status_max: 40,
  // 字体：首次渲染时从云端拉取并缓存到 data/fonts（不入库）；false = 不下载，直接用系统字体
  font_download: true,
  // 字体镜像（按顺序尝试；留空则用内置的 jsDelivr / raw.githubusercontent 多镜像）
  font_mirrors: [],
  // 写表前是否备份为 <原文件名>.bak（插件不写表；这项只对编辑器的本地表生效）
  backup: true,
  // 主播别名：正名 → 别名（按正则整串匹配、忽略大小写）
  // 表里/群里对同一位主播的其它写法（老昵称、简称）登记在这里，读的时候会归一成正名
  anchor_aliases: {},
  /**
   * 定时推送功能的**残留**：只剩 `groups`
   *
   * 队列推送（`pushQueue`）与 `push.enable` / `push.cron` / `push.sheets` / `push.limit`
   * 都已随"只留一条定时任务"一起删掉。这里留着 `groups` **只为兼容老配置**：
   * 它现在是 `notifyGroups()` 的**通知群号回退来源**（`notify.groups` 留空时用），
   * 不再有任何推送行为。新部署请直接写 `notify.groups`。
   */
  push: {
    groups: [],
  },
  /**
   * 通知与唯一那条定时任务
   *
   * 四件事全在 `notify.cron` 那一条 tick 里按内部时间判断做（见 lib/notify.js）：
   * 完成情况轮询、榜开启提醒、月末催办、群成员名单同步。
   */
  notify: {
    enable: true,
    /** 发到哪些群；留空则回落到 push.groups（兼容老配置） */
    groups: [],
    /** 唯一那条定时任务的周期：多久检查一次（完成情况 / 开榜 / 到点没到点都靠它） */
    cron: "*/3 * * * *",
    /** 月末催办的时刻（本地时间，"HH:MM"）：每月最后一天到这个点之后当天发一次 */
    monthly_at: "12:00",
    /** 关掉月末催办（开榜提醒与完成轮询不受影响） */
    monthly_enable: true,
    /** 定时任务的状态文件：进度快照 + 每榜开启标记 + 当天已做的标记都在这儿 */
    state_file: "data/progress.json",
  },
  // 绑定数据文件（相对插件目录）
  store_file: "data/bindings.json",
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

/** 首次启动：从 config.yaml.example 生成运行时配置（幂等） */
export function ensureConfig() {
  if (fs.existsSync(configPath) || !fs.existsSync(examplePath)) return false
  fs.mkdirSync(configDir, { recursive: true })
  fs.copyFileSync(examplePath, configPath)
  globalThis.logger?.mark?.(`[abyss-queue] 已从 config.yaml.example 生成 config.yaml，请先填写 remote.url（云端编辑器地址）`)
  return true
}

export function loadConfig() {
  let user = {}
  const file = activeConfigPath()
  try {
    if (file === configPath) ensureConfig()
    if (fs.existsSync(file)) user = readYaml(file)
  } catch (err) {
    globalThis.logger?.error?.(`[abyss-queue] 读取配置失败：${err.message}`)
  }

  const config = merge(DEFAULT_CONFIG, user)
  /**
   * `xlsx_path` 只解析不收紧：插件侧已经不写表，读本地 xlsx 只发生在回归套件里；
   * 生产环境"表必须待在插件 data 内"由**编辑器**把关（它解析到插件外会拒绝启动，见 editor/editor.mjs）。
   */
  config.xlsxPath = config.xlsx_path
    ? path.isAbsolute(config.xlsx_path)
      ? config.xlsx_path
      : path.join(pluginRoot, config.xlsx_path)
    : ""
  /** 下面三项都是"往哪儿写"：出圈一律记 error + 回落插件内默认值（见 confineDataPath） */
  config.storePath = confineDataPath("store_file", config.store_file, "data/bindings.json")
  /** 云端快照的本地备份目录：目录留空或 keep=0 都不备份（留空不是"出圈"，保持不备份） */
  config.backupDir = String(config.snapshot_backup?.dir ?? "").trim()
    ? confineDataPath("snapshot_backup.dir", config.snapshot_backup.dir, "data/backup")
    : ""
  /** 进度快照（apps/queue.js 也用它，见那边的 statePath()） */
  config.notifyStatePath = confineDataPath("notify.state_file", config.notify?.state_file, "data/progress.json")
  return config
}

export const config = loadConfig()

/**
 * 按当前 ABYSS_QUEUE_CONFIG 重新读取配置
 *
 * 存在的理由：Node 先求值依赖模块，测试文件里「先 setenv 再 import 插件」并不成立——
 * config.js 早在 env 设置之前就按仓库 config.yaml 读完了。回归套件因此在写好临时配置后
 * 调用本函数（见 test/env.mjs）。
 *
 * 就地改写同一个对象，保证 config 这个绑定（以及各模块已 import 的引用）始终有效。
 */
export function reloadConfig() {
  const next = loadConfig()
  for (const k of Object.keys(config)) if (!(k in next)) delete config[k]
  Object.assign(config, next)
  return config
}
