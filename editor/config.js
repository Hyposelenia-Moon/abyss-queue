/**
 * 编辑器启动配置：**所有路径与开关的唯一口径**
 *
 * 这里做三件事，做完就该能直接起服务：
 *   1. 解析 argv / 环境变量（`flag` / `boolFlag` 一份实现，见 cli.js）
 *   2. 算清所有落点：表本体、`.bak`、绑定、白名单、锁、群名单、`versions/`、`archives/`
 *   3. fail closed：缺表 / 表在插件外 / 没口令又没 `--allow-no-token` / 开了主人专用却没主人 ——
 *      一律**打印原因后拒绝启动**
 *
 * 数据落点的规矩（生产口径）：
 *   - 数据目录**固定** `<插件根>\data`，表与它派生的一切都必须在这里面；
 *     `--file`（或 `ABYSS_EDITOR_FILE`）解析到插件外就报错退出，**不"纠正"到别处继续跑**
 *     —— 那样只会让人以为配置生效了，而数据其实写到了另一个地方。
 *   - 唯一放行开关是 `ABYSS_EDITOR_TEST_PATHS=1`（**只有回归套件该设**）：
 *     设了之后数据文件跟着表格所在目录走（套件的工作区是系统临时目录），
 *     `--admins` / `ABYSS_EDITOR_*_FILE` / `_DIR` 这些覆盖也才生效；生产设了等于把规矩让开。
 */
import fs from "node:fs"
import path from "node:path"

import { makeBoolFlag, makeFlag, setupLogFile } from "./cli.js"
import { isHostMode } from "./injected.js"
import { TEMPLATE, attributionLine, makeShared, pluginRoot, resolvePluginDir } from "./plugin-root.js"

/**
 * 默认值：**唯一来源**
 *
 * 新增配置项时按三步走，别在下面 `cfg` 里散写常量：
 *   1. 在这里加一条默认值（将来的配置模板/校验/锅巴字段都从这里取，不用改业务代码）；
 *   2. 在 `cfg` 里接上"参数优先、环境变量兜底"的取值；
 *   3. 若它是**路径**，写进 `paths`（由 `dataBase` 派生），别自己 `path.join`。
 *
 * 参数与环境变量的对应关系（`editor/README.md` 的参数表是同一份口径）：
 *
 * | 参数 | 环境变量 | 默认 |
 * |------|----------|------|
 * | `--file` | `ABYSS_EDITOR_FILE` | **必填**（插件配置里已经没有 `xlsx_path` 这个键了） |
 * | `--plugin` | `ABYSS_PLUGIN_DIR` | 自定位（`editor/` 的上一级） |
 * | `--port` | `ABYSS_EDITOR_PORT` | 7788 |
 * | `--bind` | `ABYSS_EDITOR_BIND` | 127.0.0.1 |
 * | `--token` | `ABYSS_EDITOR_TOKEN` | 空（空则必须显式 `--allow-no-token` 才起） |
 * | `--sign-key` | `ABYSS_EDITOR_SIGN_KEY` | 退回口令（正式部署必须单独配） |
 * | `--admin-token` | `ABYSS_EDITOR_ADMIN_TOKEN` | 空（管理接口不开） |
 * | `--owner` | `ABYSS_EDITOR_OWNER` | 空（`--owner-only` 时必须有主人） |
 * | `--owner-only` | `ABYSS_EDITOR_OWNER_ONLY` | false |
 * | `--mount` | `ABYSS_EDITOR_MOUNT` | "/queue" |
 * | `--cloud` | `ABYSS_EDITOR_CLOUD` | 空 |
 * | `--roster-qq` | `ABYSS_EDITOR_ROSTER_QQ` | "0" |
 * | `--log` | `ABYSS_EDITOR_LOG` | 空（不写日志文件） |
 * | — | 插件配置 `footer.html` | 署名首行（编辑器页脚的自定 HTML，见 config.yaml.example） |
 * | `--versions-keep` ⏳ | `ABYSS_EDITOR_VERSIONS_KEEP` | 20 |
 * | （未接） | `ABYSS_EDITOR_ARCHIVE_DAYS` | 7 |
 * | （未接） | `ABYSS_EDITOR_ARCHIVES_KEEP` | 12 |
 * | `--admins`、`*_FILE`、`*_DIR` | 同左 | 派生自 `<插件根>/data`（**只在 `ABYSS_EDITOR_TEST_PATHS=1` 时生效**） |
 *
 * ⏳ **待接接口**：`--versions-keep` / `--archive-days` / `--archives-keep` 三个参数**当前不解析**
 * （只读环境变量），`editor/README.md` 与 `editor/test/versions.test.mjs` 因此按环境变量口径引用它们。
 * 等编辑器配置层统一（配置模板 + 校验 + 默认值都取自 `DEFAULTS`）时一并接上或删掉——
 * **在那之前不要单独把某一个参数接上**，否则同一份文档会对应两套半成品口径。
 */
export const DEFAULTS = {
  port: 7788,
  bind: "127.0.0.1",
  mount: "/queue",
  rosterQq: "0",
  /** 历史版本保留份数（0 = 不存版本） */
  versionsKeep: 20,
  /** 每日归档只留最近几天 */
  archiveDays: 7,
  /** 每月归档长期保留几个月 */
  archivesKeep: 12,
  /**
   * 编辑器页脚的默认内容：署名首行（备案号等由维护者接在后面；置空 = 不显示页脚）
   *
   * 它只是**自由 HTML 那部分**的兜底；规范署名行（`Created By Yunzai-Bot …`）由编辑器自己追加，
   * 不写在这里（见下面的 `withFooterLine`）。
   */
  footerHtml:
    '<div>© 2026 <a href="https://github.com/Hyposelenia-Moon">缄月</a> &amp; <a href="https://github.com/AxiuCN">阿修Axiu</a> · 由 <a href="https://github.com/Hyposelenia-Moon/abyss-queue">abyss-queue</a> 提供</div>',
}

/**
 * 页脚 = 配置里的自由 HTML + **规范署名行**（`Created By Yunzai-Bot …`，口径见 AGENTS.md §3.5）
 *
 * 署名行固定由编辑器追加（`plugin-root.js` 的 `attributionLine` 按编辑器定位到的插件根推导版本），
 * 所以维护者改自由 HTML 时不必、也不该把版本号抄进去。
 * 自由 HTML 留空 = 整块不渲染（署名行也不凭空冒出来）——那是维护者显式关掉页脚的开关。
 *
 * @param {string} html 配置 `footer.html` 的自由 HTML
 * @param {string} line 规范署名行
 * @returns {string} 插进页面的页脚 HTML（空串 = 不渲染页脚块）
 */
const withFooterLine = (html, line) => {
  /**
   * 字面 `\n` 当换行：在面板里手打 `\n`（老注释教的写法）存下来是"反斜杠 + n"两个字符
   * ——`yamlValue()` 走 `JSON.stringify`，反斜杠被再转义一层，YAML 解析回来仍然不是换行 ——
   * 页面就会把 `\n` 照字面画出来。老配置不该因此报废，所以这里容忍它；**新写法是直接换行**。
   */
  const free = String(html ?? "")
    .replace(/\\[rn]/g, "\n")
    .trim()
  return free ? `${free}\n<div>${line}</div>` : ""
}

/** 数据文件名（一律落在 `dataBase` 下，只有一个出处） */
const FILES = {
  admins: "abyss-editor-admins.json",
  locks: "abyss-editor-locks.json",
  roster: "abyss-editor-roster.json",
  bindings: "abyss-editor-bindings.json",
  claims: "abyss-editor-claims.json",
  versionsDir: "versions",
  archivesDir: "archives",
}

/**
 * 配置装配失败（**只有宿主模式会抛**）
 *
 * 独立进程照旧"打印原因 + `process.exit(1)`"（套件靠退出码判定该拒绝的拒绝了）；
 * 宿主模式下不能退出——那会把 bot 一起带走——所以抛出来，由宿主自己决定怎么处置
 * （记日志、不挂载编辑器，bot 继续跑）。
 */
export class EditorConfigError extends Error {
  constructor(lines) {
    super(lines[0] ?? "编辑器配置不合法")
    this.name = "EditorConfigError"
    /** 逐行原因（与独立进程打到 stderr 的内容一致） */
    this.lines = lines
  }
}

/**
 * fail closed：说清原因并停下（**永远不会"漏配还开着门"**）
 *
 * 两条路的收尾不同：
 *   - **独立进程**：逐行打到 stderr，然后退出码 1（套件靠退出码与输出判"该拒绝的拒绝了"）；
 *   - **宿主模式**：只抛给宿主，**不自己往 stderr 打**——这台机器的 stdout / stderr 是 bot 的，
 *     绕过框架 logger 的输出没有时间戳 / 等级，而且宿主紧接着还会把同一批原因记一遍日志。
 *
 * @param {string[]} lines 逐行原因
 */
function failClosed(lines) {
  if (isHostMode()) throw new EditorConfigError(lines)
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** 读一个 JSON 文件；读不出来一律当 null（调用方决定怎么兜） */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** 逗号 / 空格分隔的名单（`--owner 1,2` / `ABYSS_EDITOR_OWNER="1 2"`） */
const splitList = raw =>
  String(raw ?? "")
    .split(/[,，\s]+/)
    .map(s => s.trim())
    .filter(Boolean)

/**
 * 监听地址是不是**回环**（只在本机可连）
 *
 * 判据只认能确认"出不了本机"的写法：别的地址一律当作对外，宁可让人显式写清楚，
 * 也不要把一个认不出来的地址默认成"安全的本机绑定"。
 */
const isLoopbackBind = bind => {
  const raw = String(bind ?? "").trim().toLowerCase()
  const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0]
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.")
}

/**
 * 三个凭证是不是**各自独立**（口令不会被当成签名密钥或管理口令用）
 *
 * 为什么要成一条启动规则：口令（`k=`）会出现在**每个人的链接**里，它不是只在服务器内保管的密钥。
 * 一旦 SIGN_KEY 退回口令，拿到链接的人就能签出主人的身份；ADMIN_TOKEN 等于口令时，
 * 普通链接持有者直接拿到完整管理能力。两者都让"身份"这层保护失效。
 * @returns {{ok: boolean, shared: string[]}} 共享了哪几对（`口令与签名密钥` / `口令与管理口令` / `签名密钥与管理口令`）
 */
const secretsIndependent = ({ token, signKey, adminToken }) => {
  const shared = []
  if (!signKey) shared.push("缺少独立的 SIGN_KEY（--sign-key / ABYSS_EDITOR_SIGN_KEY）")
  else if (signKey === token) shared.push("SIGN_KEY 与 TOKEN 相同（会退回用链接里的口令签身份）")
  if (adminToken && adminToken === token) shared.push("ADMIN_TOKEN 与 TOKEN 相同（普通链接持有者直接拿到主人口令）")
  if (adminToken && signKey && adminToken === signKey) shared.push("ADMIN_TOKEN 与 SIGN_KEY 相同（签名密钥不是独立凭证）")
  return { ok: shared.length === 0, shared }
}

/**
 * 组装编辑器配置
 *
 * @param {object} [deps]
 * @param {(name:string,fallback?:string)=>string} [deps.flag]
 * @param {(name:string,envValue?:string)=>boolean} [deps.boolFlag]
 * @returns {Promise<{cfg: object, internal: object, envOwners: string[], envAdmins: string[]}>}
 *   `cfg` 供 HTTP 层与启动日志用（含所有路径与开关）；
 *   `internal` 是插件侧配置的透传（`config.footer` / `config.anchor_aliases`）；
 *   `envOwners` / `envAdmins` 是环境变量（或参数）里写死的名单——它们不是路径，不受测试模式开关影响。
 */
export async function createConfig({ flag = makeFlag(), boolFlag = makeBoolFlag() } = {}) {
  /**
   * 日志重定向要在**任何输出之前**装好，否则早期消息不会进日志文件
   *
   * 宿主模式下**不装**：那时 stdout 是 bot 的，编辑器把 `console.log` 换掉等于接管了 bot 的输出。
   */
  if (!isHostMode()) setupLogFile(flag("--log", process.env.ABYSS_EDITOR_LOG ?? ""))

  const pluginDir = resolvePluginDir(flag)
  const shared = makeShared(pluginDir)

  /** 插件侧配置（`footer` / `anchor_aliases`）与"在不在插件目录里"的判定，都从插件拿，别在这儿再写一遍 */
  const { config, insidePlugin } = await shared("components/config.js")

  /** 规范署名行：按**编辑器自己定位到的插件根**推导版本与插件名（见 `plugin-root.js`） */
  const footerLine = await attributionLine(pluginDir)

  /** 数据目录：固定 `<插件根>/data`（表与它派生的一切都收在这里） */
  const dataDir = path.join(pluginDir, "data")

  /** 唯一放行"数据放插件外"的开关：只有回归套件该设 */
  const testPaths = /^(1|true|yes|on)$/i.test(String(process.env.ABYSS_EDITOR_TEST_PATHS ?? "").trim())

  /**
   * 表文件：只认 `--file` / `ABYSS_EDITOR_FILE`
   *
   * 没有别的兜底来源，所以"没给表路径"就是明确的漏配，直接拒绝启动而不是去猜。
   */
  const fromFlag = flag("--file", process.env.ABYSS_EDITOR_FILE ?? "")
  const xlsxPath = fromFlag ? path.resolve(fromFlag) : ""

  if (!xlsxPath) {
    failClosed([
      "没有指定表格文件：用 --file <xlsx> 或环境变量 ABYSS_EDITOR_FILE",
      `表必须放在 ${dataDir} 里（数据目录固定、不可配置）`,
    ])
  }
  if (!testPaths && !insidePlugin(xlsxPath, dataDir)) {
    const from = "--file / ABYSS_EDITOR_FILE"
    failClosed([
      `[editor] 数据必须留在插件目录内：表格只能待在 ${dataDir}`,
      `  解析出的路径：${xlsxPath}（来源：${from}）`,
      `  插件根：${pluginDir}`,
      "  数据一旦落到插件外面，`#更新 abyss`（只动代码）与备份/迁移就会各按各的路径找，哪一份都不是完整的；",
      `  把表放进 ${dataDir} 再启动。回归套件要指临时目录，请显式设 ABYSS_EDITOR_TEST_PATHS=1。`,
    ])
  }
  if (!fs.existsSync(xlsxPath))
    failClosed([
      `表格不存在：${xlsxPath}`,
      `  从插件自带的空模板起一份：把 ${path.join(pluginDir, "resources", "空模板.xlsx")} 复制成 ${xlsxPath}`,
      "  表格是数据本体，插件不会替你生成；没有它编辑器不提供服务（机器人照常跑）",
    ])

  /** 数据文件落点（除表本体外的一切）：生产固定 data/；测试模式沿用"表格旁边" */
  const dataBase = testPaths ? path.dirname(xlsxPath) : dataDir
  const sibling = name => path.join(dataBase, name)

  /** 显式的数据文件覆盖：只在测试模式生效，生产一律忽略并记 warn（否则"数据不许出插件"就是一句话的事） */
  const pathOverride = (label, value) => {
    const raw = String(value ?? "").trim()
    if (!raw) return ""
    if (testPaths) return raw
    console.warn(`[editor] 忽略 ${label}（生产模式：数据文件固定在 ${dataBase}，不允许指到别处）`)
    return ""
  }

  /** 非负整数配置项：非法/负数回落到默认值 */
  const nonNegative = (envName, fallback) => {
    const raw = Number(process.env[envName] ?? fallback)
    return raw >= 0 ? raw : fallback
  }

  const cfg = {
    pluginDir,
    dataDir,
    testPaths,
    xlsxPath,
    dataBase,
    template: TEMPLATE,

    /** 鉴权三件套：口令（进链接） / 签名密钥（不进链接） / 管理口令 */
    token: String(flag("--token", process.env.ABYSS_EDITOR_TOKEN ?? "")).trim(),
    allowNoToken: boolFlag("--allow-no-token", process.env.ABYSS_EDITOR_ALLOW_NO_TOKEN ?? ""),
    signKey: String(flag("--sign-key", process.env.ABYSS_EDITOR_SIGN_KEY ?? "")).trim(),
    adminToken: String(flag("--admin-token", process.env.ABYSS_EDITOR_ADMIN_TOKEN ?? "")).trim(),
    /** 只给主人用（本机编辑器开；云端不开）——其他人一律 403，只有取数与探活接口放行 */
    ownerOnly: boolFlag("--owner-only", process.env.ABYSS_EDITOR_OWNER_ONLY ?? ""),

    /** 监听：端口 / 地址 */
    port: Number(flag("--port", process.env.ABYSS_EDITOR_PORT ?? DEFAULTS.port)),
    bind: flag("--bind", process.env.ABYSS_EDITOR_BIND ?? DEFAULTS.bind),
    /** 挂载前缀（nginx 子路径部署时用；带前缀与已被剥离两种都接受） */
    mount: String(flag("--mount", process.env.ABYSS_EDITOR_MOUNT ?? DEFAULTS.mount)).replace(/\/+$/, ""),
    /** 云端编辑器地址（本机编辑器才配）：配了以后页面上才有「上传覆盖云端」 */
    cloudUrl: String(flag("--cloud", process.env.ABYSS_EDITOR_CLOUD ?? "")).trim().replace(/\/+$/, ""),

    /**
     * 页脚 HTML：插件配置的 `footer.html`（自由 HTML）+ 编辑器追加的**规范署名行**（留空 = 不显示）。
     *
     * 自由那部分**不拆字段、不校验**：版权与备案怎么排由维护者决定，编辑器只负责"有就画、没有就不画"；
     * 署名行固定是 `Created By Yunzai-Bot {宿主版本} & {插件名} {插件版本}`，由 `attributionLine` 推导，
     * **不从配置里读**（配置里的 `footer.html` 因此可以自由编辑，不用管版本号）。
     * 含 `<script>` 也会被原样插进页面——因为这份内容只由维护者维护（不是群友输入），
     * 与"白名单只认 QQ、群昵称不算身份"是两回事，别把用户可控内容接到这里。
     */
    footerHtml: withFooterLine(config.footer?.html ?? DEFAULTS.footerHtml, footerLine),

    /** 落点：白名单 / 完成情况锁 / 群名单 / 绑定 */
    adminsFile: path.resolve(
      pathOverride("--admins / ABYSS_EDITOR_ADMINS_FILE", flag("--admins", process.env.ABYSS_EDITOR_ADMINS_FILE ?? "")) ||
        sibling(FILES.admins),
    ),
    locksFile: path.resolve(
      pathOverride("ABYSS_EDITOR_LOCKS_FILE", process.env.ABYSS_EDITOR_LOCKS_FILE ?? "") || sibling(FILES.locks),
    ),
    rosterFile: path.resolve(
      pathOverride("ABYSS_EDITOR_ROSTER_FILE", process.env.ABYSS_EDITOR_ROSTER_FILE ?? "") || sibling(FILES.roster),
    ),
    bindingsFile: sibling(FILES.bindings),
    /**
     * 链接认领：一条链接由第一台打开它的设备认领，其余设备只能看（见 `editor/claims.js`）
     *
     * 与白名单 / 锁 / 群名单同一档：**表旁的旁路状态**，生产固定落在 `<插件根>/data`。
     */
    claimsFile: sibling(FILES.claims),
    /** 机器人专用 QQ：群名单只有它（或主人）能推 */
    rosterQq: String(flag("--roster-qq", process.env.ABYSS_EDITOR_ROSTER_QQ ?? DEFAULTS.rosterQq)).trim() || DEFAULTS.rosterQq,

    /** 历史版本：写表前存一份，只留最近 `versionsKeep` 份（空目录 = 从第一次写表开始攒）。
     *  自动保存那条路要节流（见 `versions.js` 的 `AUTOSAVE_SNAPSHOT_MS`），否则一次编辑会话就能把窗口吃光 */
    versionsDir: path.resolve(
      pathOverride("ABYSS_EDITOR_VERSIONS_DIR", process.env.ABYSS_EDITOR_VERSIONS_DIR ?? "") || sibling(FILES.versionsDir),
    ),
    versionsKeep: nonNegative("ABYSS_EDITOR_VERSIONS_KEEP", DEFAULTS.versionsKeep),
    /**
     * 归档：`queue-YYYY-MM.xlsx` = 每月最后一次修改（长期保留，最多 `archivesKeep` 个月）；
     * `queue-YYYY-MM-DD.xlsx` = 每日起始状态（只留最近 `archiveDays` 天）
     */
    archivesDir: path.resolve(
      pathOverride("ABYSS_EDITOR_ARCHIVES_DIR", process.env.ABYSS_EDITOR_ARCHIVES_DIR ?? "") || sibling(FILES.archivesDir),
    ),
    archiveDays: nonNegative("ABYSS_EDITOR_ARCHIVE_DAYS", DEFAULTS.archiveDays),
    archivesKeep: nonNegative("ABYSS_EDITOR_ARCHIVES_KEEP", DEFAULTS.archivesKeep),
  }

  /** 签名密钥没单独配就退回口令（仅本机联调；正式部署必须分开，否则拿到链接的人能伪造身份） */
  if (!cfg.signKey) cfg.signKey = cfg.token

  /** 环境变量/参数里写死的主人（管理接口删不掉，只能改环境变量） */
  const envOwners = splitList(flag("--owner", process.env.ABYSS_EDITOR_OWNER ?? ""))
  /** 环境变量里写死的白名单（同上；注意它不是路径，不受测试模式开关影响） */
  const envAdmins = splitList(process.env.ABYSS_EDITOR_ADMINS ?? "")

  /**
   * fail closed：没口令 = 谁来都是管理员（能覆盖整张表、改白名单），必须显式放行才起。
   * 主人专用模式还要有主人，否则"只有主人能开"会退化成"谁都能开"（白名单文件里的 owner 也算）。
   */
  if (!cfg.token && !cfg.allowNoToken) {
    failClosed([
      "[editor] 拒绝了启动：没有设置访问口令（谁拿到地址谁就是管理员，能覆盖整张表）。",
      "  正式部署：--token <口令> 或 ABYSS_EDITOR_TOKEN=<口令>；",
      "  本机测试确实不需要口令时，请显式加 --allow-no-token（或 ABYSS_EDITOR_ALLOW_NO_TOKEN=1）。",
    ])
  }
  if (cfg.ownerOnly) {
    const fileOwners = readJsonFile(cfg.adminsFile)?.owner
    const hasOwner = envOwners.length > 0 || (Array.isArray(fileOwners) && fileOwners.some(v => String(v ?? "").trim()))
    if (!hasOwner) {
      failClosed([
        "[editor] 拒绝了启动：开了 --owner-only 但没给主人（--owner / ABYSS_EDITOR_OWNER，或白名单文件里的 owner）。",
        "  否则「只有主人能开」会退化成「谁都能开」；要么补上主人，要么去掉 --owner-only。",
      ])
    }
  }

  /**
   * fail closed：**公网部署不允许把口令复用成特权凭证**
   *
   * 口令（`k=`）出现在每个人的链接里，签名密钥与管理口令是只在服务器内保管的特权凭证。
   * 三者混用会让"我是谁"这层保护直接失效（拿到链接就能签主人身份 / 直接当主人使唤），
   * 所以对外的编辑器宁可起不来，也不带着这种配置开门。
   *
   * **本地兼容模式**（回环绑定 + 显式测试开关 `ABYSS_EDITOR_TEST_PATHS=1`）才允许退回用口令签：
   * 它只在开发机上连得通，且必须由人显式打开那个开关——两个条件缺一个都按公网口径拒绝。
   */
  {
    const { ok, shared } = secretsIndependent({ token: cfg.token, signKey: cfg.signKey, adminToken: cfg.adminToken })
    const loopback = isLoopbackBind(cfg.bind)
    if (!ok && !(cfg.testPaths && loopback)) {
      failClosed([
        "[editor] 拒绝了启动：访问口令被复用成了特权凭证。",
        ...shared.map(s => `  - ${s}`),
        `  监听地址：${cfg.bind}${loopback ? "（回环）" : "（对外）"}${cfg.testPaths ? "" : "；测试开关未开"}`,
        "  口令会出现在每个人的链接里，拿它当签名密钥/管理口令等于任何人拿到链接就能冒充主人。",
        "  正式部署请另配一段随机串：--sign-key <随机串>（或 ABYSS_EDITOR_SIGN_KEY），例：openssl rand -hex 24；",
        "  确实要在本机联调时退回用口令签，必须同时满足：绑定回环地址（--bind 127.0.0.1）+ ABYSS_EDITOR_TEST_PATHS=1。",
      ])
    }
    /**
     * 本地兼容模式下**为什么**被放行：启动日志必须如实说出来。
     *
     * 留一个空数组（而不是 undefined）是给调用方的稳定契约：`cfg.sharedSecrets.length` 随时可用，
     * 不用再判一次有没有这个字段。走到这里时 `!ok` 只可能是"两个条件都满足"，否则上面已经拒绝启动。
     */
    cfg.sharedSecrets = ok ? [] : shared
  }

  return { cfg, internal: { config, insidePlugin }, envOwners, envAdmins }
}

/** 供调用方复用（`editor.mjs` 也要按相对路径加载插件模块） */
export { makeShared, pluginRoot }
