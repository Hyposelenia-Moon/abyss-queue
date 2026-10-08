/**
 * 排队表在线编辑器（零额外依赖：只用 node 内置模块 + jszip）
 *
 * 群友在浏览器里填表，机器人在群里发链接。设计要点：
 *   - 只暴露「需要填的字段」：群昵称 / 原神游戏名 / 选择主播 / 难度及目标 / 账号强度 / 帮帮完成情况 / 备注
 *   - 权限：链接带发送者身份签名（model/identity.js）——
 *       白名单里的 **QQ**（主人 / 管理员，见 editor/acl.js）可改所有人的信息；
 *       其余人只拿得到、也只改得动自己那一行；
 *       没有签名（链接被转发、直接打开域名）只能只读浏览
 *   - 完成情况：普通人可以填自己那一行，但**主播（白名单）改过之后这一行就锁上**，不再让本人改
 *   - 写入走插件自己的 Table.mutate：写前备份 `.bak`、写入后回读自检，校验不过放弃写入
 *   - 可部署到云服务器：监听地址、端口、口令都可用环境变量/参数指定
 *   - **数据落点固定**：表与它派生的一切（`.bak` / 绑定 / 白名单 / 锁 / 群名单 / versions / archives）
 *     都必须在 `<插件根>\data` 里；`--file` 解析到插件外就**拒绝启动**（见 resolveFile）。
 *     唯一例外是回归套件的 `ABYSS_EDITOR_TEST_PATHS=1`（允许指到系统临时目录），生产不许设。
 *
 * 独立跑（本机调试 / 回归套件）：
 *   node editor/editor.mjs --file data/queue.xlsx --allow-no-token
 *   → http://127.0.0.1:7788/queue/（没设口令时本机等同管理员）
 *
 * 随机器人跑（正式部署 · 默认）：由 `modules/editor-host.js` 挂到 bot 自己的 HTTP server 上，
 * 表固定 `data/queue.xlsx`、凭证由宿主注入（详见 editor/README.md）。
 *
 * 云服务器（详见 editor/DEPLOY.md）：
 *   ABYSS_EDITOR_FILE=/srv/abyss/queue.xlsx \
 *   ABYSS_EDITOR_TOKEN=<随机口令> \
 *   ABYSS_EDITOR_ADMIN_TOKEN=<管理口令> \
 *   ABYSS_EDITOR_BIND=0.0.0.0 \
 *   node editor.mjs
 *
 * 参数（优先级高于环境变量）：
 *   --file <xlsx>         表格文件（生产中必须落在 <插件根>\data 内）
 *   --port <n>            端口，默认 7788
 *   --bind <addr>         监听地址，默认 127.0.0.1；对外服务填 0.0.0.0
 *   --token <口令>        访问口令；留空则不校验（仅本机测试用）
 *   --admin-token <口令>  管理口令：用它打开 `?a=<口令>` 可维护白名单
 *   --admins <json>       白名单文件；生产固定 <插件根>\data\abyss-editor-admins.json（仅测试模式可改）
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createConfig } from "./config.js"
import { injectedBoolFlag, injectedFlag, injectedLog, isHostMode } from "./injected.js"
import { makeAuditLog } from "./audit.js"
import { aclQq, createAcl, lockKey, lockRowOf, lockSheetOf } from "./acl.js"
import { createRoster } from "./roster.js"
import { createVersions, resolveStoredFile, RE_VERSION } from "./versions.js"
import { bindView, bindDel, bindSet, createOwnership, dropBindsAt, rebuildOwnership, renameLock } from "./ownership.js"
import { createAuth } from "./http/auth.js"
import { createPages } from "./http/pages.js"
import { claimKeyOf, createClaims } from "./claims.js"

/**
 * 退出与崩溃自述
 *
 * 这台机器上编辑器偶尔会"无声消失"，日志里什么都没有。把退出原因写清楚，
 * 下次再死就能一眼看出是被信号带走、还是自己崩了。
 *
 * **宿主模式下一条都不装**：那时进程是 bot 的，抢 `uncaughtException` 会把 bot 的兜底顶掉、
 * 抢 `SIGINT/SIGTERM` 会把 bot 的优雅退出流程截断——编辑器在别人家里不能管别人的生死。
 */
if (!isHostMode()) {
  process.on("exit", code => console.log(`[editor] 进程退出，code=${code}`))
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"])
    process.on(sig, () => {
      console.log(`[editor] 收到 ${sig}，退出`)
      process.exit(0)
    })
  process.on("uncaughtException", err => {
    console.error(`[editor] 未捕获异常：${err?.stack ?? err}`)
    process.exit(1)
  })
  process.on("unhandledRejection", err => {
    console.error(`[editor] 未处理的 Promise 拒绝：${err?.stack ?? err}`)
  })
}

/**
 * 启动装配：路径 / 开关 / 落点 全部由 `editor/config.js` 算清（含 fail-closed 的拒绝启动）；
 * 这里只把结果摊平成下面的常量，其余代码不用改取值方式。
 *
 * 取值的优先级在 `injected.js` 里：**注入优先、argv / 环境变量兜底**。独立进程没注入，
 * 行为与以前逐字一致；宿主（bot）注入后，口令 / 表路径 / 挂载前缀就只有 `config.remote` 一份来源。
 */
const { cfg, internal, envOwners: ENV_OWNERS, envAdmins: ENV_ADMINS } = await createConfig({
  flag: injectedFlag,
  boolFlag: injectedBoolFlag,
})
const {
  pluginDir: PLUGIN_DIR,
  dataDir: DATA_DIR,
  testPaths: TEST_PATHS,
  xlsxPath,
  dataBase: DATA_BASE,
  template: TEMPLATE,
  token: TOKEN,
  allowNoToken: ALLOW_NO_TOKEN,
  signKey: SIGN_KEY,
  adminToken: ADMIN_TOKEN,
  /** 只有在「回环绑定 + ABYSS_EDITOR_TEST_PATHS=1」的本地兼容模式下才非空（见 config.js） */
  sharedSecrets: SHARED_SECRETS,
  ownerOnly: OWNER_ONLY,
  port: PORT,
  bind: BIND,
  mount: MOUNT,
  cloudUrl: CLOUD_URL,
  footerHtml: FOOTER_HTML,
  adminsFile: ADMINS_FILE,
  locksFile: LOCKS_FILE,
  rosterFile: ROSTER_FILE,
  claimsFile: CLAIMS_FILE,
  rosterQq: ROSTER_QQ,
  versionsDir: VERSIONS_DIR,
  versionsKeep: VERSIONS_KEEP,
  archivesDir: ARCHIVES_DIR,
  archiveDays: ARCHIVE_DAYS,
  archivesKeep: ARCHIVES_KEEP,
} = cfg

/** 插件侧的运行时配置（`anchor_aliases` 等，见 editor/config.js 的 `internal`） */
const { config } = internal

/* ------------------------- 编辑器自己的小工具 ------------------------- */
/**
 * 日期戳与 JSON 读写已抽到 `editor/util.js`（顶部 import）——
 * 版本归档、群名单、白名单三处都要用，放一处避免各写一份。
 */

const shared = rel => import(pathToFileURL(path.join(PLUGIN_DIR, rel)).href)

const {
  decodeIdentity,
  decodeLinkNick,
  signIdentity,
  verifyIdentity,
  verifyTicket,
  verifyFreshness,
  signWindow,
  verifyWindow,
  SHORT_PATH,
  TICKET_WINDOW_MS,
  IDENTITY_TTL,
} = await shared("model/identity.js")
const { openWorkbook } = await shared("model/xlsx.js")

/**
 * 挂载前缀：部署在 `https://域名/queue` 这类子路径时，nginx 可能把带前缀的路径原样转发过来
 * （`proxy_pass http://127.0.0.1:7788;` 不带尾部斜杠），也可能已经剥掉前缀。
 * 这里两种都接受：带前缀就把前缀去掉再路由，不带就直接用。
 */
const innerPath = pathname => {
  if (MOUNT && (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`))) {
    const rest = pathname.slice(MOUNT.length)
    return rest === "" ? "/" : rest
  }
  return pathname
}

/* 数据层与渲染从插件目录引入（见上面的 PLUGIN_DIR） */
const { Table } = await shared("model/table.js")
const { BindStore } = await shared("model/store.js")
const { matchOption, locateSelf } = await shared("modules/queue.js")
const { canonicalAnchor, compileAliases } = await shared("components/aliases.js")
const { pluginVersion } = await shared("components/pluginVersion.js")

/**
 * 表与绑定都由**编辑器自己**按 `--file` 建实例，不用插件的数据层单例
 *
 * 为什么不用插件的数据层单例：那个单例读的是插件配置，会出现"编辑器服务的文件"和
 * "它实际读写的文件"不是同一份，那正是最危险的一类污染。绑定文件跟着 DATA_BASE 走
 * （生产 = 插件内的 data/）。
 */
let TABLE = null
let STORE = null
const table = () => (TABLE ??= new Table({ file: xlsxPath }))
const store = () => (STORE ??= new BindStore(path.join(DATA_BASE, "abyss-editor-bindings.json")).load())

/* ------------------------- 装配：群名单 / 白名单 / 锁 ------------------------- */

/** 群名单：给页面的昵称候选、给短链补身份昵称；`nickOf` 会回退到本机绑定记录 */
const roster = createRoster({ rosterFile: ROSTER_FILE, store })
const { loadRoster, saveRoster, nickCandidates, nickOf } = roster

/** 群名单里这个群昵称对应谁（唯一命中才给建议；重名/查不到就空）——白名单审计要用 */
const rosterQqOfNick = nick => {
  const want = String(nick ?? "").trim().toLowerCase()
  if (!want) return ""
  const hits = (loadRoster().members ?? []).filter(m => String(m?.nick ?? "").trim().toLowerCase() === want)
  return hits.length === 1 ? String(hits[0].qq ?? "") : ""
}

/** 白名单与完成情况锁（名单解析 + 锁的存取） */
const acl = createAcl({
  adminsFile: ADMINS_FILE,
  locksFile: LOCKS_FILE,
  envAdmins: ENV_ADMINS,
  envOwners: ENV_OWNERS,
  rosterQqOfNick,
})
const { loadAdmins, loadOwners, aclAudit, saveAdmins, loadLocks, saveLocks, adminFileList } = acl

/** 历史版本与归档：写表前的存底（`replaceTable` 的 `beforeWrite` 就用它） */
const versions = createVersions({
  versionsDir: VERSIONS_DIR,
  archivesDir: ARCHIVES_DIR,
  xlsxPath,
  versionsKeep: VERSIONS_KEEP,
  archiveDays: ARCHIVE_DAYS,
  archivesKeep: ARCHIVES_KEEP,
})
const { listVersions, listArchives, snapshotBeforeWrite } = versions

/** 归属状态：绑定/锁与表的对账、审计、按 QQ 重建（实现见 editor/ownership.js） */
const ownership = createOwnership({ store, table, loadLocks, saveLocks, loadRoster, locateSelf })
const { ownershipIn, persistState, alignOwnership, ownershipAudit, rebuildOwnershipNow, mineRows } = ownership

/** 编辑器可写的字段（顺序与原表的 B–H 列一致：序号与其它列一律不动） */
const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  /** 主播与完成情况都可能是一格多个值（"阿修Axiu,听雨"），校验时按逗号拆开逐项比对 */
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]

/**
 * 挪行时要**跟着人一起走**的列（`#插队` 用）
 *
 * 就是 `FIELDS` 那七列（群昵称 → 帮帮完成情况）：这一整段换到别人那一行的位置上，人才算真的挪过去了。
 * **A 列序号不搬**：序号 = 位置（`=ROW()-k` 的缓存值 1..N），人挪到第几位就该显示第几位——
 * 跟着人搬过去会让"第 3 位"那一行写着 4，全列看着像乱码。
 * 表头识别出来的列字母由 `model.col` 给，这里只列 key（列不齐的表由 `model.col` 自己缺项）。
 */
const MOVE_COLUMN_KEYS = FIELDS.map(f => f.key)

/**
 * 表头上方「主播列表」的可写字段 —— 与 #主播 渲染出来的列一一对应
 *
 * 单元格位置按原表：A 主播名、C 核心强项、D 专职（C:F 合并区里的空格）、G/H 直播入口。
 *
 * **主播区（表头之上）与排队区（表头之下）是同一张表里的两个不同的区**，但行号是一根轴：
 * 新增主播要在最后一位主播下面占一行，插行点之下的公告行 / 表头行 / 整个排队区都得整体下移
 * （行号 +1，见 `model/xlsx.js` 的 `insertRowsAndShift`），绑定与锁里的行号同步跟搬
 * （`shiftRowsOf`）；漏搬就是"版本戳对得上、人却被认到别人的行上"。改既有行的 `rows` 路径不动行号。
 * 删主播仍然只能去表格里删行（编辑器只做"改既有行 + 新增"）。
 */
const ANCHOR_FIELDS = [
  { key: "name", label: "主播", col: "A", required: true },
  { key: "recommend", label: "推荐度", col: "" },
  { key: "duty", label: "专职", col: "D" },
  { key: "skills", label: "核心强项", col: "C" },
  { key: "platform", label: "直播入口", col: "G" },
  { key: "link", label: "直播入口（第二格）", col: "H" },
]

/* ------------------------- 白名单与完成情况锁 ------------------------- */

/**
 * 白名单 / 完成情况锁 / 群名单的**落点**在启动装配时算好（见上方解构）；
 * 三块实现分别在 `editor/acl.js` 与 `editor/roster.js`，本文件只做装配与鉴权：
 *   - `acl`：名单解析（只认 QQ，AQ-01）+ 完成情况锁（连昵称与表指纹一起记，AQ-03/08）
 *   - `roster`：群成员名单（昵称候选 + 按 QQ 取当前名片）
 * 装配点放在下方「表与绑定」之后——它们要等 `store()` 就绪。
 */

const blank = v => !String(v ?? "").trim()

/* ------------------------- 新行的默认值 ------------------------- */

const WAITING_STATUS = "等待开启"
const QUEUED_STATUS = "排队中"

/**
 * 各榜的开榜时间（新行的「帮帮完成情况」默认值按它算）
 *
 *   幻想真境剧诗：每月 1 号 4 点开，**不设「等待开启」**，默认就是「排队中」
 *   深境螺旋：每月 16 号 4 点开，到点前默认「等待开启」，到点后默认「排队中」
 *   幽境危战：按版本开放、没有固定日子，默认「等待开启」，要排队请手动改成「排队中」
 */
const OPEN_RULES = [
  { test: /剧诗/, day: 1 },
  { test: /螺旋/, day: 16 },
]

const defaultStatusOf = (sheetName, now = new Date()) => {
  const rule = OPEN_RULES.find(r => r.test.test(String(sheetName ?? "")))
  if (!rule) return WAITING_STATUS
  /** 1 号开的榜不用「等待开启」 */
  if (rule.day <= 1) return QUEUED_STATUS
  const openAt = new Date(now.getFullYear(), now.getMonth(), rule.day, 4, 0, 0, 0)
  return now.getTime() >= openAt.getTime() ? QUEUED_STATUS : WAITING_STATUS
}

/** 账号强度不填时的默认值；备注默认留空 */
const DEFAULT_STRENGTH = "中配"

/**
 * 「本人已完成」→ 这一行的群昵称
 *
 * 编辑器里点「本人已完成」会直接落成群昵称，但表格（腾讯文档那份）里能直接选到这个字面值，
 * 所以两头都换一遍：显示时换成昵称、保存时也换成昵称（真写回表里）。
 */
const statusWithSelfDone = (status, nickname) => {
  const parts = String(status ?? "")
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
  if (!parts.includes(SELF_DONE)) return parts.join(",")
  const nick = String(nickname ?? "").trim()
  if (!nick) return parts.join(",")
  return [...new Set(parts.map(p => (p === SELF_DONE ? nick : p)))].join(",")
}

/**
 * 「帮帮完成情况」的多值切分：逗号（中英文都认）分隔，两端去空白、丢掉空值
 *
 * 与 `statusWithSelfDone` 同一套写法：这一列是人工维护的多值，分隔符与空格都不统一。
 */
const statusTokens = status =>
  String(status ?? "")
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)

/**
 * 昵称改了：「帮帮完成情况」里哪些格要跟着换、换成什么
 *
 * 这一列存的是**人**（主播名，或点「本人已完成」落成的**该行群昵称**），逗号分隔多值。
 * 群昵称改了而这里没跟着改，表里就留下一个查无此人的名字；本人自己改、管理员改那一行、
 * 群名单同步改名三条路都要过这里。
 *
 * 口径（宁可不动，也不乱改）：
 *   1. **逐 token 精确比对**，不做子串替换：只有整段等于旧昵称的 token 才换，
 *      别人的名字（哪怕就是旧昵称加了个后缀）、其余 token 与顺序、重复次数都原样；
 *   2. 旧昵称是固定状态词（等待开启 / 排队中 / 本人已完成）**或**是这一榜的主播名 → 一个字不动：
 *      那两种 token 说的是"状态"或"哪位主播"，不是这一位群友；
 *   3. 这一榜里群昵称等于旧昵称的行**不止一行**（人工改表、重名就会出现）→ 分不清这一格写的是
 *      哪一位 → 整榜不动，把原因交给调用方去说明；
 *   4. 改的范围依据「这个名字在这一榜里唯一对应一个人」+「归属能落到一个 QQ 上」：
 *      - 归属确定（调用方给了 QQ，或绑定反查 `qqsOf` **唯一**命中且记的昵称就是旧昵称）
 *        → 这一榜**所有行**里等于旧昵称的 token 都换（本人那一格是「本人已完成」落的，
 *          别的行是"他帮这一行完成"）；
 *      - 归属确定不了 → 只动被改名的那一行自己那一格（那一格里的旧昵称逐字等于它自己的旧群昵称，
 *        确定就是「本人已完成」落的），别的行一律不动，并给出说明。
 *
 * @param {object} model 榜模型
 * @param {object} opts
 * @param {number} opts.row 被改名的行号
 * @param {string} opts.from 旧群昵称
 * @param {string} opts.to 新群昵称
 * @param {string} [opts.qq] 这个人的 QQ（调用方已知时给出：本人保存自己改、群名单同步）
 * @param {object} [opts.binds] 绑定视图（`bindView` 那种 `{get, qqsOf}`）
 * @param {(row: object) => string} [opts.statusOf] 取某一行**当前**的完成情况：
 *        同一次写入里改了多行时，后面几条要看得到前面几条的结果
 * @returns {{changes: Array<{row:number, status:string}>, skipped: string}} skipped = 没改的原因（空串 = 没跳过）
 */
const statusRenamePlan = (model, { row, from, to, qq = "", binds = null, statusOf = null } = {}) => {
  /** 固定状态词不是人：改名一律不碰它们（三个字面值与这一列的下拉口径同一份） */
  const statusWords = [WAITING_STATUS, QUEUED_STATUS, SELF_DONE]
  const oldNick = String(from ?? "").trim()
  const newNick = String(to ?? "").trim()
  const at = Number(row) || 0
  const none = { changes: [], skipped: "" }
  if (!model || !at || !oldNick || !newNick || oldNick === newNick) return none
  if (statusWords.includes(oldNick)) return { changes: [], skipped: `「${oldNick}」是状态词、不是人，完成情况没动` }
  if ((model.anchors ?? []).some(a => String(a?.name ?? "").trim() === oldNick))
    return { changes: [], skipped: `「${oldNick}」是这一榜的主播名，完成情况没动` }

  const statusAt = r => String((statusOf ? statusOf(r) : r.status) ?? "")
  const same = (model.rows ?? []).filter(r => String(r.nickname ?? "").trim() === oldNick)
  if (same.length !== 1 || Number(same[0].row) !== at)
    return { changes: [], skipped: `这一榜里有 ${same.length} 行叫「${oldNick}」，分不清完成情况里写的是哪一位，没动` }

  const ids = typeof binds?.qqsOf === "function" ? binds.qqsOf(model.name, at) : []
  const valid = ids.filter(id => String(binds?.get?.(model.name, id)?.nickname ?? "").trim() === oldNick)
  const owner = String(qq ?? "").trim() || (valid.length === 1 ? String(valid[0]) : "")
  const rows = owner ? model.rows ?? [] : same

  const changes = []
  for (const r of rows) {
    const parts = statusTokens(statusAt(r))
    if (!parts.includes(oldNick)) continue
    changes.push({ row: r.row, status: parts.map(p => (p === oldNick ? newNick : p)).join(",") })
  }
  /** 归属不确定：说清楚"只动了本人那一格、别的行为什么没动"（别的行里确实还有这个名字时才提） */
  const others = owner
    ? []
    : (model.rows ?? []).filter(r => Number(r.row) !== at && statusTokens(statusAt(r)).includes(oldNick))
  return {
    changes,
    skipped: others.length
      ? `第 ${at} 行没有可依据的 QQ 绑定，只能确认它本人那一格；另外 ${others.length} 行里同样写着「${oldNick}」的没动`
      : "",
  }
}

/**
 * 汇总为前端可用的结构
 *
 * 按调用者身份裁剪：
 *   admin —— 全部行，可改所有人（另有白名单可维护）
 *   self  —— 只给**按 QQ 定位到的**自己那些行（昵称兜底），且只能改这些行
 *   guest —— 全部行只读（链接被转发、或直接打开域名）
 */
const buildPayload = async caller => {
  const locks = loadLocks().rows
  const mine = caller.role === "self" ? await mineRows(caller) : null
  const data = await table().read(({ models }) => {
    const sheets = []
    for (const model of models.values()) {
      const rows = model.rows
        .filter(r => caller.role !== "self" || mine.get(model.name)?.has(r.row))
        .map(r => {
          /** seq 是表里 A 列那个序号（公式算出来的 1..N），界面第一列要显示它，不能拿表格行号冒充 */
          const o = { row: r.row, seq: r.seq ?? "" }
          for (const f of FIELDS) o[f.key] = r[f.key] ?? ""
          /** 表里还挂着字面「本人已完成」时：界面上直接显示成这一行的群昵称 */
          o.status = statusWithSelfDone(o.status, o.nickname)
          o.statusLocked = caller.role !== "admin" && Boolean(locks[lockKey(model.name, r.row)])
          return o
        })
      const anchors = model.anchors.map(a => a.name).filter(Boolean)
      sheets.push({
        name: model.name,
        title: model.title,
        dataStart: model.dataStart,
        dataEnd: model.dataEnd,
        /**
         * 「选择主播」的下拉**以主播列表为准**（表格里的下拉验证常常跟不上主播区的改动）：
         * 选项就是表头上方那几位主播，顺序也按表内顺序；表里已有的旧值由前端按行补上，不会丢。
         */
        options: effectiveOptions(model),
        anchors,
        rows,
        /**
         * 别人占了哪些行号（只发给本人）
         *
         * 本人只拿得到自己那几行，前端「新增一行」如果只按拿到的行号找空位，
         * 会挑中别人正占着的行，保存时被拒（第 N 行不是你的记录）。
         */
        taken: caller.role === "self" ? model.rows.map(r => r.row) : undefined,
        /** 新行的默认值：完成情况按这个榜的开榜时间算（账号强度「中配」由服务端在保存时补） */
        defaults: { status: defaultStatusOf(model.name) },
        /** 表头上方的主播列表：只有管理员能改，所以只给管理员发 */
        anchorRows:
          caller.role === "admin"
            ? model.anchors.map(a => ({
                row: a.row,
                name: a.name,
                recommend: a.recommend,
                duty: a.duty,
                skills: a.skills,
                platform: a.cells?.platform ?? "",
                link: a.cells?.link ?? "",
                entry: a.entry,
              }))
            : undefined,
      })
    }
    return { sheets }
  })
  return {
    file: xlsxPath,
    fields: FIELDS,
    /**
     * 这一版表的编号（文件指纹）
     *
     * 页面拿它做乐观并发：保存时原样带回来，服务端发现表已经变了就报冲突，
     * 而不是把别人刚提交的改动无声盖掉（AQ-06）。
     */
    version: table().version,
    /** 群昵称候选（机器人推来的群成员名单）：本地编辑器收不到名单，这里是空的 */
    roster: (() => {
      const r = loadRoster()
      return { group: r.group, updatedAt: r.updatedAt, count: (r.members ?? []).length, candidates: nickCandidates() }
    })(),
    sheets: data.sheets,
    savedAt: fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath).mtime.toLocaleString("zh-CN") : "",
    perm: {
      role: caller.role,
      readonly: caller.role === "guest",
      nick: caller.identity?.nick ?? "",
      /**
       * 这次是**别人唤起的链接**（链接已经被别的设备认领 → 降级成只读）
       *
       * 页面按它说清"为什么你只能看"：与"压根没带身份"（转发出去、直接敲域名）是两回事，
       * 前者要给的话是"回群里发 #排队 取你自己那条链接"。
       */
      forwarded: Boolean(caller.downgraded),
      /** 主人比管理员多一个「权限管理」面板；管理口令（?a=）是它的备用入口 */
      owner: caller.owner,
      showAdmins: caller.owner || caller.adminTokenOk,
      /**
       * 历史版本 / 归档 / 回退：**主人、管理口令、以及白名单管理员**都能用
       *
       * 维护者要求（报告：历史版本可供白名单成员使用）：回退前会自动把"当前状态"也存一份，
       * 点错了再退回来就是，所以它是**可逆的管理动作**，与「插队」同一档权力；
       * 而「上传覆盖云端」与「归属状态」是跨部署 / 重建归属的重动作，仍然只给主人（见 `manage`）。
       */
      versions: caller.owner || caller.adminTokenOk || caller.role === "admin",
      /** 主人（或管理口令）：上传覆盖云端、归属状态、白名单维护 —— 这些都是主人专属 */
      manage: caller.owner || caller.adminTokenOk,
      versionsKeep: VERSIONS_KEEP,
      archiveDays: ARCHIVE_DAYS,
      cloud: CLOUD_URL,
      /**
       * 白名单里当不了权限的历史条目（群昵称等）：只发给能管白名单的人
       *
       * 权限只认 QQ，所以白名单里那些解析不出 QQ 的条目必须**当场说清楚**，
       * 否则主人会以为"我配了那个人"或者"我配的是 QQ 怎么就不好使"（AQ-01）。
       */
      acl: caller.owner || caller.adminTokenOk ? aclAudit() : undefined,
    },
  }
}

/** 群昵称比对：忽略首尾空白与大小写（英文昵称常见） */
const sameNick = (a, b) => {
  const x = String(a ?? "").trim()
  const y = String(b ?? "").trim()
  return Boolean(x) && Boolean(y) && x.toLowerCase() === y.toLowerCase()
}

/* ------------------------- 归属状态：绑定 / 完成情况锁 ------------------------- */

/**
 * 归属这一整块的实现都在 `editor/ownership.js`（绑定/锁与表的对账、审计、按 QQ 重建），
 * 装配点在上方「装配：归属」。本文件只留两处**必须与表写在同一个临界区**的编排：
 * `syncIdentity`（改名片要写表）与 `replaceTable`（整表替换后重建归属）。
 */


/**
 * 按 QQ 定位账号（与机器人同一套口径，见 modules/queue.js 的 locateSelf）：
 *   - 本人改了群名片 → 把表里的群昵称同步成新名片（只动昵称，游戏名不动）
 *   - **身份昵称为空 → 不同步**（没有新名片可比，空串不许回写昵称格，见下方 renamedRows 那段注释）
 *   - 首次按昵称认出来 → 记下 QQ 绑定，以后按 QQ 认人
 *   - 绑定失效（那一行没了，或已经是别人的了）→ 删掉
 *
 * 读表、写表、改绑定都在**同一个临界区**里：算出来的行号必须属于正在写的这一版表——
 * 队列外先读、再进队列写，中间隔着别的写入口（上传 / 回退 / 名单整理），行号就可能已经失效（AQ-03、AQ-06）。
 * @returns {Promise<{renamed:number, bound:number, dropped:number}>}
 */
const syncIdentity = async caller => {
  const result = { renamed: 0, bound: 0, dropped: 0 }
  if (caller.role !== "self" || !caller.identity?.qq) return result
  const bindStore = await store()
  const qq = caller.identity.qq
  const nick = caller.identity.nick
  let plan = null
  let renamedRows = []

  await table().mutate(
    async ctx => {
      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      const lockRows = state.locks
      const realigned = state.realigned
      const view = bindView(binds)
      const actions = [...ctx.models.values()].map(model => ({
        model,
        hit: locateSelf(model, view, model.name, qq, nick),
      }))

      /**
       * 改了群名片：把表里那一行的群昵称同步过来
       *
       * **只认非空的新名片**：身份里没有群名片时（短链展开时云端群名单里没这个人，
       * 见 `editor/roster.js` 的 `nickOf`）`hit.nick` 是空串，照它写回就等于把这一格填好的
       * 昵称清成空、界面上只剩 placeholder（`locateSelf` 已经不再把这种情形报成 `renamedFrom`，
       * 这里再挡一道：**空串任何时候都不许回写昵称格**）。其余对账（退群删行、stale/conflict）不受影响。
       */
      renamedRows = actions.filter(a => a.hit.renamedFrom !== undefined && a.hit.row && !blank(a.hit.nick))
      /**
       * 改名要顺带把「帮帮完成情况」里记着他旧昵称的 token 换成新昵称
       *
       * 先算后写：`statusRenamePlan` 的"这一榜里只有一行叫旧昵称"要读**改之前**的表，
       * 先 `setCell` 了昵称，这一行就不再叫旧昵称了（口径见 `statusRenamePlan`）。
       */
      for (const { model, hit } of renamedRows) {
        const plan = statusRenamePlan(ctx.model(model.name), { row: hit.row, from: hit.renamedFrom, to: hit.nick, qq, binds: view })
        for (const c of plan.changes) if (ctx.model(model.name)?.col?.status) ctx.setCell(model.name, c.row, "status", c.status)
        if (plan.skipped) console.log(`[editor] QQ ${qq} 改名：${plan.skipped}`)
        if (ctx.model(model.name)?.col?.nickname) ctx.setCell(model.name, hit.row, "nickname", hit.nick)
      }

      let dirty = false
      for (const { model, hit } of actions) {
        if (hit.stale) {
          if (bindDel(binds, model.name, qq)) {
            dirty = true
            result.dropped++
          }
          continue
        }
        /** 改了名片的那些行，绑定里记的昵称也刷新成新名片 */
        if (hit.renamedFrom !== undefined && hit.row) {
          bindSet(binds, model.name, qq, { row: hit.row, nickname: hit.nick })
          renameLock(lockRows, model.name, hit.row, hit.nick)
          dirty = true
          result.bound++
          continue
        }
        if (hit.bind) {
          bindSet(binds, model.name, qq, { row: hit.bind.row, nickname: hit.bind.nickname })
          dirty = true
          result.bound++
        }
      }
      if (renamedRows.length) await snapshotBeforeWrite()
      if (dirty || renamedRows.length || realigned) plan = { binds, locks: lockRows }
      return { renamed: renamedRows.length }
    },
    { afterCommit: info => persistState(info, plan) },
  )

  if (renamedRows.length) {
    result.renamed = renamedRows.length
    console.log(
      `[editor] QQ ${qq} 改了群名片，已同步表里的群昵称：` +
        renamedRows.map(({ model, hit }) => `${model.name} 第 ${hit.row} 行「${hit.renamedFrom}」→「${hit.nick}」`).join("；"),
    )
  }
  return result
}

/**
 * 下拉选项（前端展示与后端校验共用一份，避免"界面能选、保存却说不在选项里"）
 *
 * 「选择主播」**以表头上方的主播列表为准**（表里的下拉验证常跟不上主播区的增删改）：
 *   1. 主播列表里的每一位，按表内顺序排在前面 —— 这是权威名单
 *   2. 表里已经在用、但不在主播列表里的值（例如「都可以」）追加在后面，免得老数据没法选
 *   3. 认得出是哪位主播的别名（如「璃月第一深情」→ 摸头妹）不算独立选项，直接归到正名
 *   4. 主播列表为空、表里也没有可用的旧值时，整份退回表里的下拉验证原样
 */
const effectiveOptions = model => {
  const known = compileAliases(config.anchor_aliases)
  /** 主播名去重：表头里万一有重名，下拉里也只该出现一个 */
  const anchors = [...new Set(model.anchors.map(a => a.name).map(s => s.trim()).filter(Boolean))]
  const used = []
  for (const r of model.rows) {
    for (const part of String(r.anchor ?? "")
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean)) {
      /** 别名：能归到本榜某位主播就当作那位在用，不单独进列表 */
      const canonical = canonicalAnchor(part, known)
      if (canonical !== part && anchors.includes(canonical)) continue
      if (!anchors.includes(part) && !used.includes(part)) used.push(part)
    }
  }
  const fallback = [...new Set(model.options?.anchor ?? [])]
  const list = [...new Set([...anchors, ...used])]
  const anchor = list.length ? list : fallback
  /**
   * 完成情况也下发"净化后的名单"（与写回表时同一份）
   *
   * 这一列的候选口径与写回口径必须一致：直接下发 xlsx 里那份下拉验证原样，
   * 而归档只增不减 ⇒ 早年用过、现在没人用的名字会永久留在页面的下拉里，
   * 看着像"这一榜真有人填过"（例如幽境危战的完成情况里冒出一个该榜没有任何一行填过的名字）。
   * 净化口径见 `mergeStatusOptions`：状态词 ∪ 主播名单 ∪ 表里在用的值。
   */
  const status = model.col?.status ? mergeStatusOptions(model, anchors) : model.options?.status
  return { ...(model.options ?? {}), anchor, ...(status ? { status } : {}) }
}

/**
 * 完成情况里的「未开始 / 进行中」：它们与「某完成人」（主播名 / 本人已完成）互斥
 * 前端点选时会互相挤掉，这里是服务端的兜底校验
 */
const PENDING_STATUS = ["等待开启", "排队中"]

/** 一键"我完成了"：落成这一行的群昵称，表里看到的就是完成人 */
const SELF_DONE = "本人已完成"

/** 只能单独选的值：选了它就不能再和别的并存（如「都可以」）；前端点选时也会清，这里是兜底 */
const EXCLUSIVE_VALUES = ["都可以"]

/**
 * 「帮帮完成情况」的**手动收录名单**（临时成员：既不在主播区、也不是这一行的本人）
 *
 * 为什么不能只写进表里那份下拉验证：`mergeStatusOptions` 的净化口径只认
 * 「状态词 ∪ 主播区 ∪ 表里在用的值」，写进验证列表但没人用的名字会在下次净化时被清掉
 * （就是"小伙01 残留"被清的那套机制）。所以手动收录的名单单独存一份，**永远算数**。
 * 文件与绑定/锁一样放在插件数据目录里（数据不出插件，见硬约定 11）。
 */
const EXTRA_NAMES_FILE = path.join(DATA_BASE, "abyss-editor-status-names.json")

/** 收录名单常驻内存：候选计算（`mergeStatusOptions`）是同步路径，不能在里面读文件 */
let EXTRA_NAMES = {}
let extraNamesLoaded = false

/** 首个请求时读一次（之后只走内存 + 写回） */
const ensureExtraNames = async () => {
  if (extraNamesLoaded) return
  extraNamesLoaded = true
  try {
    const raw = JSON.parse(await fsp.readFile(EXTRA_NAMES_FILE, "utf8"))
    EXTRA_NAMES = raw && typeof raw === "object" ? raw : {}
  } catch {
    /** 没文件 / 坏了都当"还没收录过"：不能因为这个把编辑器拦住 */
    EXTRA_NAMES = {}
  }
}

const extraNamesOf = sheet => {
  const list = EXTRA_NAMES[sheet]
  return Array.isArray(list) ? list.map(s => String(s).trim()).filter(Boolean) : []
}

/** 收录一个名字（幂等：已存在就原样返回）。名字里不能有逗号——这一列是多值、逗号是分隔符 */
const addExtraName = async (sheet, name) => {
  const clean = String(name ?? "").trim()
  if (!clean) throw new Error("名字不能为空")
  if (clean.length > 30) throw new Error("名字太长了（最多 30 个字）")
  if (/[,，]/.test(clean)) throw new Error("名字里不能有逗号")
  const all = { ...EXTRA_NAMES }
  const list = extraNamesOf(sheet)
  if (!list.includes(clean)) list.push(clean)
  all[sheet] = list
  await fsp.writeFile(EXTRA_NAMES_FILE, JSON.stringify(all, null, 2) + "\n")
  EXTRA_NAMES = all
  return list
}

/**
 * 「帮帮完成情况」的下拉：固定状态（排队中 / 等待开启 / 本人已完成）+ 主播名 + 手动收录
 *
 * 这一列同样是多选（可以同时写多位主播），所以名单也要跟着主播区走。
 *
 * **这一列里"在用的名字"不再当候选**（维护者报告：下拉里混进别人的群昵称甚至广告名）。
 * 为什么不再兜底：点「本人已完成」落进这一列的是**群昵称**，于是每个点过的人的名字都会变成
 * 全体候选；群昵称还会因为改名 / 退群 / 广告名片一路残留，越积越多（`archiveOptions` 又是只增不减）。
 * 现在只认三种来源：状态词、主播区、手动「＋ 收录新名字」（临时成员就从这里收）。
 * 两条安全绳：① **当前值永远在候选里**（页面把这一格的现值并进候选，见 editor.html 的
 * `picker` 组装）——不然用户看不到、也取消不了自己那一格；② 校验放行"这一格里本来就有的值"
 * （见 `validateRows`），所以老数据照旧能改能存，只是不再往下扩散，
 * 而且保存/归档时这份净化后的名单会写回表里（自愈）。
 */
const mergeStatusOptions = (model, anchors) => {
  const current = [...new Set(model.options?.status ?? [])]
  /**
   * 只留**状态词**（等待开启 / 排队中 / 本人已完成）：表里下拉验证里的其它历史值一律不作候选
   *
   * 归档（`archiveOptions`）只增不减：表里当年用过的名字会被写进 xlsx 的下拉验证列表，
   * 之后再没人用时**永远留在那里**；保存/归档时会把这份净化后的名单写回表里，那批残留会顺手清掉（自愈）。
   */
  const fixed = current.filter(v => PENDING_STATUS.includes(v) || v === SELF_DONE)
  return [...new Set([...fixed, ...anchors, ...extraNamesOf(model.name)])]
}

/** 业务校验：必填、同榜不重名、下拉值必须命中 */
const validateRows = (model, rows) => {
  const problems = []
  const seen = new Map()
  const options = effectiveOptions(model)
  /** 表里出现过的群昵称：点「本人已完成」会把它写进完成情况，所以这种值要认 */
  const nicknames = new Set(model.rows.map(r => String(r.nickname ?? "").trim()).filter(Boolean))
  const touched = new Set(rows.map(r => Number(r?.row)).filter(Boolean))
  for (const r of model.rows) {
    if (touched.has(r.row)) continue
    if (!blank(r.nickname)) seen.set(String(r.nickname).trim(), r.row)
  }

  for (const r of rows) {
    const v = r?.values ?? {}
    const who = blank(v.nickname) ? `第 ${r.row} 行` : `「${String(v.nickname).trim()}」`
    /* 整行清空 = 删除，允许 */
    if (FIELDS.every(f => blank(v[f.key]))) continue
    /** 表里已有的那一行：值没动就不校验（表里的旧值可能已经不在主播列表里了，不该逼着人改） */
    const before = model.rows.find(x => x.row === Number(r.row))

    for (const f of FIELDS.filter(x => x.required))
      if (blank(v[f.key])) problems.push(`${who}：${f.label}不能为空`)

    const nick = String(v.nickname ?? "").trim()
    if (nick) {
      if (seen.has(nick)) problems.push(`${who}：昵称与表格第 ${seen.get(nick)} 行重复`)
      seen.set(nick, r.row)
    }

    for (const f of FIELDS.filter(x => x.option)) {
      const val = String(v[f.key] ?? "").trim()
      if (!val) continue
      if (before && String(before[f.key] ?? "").trim() === val) continue
      const opts = options[f.option] ?? []
      if (!opts.length) continue
      /** 完成情况允许多个值（"阿修Axiu,听雨"），逐个比对 */
      const parts = f.multi ? val.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [val]
      for (const part of parts) {
        if (opts.includes(part) || matchOption(part, opts)) continue
        /** 认得出的别名（如「阿修」→ 阿修Axiu）也算命中 */
        if (f.key === "anchor" && opts.includes(canonicalAnchor(part, compileAliases(config.anchor_aliases)))) continue
        /** 完成人可以直接是某位群友的群昵称（点「本人已完成」就是这么落表的） */
        if (f.key === "status" && (nicknames.has(part) || sameNick(part, before?.nickname))) continue
        /**
         * 这一格里**本来就有的值**一律放行：完成情况的候选只认「状态词 ∪ 主播区 ∪ 手动收录」
         * （见 `mergeStatusOptions`），而老数据里存着当年点「本人已完成」落下的群昵称——
         * 它们不该因为"不在候选里"而卡住这一行的其它字段（改个备注就被整行拒掉）。
         * 页面把这一格的现值并进候选，所以用户点得到；服务端在这里只做"值没变就照旧"的兜底。
         */
        if (f.key === "status" && statusTokens(before?.status).includes(part)) continue
        problems.push(`${who}：${f.label}「${part}」不在下拉选项里`)
      }
      /** 独占值（如「都可以」）不能和别的并选 */
      if (parts.length > 1) {
        const exclusive = parts.filter(p => EXCLUSIVE_VALUES.includes(p))
        if (exclusive.length)
          problems.push(`${who}：${f.label}「${exclusive[0]}」不能和别的选项一起选（它是独占的，single choice）`)
      }
      /** 完成情况：「等待开启 / 排队中」与「某完成人」互斥；这两个状态之间也只能留一个 */
      if (f.key === "status" && parts.length > 1) {
        const pending = parts.filter(p => PENDING_STATUS.includes(p))
        const done = parts.filter(p => !PENDING_STATUS.includes(p) && !EXCLUSIVE_VALUES.includes(p))
        if (pending.length && done.length)
          problems.push(`${who}：${f.label}「${pending[0]}」不能和完成人一起选（两者互斥）`)
        else if (pending.length > 1) problems.push(`${who}：${f.label}「${PENDING_STATUS.join("」「")}」只能选一个`)
      }
    }
  }
  return problems
}

/**
 * 成员行的**业务上界**：允许在数据区末尾之后追加几行，但绝不允许"想写哪行就写哪行"
 *
 * 为什么需要它：表头上方是主播区、再往上是公告/标题，它们**不在** `model.rows` 里。
 * 于是"`model.rows` 里没有这个行号"既可能是"要新增一行"，也可能是"要改主播格 / 改表头"——
 * 两者混在一起，等于把受保护的区域交给任何一个有签名身份的人。合法追加与越界的区别只在行号，
 * 所以这里给追加划一条固定上限（页面就是在数据区末尾往下顺延找空行，见 editor.html 的 pickRowNumber）。
 */
const APPEND_ROWS_MAX = 500

/**
 * 把请求里的 `row` 收成干净的整数行号（**必须在任何角色分支之前**调用）
 *
 * 单独拎出来是为了让"格式不对"和"越界"两种拒绝都说清楚：下面 `assertMemberRows` 拿到的是
 * 已经确认是安全整数的行号，它只需要比区间。
 * @returns {number[]} 与入参一一对应的行号
 */
const rowNumbersOf = rows =>
  rows.map((r, i) => {
    const raw = r?.row
    /** 不用 `Number(raw) || 0`：那会把 `null` / 空串 / `"abc"` 全变成 0，坏输入被静默吞掉 */
    const row = typeof raw === "number" ? raw : Number(String(raw ?? "").trim())
    if (!Number.isSafeInteger(row)) throw new Error(`第 ${i + 1} 项的行号不是整数：${JSON.stringify(raw ?? null)}`)
    return row
  })

/**
 * 成员保存的**业务行范围检查**
 *
 * 允许两种行号：
 *   - 数据区内：`dataStart`（表头下一行）到 `dataEnd`（表里最后一个有数据的行）；
 *   - 合法追加：`dataEnd` 之后 `APPEND_ROWS_MAX` 行以内（页面就是在末尾顺延找空行的）。
 * 表头行、主播区行、以及更远的行号一律拒绝。
 *
 * **越界要在建对象、算权限、开写表队列之前就拒掉**：这样工作簿、绑定、锁与版本都不会被碰，
 * 也不会因为"先算了一遍归属"而留下痕迹。
 * @param {object} model 这一版表的模型（`ctx.model(sheet)`）
 * @param {number[]} rowNums `rowNumbersOf` 的结果
 */
const assertMemberRows = (model, rowNums) => {
  if (!rowNums.length) return
  const { dataStart, dataEnd, headerRow } = model
  /** 数据区上沿：表头以下才是成员数据。`dataEnd` 可能小于 `dataStart`（表里一行都没有） */
  const min = Math.min(dataStart, dataEnd + 1)
  /** 业务上界：数据区末尾之后留一段追加余量，再往后就不是"给成员加行"了 */
  const max = Math.max(dataEnd, min - 1) + APPEND_ROWS_MAX
  for (const row of rowNums) {
    if (row < min || row > max)
      throw new Error(
        `第 ${row} 行不是成员数据行：表头在第 ${headerRow} 行、成员数据从第 ${min} 行起（空行可以直接在末尾追加新行，` +
          `但最多到第 ${max} 行）。表头上方的主播区与表头都只能用对应的接口改`,
      )
  }
}

/**
 * 保存：校验 → 逐格写；整行空 = 清空该行（序号公式列不动）
 *
 * 权限在服务端落实，不依赖前端：
 *   self 只能碰「本来就是自己那一行」或「新增的、昵称是自己的」行
 *   self 改不动已被主播锁定的完成情况（其余字段照常保存，被忽略的那格回报给前端）
 *
 * **读表、校验、写表、改绑定与锁全在 table() 的同一个临界区里**：
 * 队列外先读一次算清楚、再进队列写，中间别的写入口（上传/回退/名单整理）
 * 可能已经把表换掉了，于是写回去的是过期快照，改动凭空消失（AQ-06）。
 * 请求可以带 `version`（页面加载时拿到的表版本）：对不上就报冲突，不覆盖别人的改动。
 */
const applySave = async (caller, { sheet, rows, version }) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 500) throw new Error("一次提交的行数过多（>500）")
  /**
   * 行号格式先收干净：这一步**不依赖任何权限**，坏输入在进临界区之前就该被拒。
   *
   * 放在角色分支**之前**是有意的：`rowNumbersOf` 只管"是不是安全整数"，与"你是谁"无关；
   * 先判角色会让 `0 / -1 / "abc"` 这类坏行号在某些角色下走出不同的分支——`Number(x) || 0`
   * 会把它们静默吞成"第 0 行"，那样权限逻辑就得各自再防一遍。
   */
  const rowNums = rowNumbersOf(rows)
  if (caller.role === "guest") throw new Error("这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）")

  const bindStore = await store()
  const qq = caller.identity?.qq
  const nick = caller.identity?.nick
  let plan = null

  const result = await table().mutate(
    async ctx => {
      /** 表里没有这个榜就在这里抛错——和写入读的是同一版表 */
      const model = ctx.model(sheet)
      /** 行号是不是成员数据区 / 合法追加：**排在归属与角色判断之前**（读的是同一版表） */
      assertMemberRows(model, rowNums)
      /** 版本对不上（整表替换过 / 外部改过表）：先按群昵称重新对账，再谈权限 */
      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      let lockRows = state.locks
      const realigned = state.realigned

      const normalized = rowNums.map((row, i) => {
        const r = rows[i]
        const src = r?.values ?? {}
        const before = model.rows.find(x => x.row === row)
        const values = {}
        for (const f of FIELDS) {
          /** 前端漏传的字段按表里现有值处理：宁可不动，也不能当空串把内容清掉 */
          values[f.key] = src[f.key] !== undefined ? String(src[f.key]).trim() : String(before?.[f.key] ?? "").trim()
        }
        return { row, values }
      })

      const ignored = []
      /** 给前端看的"顺带做了什么"提示（与 ignored 区分：那是被拒的字段） */
      const notices = []

      /**
       * 没填的字段按默认值落表
       *
       *   账号强度 → 「中配」；帮帮完成情况 → 按各榜开榜时间（剧诗排队中 / 深渊看日子 / 危战等待开启）
       * 只对"有内容的行"生效：整行留空是删除，不能被默认值救回来。
       */
      const defaults = { strength: DEFAULT_STRENGTH, status: defaultStatusOf(sheet) }
      for (const r of normalized) {
        if (FIELDS.every(f => blank(r.values[f.key]))) continue
        if (!r.values.strength) r.values.strength = defaults.strength
        if (!r.values.status) r.values.status = defaults.status
      }

      /**
       * 「本人已完成」落成这一行的群昵称
       *
       * 这次点的、以及表里早先留下的字面值，都一起换掉——否则界面上一直挂着「本人已完成」。
       * 换完的值和原值一样就什么都不做。
       */
      for (const r of normalized) {
        const before = model.rows.find(x => x.row === r.row)
        const next = statusWithSelfDone(r.values.status, r.values.nickname || before?.nickname)
        if (next === r.values.status) continue
        r.values.status = next
        notices.push({ row: r.row, text: `第 ${r.row} 行的「${SELF_DONE}」已按群昵称写成「${next}」` })
      }
      /** 属于自己的行：以 QQ 绑定为准（昵称兜底），与机器人 #排队 同一套口径 */
      const mine = new Set(
        caller.role === "self" ? [locateSelf(model, bindView(binds), sheet, qq, nick).row].filter(Boolean) : [],
      )

      if (caller.role === "self") {
        for (const r of normalized) {
          const isMine = mine.has(r.row)
          const isNew = !model.rows.some(x => x.row === r.row)
          /**
           * 放行两类：**自己名下的行**，以及**表里还没有的空行**。
           *
           * 新行**不按昵称判归属**：身份里没有群名片时（云端没收到群名单，短链展开出来的身份 `n` 是空的），
           * 按昵称比会把新行判成"不是自己的"，于是**永远建不了行**。空行本来就没有主人，
           * 谁在页面里建都行，这不影响 AQ-02 要防的"同名抢已有行"。
           */
          if (isMine || isNew) continue
          throw new Error(`第 ${r.row} 行不是你的记录，只能改自己那一行`)
        }
        /** 主播改过的完成情况：本人不能再改，这一格忽略掉，其余照写 */
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const locked = lockRows[lockKey(sheet, r.row)]
          if (!before || !locked) continue
          if (r.values.status !== String(before.status ?? "").trim()) {
            r.values.status = String(before.status ?? "").trim()
            ignored.push({ row: r.row, label: "帮帮完成情况", reason: "已由主播填写" })
          }
        }
      }

      const problems = validateRows(model, normalized)
      if (problems.length) throw new Error(`校验未通过：\n${problems.slice(0, 6).join("\n")}`)

      /**
       * 昵称改了：「帮帮完成情况」里记着他旧昵称的 token 跟着换（口径见 `statusRenamePlan`）
       *
       * 放在「主播锁回退」与**校验之后**：提交上来的还是改名前的值（那一格写的就是旧昵称），
       * 先让校验按改之前的表判——换完的新昵称这一版表里还没有，拿去校验会被判成"不在下拉选项里"。
       *
       * 管理员改的是**别人**那一行，`caller.identity.qq` 是管理员自己的，不能当成这一行的主人；
       * 只有本人保存自己那一行时才把 QQ 交出去，其余一律按绑定反查（"宁可不动"）。
       */
      const statusWrites = new Map()
      const renames = normalized
        .map(r => ({ r, before: model.rows.find(x => x.row === r.row) }))
        .filter(
          ({ r, before }) =>
            before && r.row && !blank(r.values.nickname) && String(before.nickname ?? "").trim() !== r.values.nickname,
        )
      if (renames.length) {
        /** 这一轮每一行最终会写成什么完成情况：改名逐条叠加，后面的看得到前面几条的结果 */
        const working = new Map()
        const statusOf = row => {
          if (!working.has(row.row)) {
            const item = normalized.find(x => x.row === row.row)
            working.set(row.row, item ? item.values.status : String(row.status ?? "").trim())
          }
          return working.get(row.row)
        }
        for (const { r, before } of renames) {
          const plan = statusRenamePlan(model, {
            row: r.row,
            from: before.nickname,
            to: r.values.nickname,
            qq: caller.role === "self" ? qq : "",
            binds: bindView(binds),
            statusOf,
          })
          if (plan.skipped) notices.push({ row: r.row, text: plan.skipped })
          if (plan.changes.length)
            notices.push({
              row: r.row,
              text: `第 ${r.row} 行改名为「${r.values.nickname}」：帮帮完成情况里 ${plan.changes.length} 处跟着改了`,
            })
          for (const c of plan.changes) {
            working.set(c.row, c.status)
            const item = normalized.find(x => x.row === c.row)
            /** 这一轮提交里的行直接改提交值（写表循环会写它）；其余的行单独补写 */
            if (item) item.values.status = c.status
            else statusWrites.set(c.row, c.status)
          }
        }
      }

      /** 管理员这一轮改动了哪些行的完成情况 → 这些行对本人上锁 */
      if (caller.role === "admin") {
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const after = r.values.status
          if (!before) continue
          if (after === String(before.status ?? "").trim()) continue
          const key = lockKey(sheet, r.row)
          if (blank(after)) delete lockRows[key]
          /** 锁上记下"锁的是谁"：整表替换 / 压紧行之后要靠它校验归属（AQ-03、AQ-08） */
          else lockRows[key] = { by: nick || "管理员", at: Date.now(), nickname: String(r.values.nickname ?? before.nickname ?? "").trim() }
        }
      }
      /** 行被清空 = 这个人退队了，锁一并清掉 */
      for (const r of normalized)
        if (FIELDS.every(f => blank(r.values[f.key]))) delete lockRows[lockKey(sheet, r.row)]

      /** 写表前留底：历史版本 + 每日/换月归档 */
      await snapshotBeforeWrite()
      const m = ctx.model(sheet)
      /** 写之前先记下"这一轮新建出来的行"，写完再算就分不清新建和本来就有的行了 */
      const newRows = new Set(
        normalized.filter(r => r.row && !m.rows.some(x => x.row === r.row)).map(r => r.row),
      )
      let written = 0
      let cleared = 0
      for (const r of normalized) {
        if (!r.row) continue
        if (FIELDS.every(f => blank(r.values[f.key]))) {
          ctx.clearRow(sheet, r.row)
          cleared++
          continue
        }
        for (const f of FIELDS) if (m.col?.[f.key]) ctx.setCell(sheet, r.row, f.key, r.values[f.key])
        written++
      }
      /**
       * 改名带出来的完成情况：这些行不在这一轮提交里（改的是**别人**对他的记录），单独补写
       *
       * 与上面那一批行号不重叠：提交里的行已经在 `r.values.status` 上改过（见 `statusRenamePlan` 那段）。
       */
      for (const [row, status] of statusWrites) if (m.col?.status) ctx.setCell(sheet, row, "status", status)

      /** 这一轮里手填的新名字（不在下拉里的）顺手归档成下拉选项 */
      writeValidationPlan(ctx, sheet, validationPlan(m))

      /** 归属变化：清空的行（退队）解绑；本人写过的行记下/刷新绑定，以后按 QQ 认人 */
      for (const r of normalized) {
        if (!r.row) continue
        if (FIELDS.every(f => blank(r.values[f.key]))) {
          dropBindsAt(binds, sheet, r.row)
          continue
        }
        /** 这一行现在的昵称变了：别人留下的旧绑定（昵称对不上）一并清掉 */
        dropBindsAt(binds, sheet, r.row, { keepNickname: r.values.nickname, keepQq: qq })
        /**
         * `newRows.has(r.row)`：本人**新建**的行也要绑给本人。
         * 否则没群名片的人在云端建完一行，下次再改就"又不是我的记录"了（表里已有内容、绑定却没建）。
         */
        if (
          caller.role === "self" &&
          qq &&
          (newRows.has(r.row) || mine.has(r.row) || sameNick(r.values.nickname, nick))
        ) {
          bindSet(binds, sheet, qq, { row: r.row, nickname: r.values.nickname || nick })
          renameLock(lockRows, sheet, r.row, r.values.nickname || nick)
        }
      }
      plan = { binds, locks: lockRows }
      return { written, cleared, ignored, notices, realigned }
    },
    { expect: version, afterCommit: info => persistState(info, plan) },
  )

  return result
}

/** 主播区里第一个能放主播的行（第 1 行是表格标题、第 2 行是「主播列表」小表头，见 model/schema.js） */
const ANCHOR_FIRST_ROW = 3

/** 主播行的可写值：字段与 ANCHOR_FIELDS 一一对应，值一律 trim（空 = 空串，与原口径一致） */
const anchorValuesOf = values => Object.fromEntries(ANCHOR_FIELDS.map(f => [f.key, String(values?.[f.key] ?? "").trim()]))

/** A 列原文是「主播名【推荐度】」，推荐度单独一格填，这里拼回去 */
const anchorNameOf = values => (values.recommend ? `${values.name}【${values.recommend}】` : values.name)

/**
 * 插行之后把绑定与锁里的行号一起搬走（只搬被插的那一榜、插入点及以下的行）
 *
 * **必须搬**：绑定/锁下一步会被盖上"新版本"的戳，行号却还指着上一行 —— 下次本人打开页面时
 * 版本对得上（于是不做重建），人就被认到别人的行上去了。搬法与群名单对账那边同一口径：
 * 从不可变旧快照读、写进全新对象、最后整体替换（原地读写会让新键覆盖还没搬的另一条）。
 */
const shiftRowsOf = ({ binds, locks }, sheet, from, count) => {
  if (!count) return { binds, locks }
  const nextBinds = {}
  for (const [name, list] of Object.entries(binds ?? {})) {
    nextBinds[name] = {}
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      nextBinds[name][qq] = name === sheet && row >= from ? { ...info, row: row + count } : info
    }
  }
  const nextLocks = {}
  for (const [key, lock] of Object.entries(locks ?? {})) {
    const row = lockRowOf(key)
    nextLocks[lockSheetOf(key) === sheet && row >= from ? lockKey(sheet, row + count) : key] = lock
  }
  return { binds: nextBinds, locks: nextLocks }
}

/**
 * 按"哪一行的人去了哪一行"重排绑定与完成情况锁（挪行 / 插队用）
 *
 * 与 `shiftRowsOf`（整段 +count，插行用）不同：那里是"新插入一行、下面全体下移"，
 * 这里是"表里的内容换过位置"，每行的去向由调用方给的映射决定。**还是要从不可变旧快照读、
 * 写进全新对象、最后整体替换**——原地读写会让新键覆盖还没搬的另一条（与插行那边同一个坑）。
 *
 * @param {{binds: object, locks: object}} state 旧状态（只读）
 * @param {string} sheet 只重排这一榜（别的榜原样保留）
 * @param {(row: number) => number} toRow 行号 → 新行号（原样返回即不动）
 */
const remapRowsOf = ({ binds, locks }, sheet, toRow) => {
  const nextBinds = {}
  for (const [name, list] of Object.entries(binds ?? {})) {
    nextBinds[name] = {}
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      nextBinds[name][qq] = name === sheet && row ? { ...info, row: toRow(row) } : info
    }
  }
  const nextLocks = {}
  for (const [key, lock] of Object.entries(locks ?? {})) {
    const row = lockRowOf(key)
    nextLocks[lockSheetOf(key) === sheet ? lockKey(sheet, toRow(row)) : key] = lock
  }
  return { binds: nextBinds, locks: nextLocks }
}

/**
 * 保存表头上方的「主播列表」（只有管理员能改）
 *
 * 两种改动走同一发请求：
 *   - `rows`：改表里**已有**的那几行（按行号对齐），行号必须是表里已有的主播行
 *   - `added`：新增主播。主播区没有空行可用，所以服务端在**最后一位主播下面插一行**，
 *     公告行 / 表头行 / 数据行连同它们的行号引用一起下移一格（`model/xlsx.js` 的
 *     `insertRowsAndShift`），绑定与锁里的行号同步搬走（`shiftRowsOf`）
 * 写的是：A 列 = 主播名 + 【推荐度】、C 强项、D 专职、G/H 直播入口。
 * 顺手把「选择主播」那一列的下拉列表也改成同一份名单（**以主播列表为准**），
 * 否则表格自己的下拉会一直停在旧名字上。
 *
 * 与成员保存**同一套并发语义**：请求可以带 `version`（页面读到的那一版表指纹），
 * 对不上就报冲突（409）而不是把别人刚提交的改动盖掉（AQ-06）。主播列表也是写表，
 * 没有理由比数据行少这一层保护。
 * @returns {Promise<{written:number, inserted:number, options:number}>}
 */
const applyAnchors = async (caller, { sheet, rows, added, version }) => {
  if (caller.role !== "admin") throw new Error("只有白名单管理员可以改主播列表")
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  /** 页面上新加的主播还没有行号（要插入时才定得下来），单独放在 `added` 里 */
  const fresh = Array.isArray(added) ? added : []
  if (rows.length + fresh.length > 100) throw new Error("一次提交的主播行数过多（>100）")

  let plan = null
  return table().mutate(
    async ctx => {
      /** 行号必须是表里已有的主播行，避免把内容写到数据区或其它地方（读的是同一版表） */
      const model = ctx.model(sheet)
      const known = new Map(model.anchors.map(a => [a.row, a]))

      const normalized = []
      for (const r of rows) {
        const row = Number(r?.row) || 0
        const before = known.get(row)
        if (!before) throw new Error(`第 ${row} 行不是主播列表里的行，不能改`)
        const values = anchorValuesOf(r?.values)
        if (!values.name) throw new Error(`第 ${row} 行：主播名不能为空（要删掉这位主播请在表格里删行）`)
        normalized.push({ row, values })
      }

      const addedValues = fresh.map((r, i) => {
        const values = anchorValuesOf(r?.values)
        if (!values.name) throw new Error(`新增的第 ${i + 1} 位主播：主播名不能为空`)
        return values
      })

      /** 新行落在最后一位主播下面；主播区还空着就放在第一个能放主播的行上（见 ANCHOR_FIRST_ROW） */
      const insertedAt = model.anchors.length ? Math.max(...model.anchors.map(a => a.row)) + 1 : ANCHOR_FIRST_ROW
      /**
       * **守卫：插入行必须严格落在表头上方**（`insertedAt < headerRow`）
       *
       * 主播区（表头之上）与排队区（表头之下）是同一张表里的两个区，插行时表头与整个排队区要一起下移
       * （见 `model/xlsx.js` 的 `insertRowsAndShift`）——插入点跑到表头及以下，这一行就落进排队区了：
       * 序号轴、下拉、绑定与锁全都会串，出现"版本戳对得上、人却被认到别人的行上"。
       * 表头识别在第 3 行或更靠上的表（人工压过结构 / 合成表），`ANCHOR_FIRST_ROW` 这个"主播区还空着"
       * 的回退值就落到表头及以下；这种表不该由编辑器动手，宁可明确拒绝。
       *
       * 拒绝发生在**任何写之前**（`ctx.insertRows` / 写格 / 存底 / 换版本都在后面），
       * 抛出去由 `mutate()` 原样中止这一轮 —— 表、绑定、锁、版本一个字都不动。
       * 只改既有主播行（没有 `added`）不插行，不进这条守卫。
       */
      if (addedValues.length && insertedAt >= model.headerRow)
        throw new Error(
          `不能新增主播：算出来的插入行是第 ${insertedAt} 行，而表头在第 ${model.headerRow} 行 —— ` +
            `主播区（表头之上）与排队区（表头之下）不能混，请先在表格里把表头位置理清楚`,
        )
      if (addedValues.length) {
        /**
         * 新行的样子：行属性与格子样式照抄**上面那一行**（最后一位主播），合并格照抄**第一位**主播
         * 那一行 —— A:B / C:F / G:H 三段合并才是规范布局，个别主播行自己缺一段（例如入口那两格
         * 没合并），照抄最后一行就会跟着缺。
         */
        const neighbour = model.anchors.length ? model.anchors.at(-1).row : 0
        ctx.insertRows(sheet, insertedAt, addedValues.length, { mergeTemplateRow: model.anchors[0]?.row ?? 0 })
        addedValues.forEach((values, i) => {
          const row = insertedAt + i
          for (const f of ANCHOR_FIELDS) {
            if (!f.col) continue
            const style = neighbour ? ctx.refStyle(sheet, `${f.col}${neighbour}`) : undefined
            ctx.setRef(sheet, `${f.col}${row}`, f.key === "name" ? anchorNameOf(values) : values[f.key], style)
          }
        })
      }

      /** 改完之后的主播名单 → 就是「选择主播」下拉该有的选项（表里在用的旧值追加在后面） */
      const names = model.anchors.map(a => ({ row: a.row, name: a.name }))
      for (const n of normalized) {
        const hit = names.find(x => x.row === n.row)
        if (hit) hit.name = n.values.name
      }
      for (const values of addedValues) names.push({ row: 0, name: values.name })
      const listPlan = validationPlan(model, names.map(n => n.name))
      const options = listPlan.anchor

      /** 写表前留底：历史版本 + 每日/换月归档 */
      await snapshotBeforeWrite()
      for (const { row, values } of normalized) {
        for (const f of ANCHOR_FIELDS) {
          if (!f.col) continue
          ctx.setRef(sheet, `${f.col}${row}`, f.key === "name" ? anchorNameOf(values) : values[f.key])
        }
      }
      /**
       * 两列下拉都同步成同一份名单，并把校验强度从 stop 调成 warning：
       * Excel/腾讯文档的数据验证不支持真多选，stop 会把「阿修Axiu,听雨」这种手写多值直接打回，
       * 改成 warning 后仍然给下拉、仍然提示，但允许填多值。
       */
      writeValidationPlan(ctx, sheet, listPlan)
      /** 表换了版本：绑定与锁要跟着盖上新版本，否则下次对账会把它们全作废 */
      const state = await ownershipIn(ctx, await store())
      /** 插了行，插入点以下的行号全变了：绑定与锁搬完再盖章（漏搬 = 本人被认到别人的行上） */
      const moved = shiftRowsOf(state, sheet, insertedAt, addedValues.length)
      plan = { binds: moved.binds, locks: moved.locks }
      return { written: normalized.length + addedValues.length, inserted: addedValues.length, options: options.length }
    },
    { expect: version, afterCommit: info => persistState(info, plan) },
  )
}

/**
 * 把"已排队的某个人"挪到他前面最近那一位「排队中」的前面（越过一位）
 *
 * **只给 `#插队` 用**（管理员在群里发指令，插件调 `/api/move-row`，见 apps/inserter.js）。
 * 位置由**编辑器**算：插件只给"哪一榜、哪一行、怎么挪"，算不出目标就整表不动。
 *
 * 口径（与插件侧同一份）：
 *   - 目标行 = 这一行**上方**最近的一条「排队中」；`dataStart` 之上没有任何「排队中」⇒ 什么都不做
 *     （不是错误，返回 `moved:false` + `reason`），插件照原样回一句"已经在最前面"；
 *   - 动作 = 交换这两行的**数据格**（B–H 全部列，含填在表里的「帮帮完成情况」）：
 *     不新增行、不删除行、不改任何行号 ⇒ 排队区不出现空行/缺行，序号列（`=ROW()-k` 的缓存值）
 *     逐行不动，仍然是 1..N；
 *   - 样式随内容一起换（每格把**对方那一行**的 `s` 显式带上）：不这么做，隔行配色会留在原地，
 *     人一挪就顶着别人的底色；
 *   - 绑定与锁的行号由 `shiftRowsOf` 搬（`[Q, R-1]` 整段下移一位）：这一步不能省——
 *     `ownershipIn` 在写表后按行号记归属，不搬就等于"表换了、归属还指着旧行号"。
 *
 * 失败即整表不动：任何一步不满足预期都抛错，由 `mutate()` 原样中止这一轮（表 / 绑定 / 锁 / 版本都不动）。
 * @param {{role: string}} caller 调用者（非管理员直接抛错）
 * @param {{sheet: string, row: number|string, mode: string, nick?: string}} body 请求体
 * @returns {Promise<{moved: boolean, sheet: string, from?: number, to?: number, nickname?: string,
 *   crossed?: string, reason?: string}>}
 */
const applyMoveRow = async (caller, { sheet, row, mode, nick } = {}) => {
  if (caller.role !== "admin") throw new Error("只有白名单管理员可以插队")
  if (String(mode ?? "") !== "before-last-queued")
    throw new Error('请求格式不对：需要 { sheet, row, mode: "before-last-queued" }')
  const sheetName = String(sheet ?? "").trim()
  const from = Number(row)
  if (!sheetName) throw new Error("缺少 sheet")
  if (!Number.isSafeInteger(from) || from < 1) throw new Error(`行号不合法：${row}`)

  /** 什么都不做的结论（"前面没有排队中的人"）**必须原样带回给调用方**：插件要照着它回话 */
  let out = null
  let plan = null
  await table().mutate(
    async ctx => {
      const model = ctx.model(sheetName)
      /** 要跟着人走的那几列：逻辑列 key → 列字母（序号列也在里面，A 列换了位置 Excel 一重算就错） */
      const cols = Object.entries(model.col).filter(([key, col]) => col && MOVE_COLUMN_KEYS.includes(key))

      const person = model.rows.find(r => r.row === from)
      if (!person || !String(person.nickname ?? "").trim()) throw new Error(`第 ${from} 行不是排队的记录，不能插队`)
      if (String(person.status ?? "").trim() !== QUEUED_STATUS)
        throw new Error(`「${String(person.nickname).trim()}」在「${sheetName}」里不是「${QUEUED_STATUS}」，不能插队`)

      /** 上方最近的一条「排队中」（只认昵称非空、状态正是「排队中」的行） */
      const target = model.rows
        .filter(r => r.row < from && String(r.nickname ?? "").trim() && String(r.status ?? "").trim() === QUEUED_STATUS)
        .sort((a, b) => b.row - a.row)[0]
      if (!target) {
        out = {
          moved: false,
          sheet: sheetName,
          from,
          nickname: String(person.nickname).trim(),
          reason: `前面没有「${QUEUED_STATUS}」的人`,
        }
        return { moved: false }
      }
      if (target.row < model.dataStart || target.row >= from)
        throw new Error(`算出来的目标行第 ${target.row} 行不在数据区里（数据区自 ${model.dataStart} 起），整表不动`)

      /**
       * 逐格交换：两边都按"对方那一行的样式号"写
       *
       * 值取自**这一版表的模型**（写表排在临界区末尾，模型不会中途变），所以每一格都算得出确定的值；
       * 只有一边有值、另一边为空时写 `clearCell`（落成表里本来就有的空值格），不留缺格也不留空串格。
       */
      for (const [key, col] of cols) {
        const atTarget = ctx.refStyle(sheetName, `${col}${target.row}`)
        const atFrom = ctx.refStyle(sheetName, `${col}${from}`)
        const theirs = String(target[key] ?? "")
        const mine = String(person[key] ?? "")
        /** 目标行换成"我的"，来源行换成"他的"；`current` 传的是**这一格现在**的值（守卫靠它短路） */
        moveCell(ctx, sheetName, key, col, target.row, mine, theirs, atFrom)
        moveCell(ctx, sheetName, key, col, from, theirs, mine, atTarget)
      }

      /** 写表前留底：历史版本 + 每日/换月归档 */
      await snapshotBeforeWrite()
      const state = await ownershipIn(ctx, await store())
      /** 插队 = 越过一位：中间那一段（含目标行）整体下移一位，绑定与锁里的行号跟着搬 */
      /**
       * 插队 = 越过一位：表里换的是**内容**，所以归属按"哪一行的人去了哪一行"重排
       *
       * 换格的算法（`moveCell` 那一圈）等价于"把 R 行的人插到 Q 行前面"：
       *   - R 行的人 → 第 Q 行；
       *   - 原来在 `[Q, R-1]` 的人各往后一位（Q 行的人落到 Q+1，依次顺延）；
       *   - Q 行以上、R 行以下的人一个都不动。
       * 这就是"越过一位"的完整语义，也解释了 `from - target.row` 只是相邻时恰好等于 1。
       * 锁按 `榜#行号` 存，必须与绑定走**同一张映射**——不搬就是"锁留在原地、锁到别人头上"。
       */
      const toRow = r => {
        if (r === from) return target.row
        if (r >= target.row && r < from) return r + 1
        return r
      }
      plan = remapRowsOf(state, sheetName, toRow)
      out = {
        moved: true,
        sheet: sheetName,
        from,
        to: target.row,
        nickname: String(person.nickname).trim(),
        crossed: String(target.nickname).trim(),
      }
      return { moved: out.moved }
    },
    { afterCommit: info => persistState(info, plan) },
  )

  if (!out?.moved) return out ?? { moved: false, sheet: sheetName, reason: "没有可挪的位置" }
  console.log(
    `[editor] 插队：${out.sheet} 第 ${out.from} 行「${out.nickname}」挪到第 ${out.to} 行（越过「${out.crossed}」）` +
      (nick ? `（由 ${nick} 发起）` : ""),
  )
  return out
}

/**
 * 「已完成」的判据（每日整理用）：完成情况写了**人**——主播名，或点「本人已完成」落成的该行群昵称
 *
 * 也就是"既不是「排队中」也不是「等待开启」"；多值（「阿修Axiu,听雨」）同样算已完成。
 * **空着的**不算已完成（那是还没填，整理时跟「排队中」一起放后面）。
 */
const isDoneStatus = status => {
  const v = String(status ?? "").trim()
  return Boolean(v) && v !== QUEUED_STATUS && v !== WAITING_STATUS
}

/**
 * 每日整理的目标顺序（**纯函数**，好在套件里直接喂模型断言）
 *
 * 口径（维护者定的）：**「等待开启」是挡位**——它那一行原地不动，并把排队区分成若干段，
 * 段与段之间不跨着挪；段内稳定分区：**已完成的在前、「排队中」的在后**，同类保持原有先后。
 * 只排**有群昵称的行**（空行不参与也不动：它们是"还能填的格子"，挪了反而出现空档）。
 *
 * @param {object} model 榜模型
 * @returns {{slots: number[], order: number[], groups: number}|null}
 *   `slots` = 参与排序的格子行号（升序，固定不动）；`order` = 这些格子里该放**哪一行**的内容；
 *   **已经就是这个顺序**就返回 null —— 调用方据此"一个字都不写"（不重新保存、不产生历史版本）。
 */
const tidyOrder = model => {
  const records = (model.rows ?? [])
    .filter(r => String(r.nickname ?? "").trim())
    .sort((a, b) => a.row - b.row)
  if (records.length < 2) return null

  const slots = records.map(r => r.row)
  const out = []
  let segment = []
  let groups = 0
  /** 把当前这一段按"已完成在前"稳定分区后接进结果 */
  const flush = () => {
    if (segment.length > 1) groups++
    out.push(...segment.filter(r => isDoneStatus(r.status)), ...segment.filter(r => !isDoneStatus(r.status)))
    segment = []
  }
  for (const r of records) {
    /** 挡位：自己原地不动，同时把前后两段切开 */
    if (String(r.status ?? "").trim() === WAITING_STATUS) {
      flush()
      out.push(r)
      continue
    }
    segment.push(r)
  }
  flush()

  const order = out.map(r => r.row)
  if (order.every((row, i) => row === slots[i])) return null
  return { slots, order, groups }
}

/**
 * 每日整理：把每个「等待开启」挡位之间那一段排成"**已完成的在前、排队中的在后**"
 *
 * 与 `#插队` 同一条理由由编辑器干这件事：插件对表**只读**，动整张表只有拿着表的编辑器做得到。
 * 动作 = **换内容**（与 `#插队` 同一套 `moveCell`）：不插行、不删行、行号一个都不变，
 * A 列序号（`=ROW()-k`）原地不动；归属（绑定与锁）按"哪一行的人去了哪一行"重排（`remapRowsOf`）。
 *
 * **已经是有序的 ⇒ 一个字都不写**：`mutate()` 只在真写了格时才落盘，所以这里提前 return
 * 就等于"没动过"——不产生历史版本、不刷新版本指纹（维护者要求：若当前表格也为此状态则不做改动）。
 *
 * @param {{role: string, identity?: object}} caller 调用者（机器人身份或主人，见路由的权限判据）
 * @param {{sheet?: string}} body 不给 `sheet` 就整理所有榜
 * @returns {Promise<{moved: number, tidied: Array<{sheet: string, moved: number, reason?: string}>}>}
 */
const applyTidy = async (caller, { sheet } = {}) => {
  const wanted = String(sheet ?? "").trim()
  const tidied = []
  let plan = null
  let moved = 0

  await table().mutate(
    async ctx => {
      const names = wanted ? [wanted] : [...ctx.models.keys()]
      /** 先算出每个榜"要不要动、怎么动"；一个都不用动的榜不进 ops（也就不写任何格） */
      const ops = []
      for (const name of names) {
        const model = ctx.model(name)
        const target = tidyOrder(model)
        if (!target) {
          tidied.push({ sheet: name, moved: 0, reason: "已经是有序的（或没有可排序的行），一个字都没写" })
          continue
        }
        ops.push({ name, model, ...target })
      }
      if (!ops.length) return { moved: 0 }

      /** 写表前留底：历史版本 + 每日/换月归档（只有真的要动表时才留） */
      await snapshotBeforeWrite()
      for (const op of ops) {
        /** 跟着人走的那几列：与 `#插队` 同一份（`MOVE_COLUMN_KEYS`，A 列序号不在里面） */
        const cols = Object.entries(op.model.col).filter(([key, col]) => col && MOVE_COLUMN_KEYS.includes(key))
        const byRow = new Map(op.model.rows.map(r => [r.row, r]))
        for (let i = 0; i < op.slots.length; i++) {
          const to = op.slots[i]
          const from = op.order[i]
          if (to === from) continue
          for (const [key, col] of cols)
            moveCell(
              ctx,
              op.name,
              key,
              col,
              to,
              String(byRow.get(from)?.[key] ?? ""),
              String(byRow.get(to)?.[key] ?? ""),
              /** 样式随内容一起换（每格带上**来源那一行**的样式号）：不这么做隔行配色会留在原地 */
              ctx.refStyle(op.name, `${col}${from}`),
            )
          op.moved = (op.moved ?? 0) + 1
        }
      }

      const state = await ownershipIn(ctx, await store())
      let merged = { binds: state.binds, locks: state.locks }
      for (const op of ops) {
        const rowMap = new Map()
        for (let i = 0; i < op.slots.length; i++) if (op.slots[i] !== op.order[i]) rowMap.set(op.order[i], op.slots[i])
        tidied.push({ sheet: op.name, moved: op.moved ?? 0, segments: op.groups })
        moved += op.moved ?? 0
        merged = remapRowsOf(merged, op.name, r => rowMap.get(r) ?? r)
      }
      plan = merged
      return { moved }
    },
    { afterCommit: info => persistState(info, plan) },
  )

  if (moved) console.log(`[editor] 每日整理：共挪 ${moved} 行（${tidied.filter(t => t.moved).map(t => `${t.sheet} ${t.moved}`).join("、")}）`)
  return { moved, tidied }
}

/**
 * 挪行时写一格：`value` 与这一格现在的值一样就一个字不写（省掉一次无意义的重写）
 *
 * 值是空的来源有两种：对方那一行本来就空、或这一格在对面压根不存在——两者都落成**空值格**
 * （`ctx.clearCell`，保留格与样式）；已经不空的时候才用 `ctx.setCell` 带上样式号写进去。
 * @param {string} key 逻辑列 key（`ctx.setCell` 认它，不认列字母）
 * @param {string} col 列字母（拼格子地址）
 * @param {number} row 行号
 * @param {string} value 要写进去的值（对方那一格的原文）
 * @param {string} current 这一格现在的值
 * @param {string|undefined|null} style 这一格现在的样式号（内容换过来，格式也换过来）
 */
const moveCell = (ctx, sheet, key, col, row, value, current, style) => {
  const next = String(value ?? "")
  if (next === String(current ?? "")) return
  if (next) ctx.setCell(sheet, row, key, next, style)
  else ctx.clearCell(sheet, `${col}${row}`)
}

/**
 * 两份下拉名单的"计划"：选择主播 与 帮帮完成情况
 * 规则（两列一致）：
 *   1. 表头上方主播列表里的正名在前（去重）
 *   2. 表里手填/在用的其它值（不在名单里的主播、都可以、排队中…）**自动收进来当选项**
 *      —— 这就是"手填的主播自动归档为下拉选项"，免得表里能用、下拉里却没有
 * @param {object} model 榜模型
 * @param {string[]|null} anchorsOverride 主播区刚改完的名单（保存主播列表时用）
 */
const validationPlan = (model, anchorsOverride = null) => {
  const names = (anchorsOverride ?? model.anchors.map(a => a.name)).map(s => String(s ?? "").trim()).filter(Boolean)
  const anchors = [...new Set(names)]
  const anchorCol = model.col?.anchor
  const statusCol = model.col?.status
  const anchor = anchorCol ? effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) }).anchor : []
  const status = statusCol ? mergeStatusOptions(model, anchors) : []
  return { anchorCol, statusCol, anchor, status }
}

/** 把两份名单写进表（统一用 warning：Excel 的数据验证不支持真多选，stop 会把「A,B」这种手填值拦下） */
const writeValidationPlan = (ctx, sheet, plan) => {
  if (plan.anchorCol && plan.anchor.length) ctx.setValidationList(sheet, plan.anchorCol, plan.anchor, { errorStyle: "warning" })
  if (plan.statusCol && plan.status.length) ctx.setValidationList(sheet, plan.statusCol, plan.status, { errorStyle: "warning" })
}

/**
 * 表里手填了新名字就把它归档进下拉选项（只有管理员打开时做，且只在真有新名字时才写表）
 *
 * 读与写同样在同一个临界区里：不然"读出来要归档"和"真写进去"之间表可能已经被换掉（AQ-06）。
 */
const archiveOptions = async caller => {
  if (caller.role !== "admin") return 0
  let work = []
  let plan = null
  await table().mutate(
    async ctx => {
      work = [...ctx.models.values()]
        .map(model => {
          const listPlan = validationPlan(model)
          const known = new Set([...(model.options?.anchor ?? []), ...(model.options?.status ?? [])])
          /** 两份名单里出现了当前验证列表没有的值 → 需要归档 */
          const fresh = [...listPlan.anchor, ...listPlan.status].filter(v => v && !known.has(v))
          return { name: model.name, plan: listPlan, fresh: [...new Set(fresh)] }
        })
        .filter(x => x.fresh.length)
      if (!work.length) return { archived: 0 }
      /** 写表前留底：历史版本 + 每日/换月归档 */
      await snapshotBeforeWrite()
      for (const { name, plan: p } of work) writeValidationPlan(ctx, name, p)
      const state = await ownershipIn(ctx, await store())
      plan = { binds: state.binds, locks: state.locks }
      return { archived: work.reduce((n, x) => n + x.fresh.length, 0) }
    },
    { afterCommit: info => persistState(info, plan) },
  )
  if (!work.length) return 0
  const total = work.reduce((n, x) => n + x.fresh.length, 0)
  console.log(`[editor] 已把手填的 ${total} 个名字归档进下拉选项：${work.map(x => `${x.name}（${x.fresh.join("、")}）`).join("；")}`)
  return total
}

/**
 * 开榜时间到了、表里还写着「等待开启」的行：自动翻成「排队中」
 *
 * 剧诗每月 1 号 4 点、深渊每月 16 号 4 点开，到点之后表里不该再留着「等待开启」。
 * 只由管理员打开页面时顺带做（危战没有固定开榜日子，它的「等待开启」是正常值，不动）。
 * @returns {Promise<number>} 改了几行
 */
const catchUpOpenStatus = async caller => {
  if (caller.role !== "admin") return 0
  let opened = []
  let plan = null
  await table().mutate(
    async ctx => {
      opened = [...ctx.models.values()]
        .filter(m => OPEN_RULES.some(r => r.test.test(m.name)) && defaultStatusOf(m.name) === QUEUED_STATUS)
        .flatMap(m =>
          m.rows
            .filter(r => String(r.status ?? "").trim() === WAITING_STATUS)
            .map(r => ({ sheet: m.name, row: r.row, nickname: String(r.nickname ?? "").trim() })),
        )
      if (!opened.length) return { opened: 0 }
      /** 写表前留底：历史版本 + 每日/换月归档 */
      await snapshotBeforeWrite()
      for (const o of opened) ctx.setCell(o.sheet, o.row, "status", QUEUED_STATUS)
      const state = await ownershipIn(ctx, await store())
      plan = { binds: state.binds, locks: state.locks }
      return { opened: opened.length }
    },
    { afterCommit: info => persistState(info, plan) },
  )
  if (!opened.length) return 0
  console.log(
    `[editor] 开榜时间已到，把 ${opened.length} 行的「${WAITING_STATUS}」改成「${QUEUED_STATUS}」：` +
      opened.map(o => `${o.sheet} 第 ${o.row} 行${o.nickname ? `「${o.nickname}」` : ""}`).join("；"),
  )
  return opened.length
}

/* ------------------------- 历史版本 / 归档 / 覆盖写入 ------------------------- */

/**
 * 版本与归档的实现都在 `editor/versions.js`（连文件名正则一起），装配点在上方；
 * 本文件只留**整表替换**——它要和绑定/锁的归属重建在同一次状态转换里，不能搬走。
 */

/** 归档清单（新的在前）：月度在前，其次每日 —— 见 `editor/versions.js` */

/**
 * 整表替换必须带的列（表头识别出来的列字母）
 *
 * 编辑器会写这些列，缺任何一列都会让对应字段"界面能填、保存却悄悄丢掉"；
 * 业务读取（机器人出图、锁、进度）也依赖它们。空模板允许（结构在、一行数据都没有），
 * 但连表头都没有的表一律拒绝，并把缺什么说清楚（AQ-07）。
 */
const REPLACE_REQUIRED_COLUMNS = [
  ["seq", "序号"],
  ["nickname", "群昵称"],
  ["gameName", "原神游戏名"],
  ["anchor", "选择主播"],
  ["goal", "难度及目标"],
  ["strength", "账号强度"],
  ["status", "帮帮完成情况"],
  ["note", "备注"],
]

/**
 * 替换前的结构校验（AQ-07）
 *
 * 名字对得上不代表内容对：空表壳或别的表也会"上传成功"，结果编辑器和机器人都读不出任何数据。
 * 所以逐表确认表头、必要列与建模结果。
 * @throws {Error} 带具体缺失项的中文说明
 */
const validateReplacement = (after, before) => {
  if (after.names.join("|") !== before.names.join("|"))
    throw new Error(`工作表对不上：文件里是「${after.names.join("、")}」，当前表是「${before.names.join("、")}」，拒绝替换`)
  const unparsed = after.names.filter(n => !after.models.has(n))
  if (unparsed.length) throw new Error(`这些工作表解析不出结构：${unparsed.join("、")}，拒绝替换`)
  const problems = []
  for (const name of after.names) {
    const model = after.models.get(name)
    const missing = REPLACE_REQUIRED_COLUMNS.filter(([key]) => !model.col?.[key]).map(([, label]) => label)
    if (missing.length) problems.push(`「${name}」的表头缺少：${missing.join("、")}`)
  }
  if (problems.length)
    throw new Error(`这份表的结构不完整，拒绝替换（可以是没有成员的空模板，但表头与列必须齐全）：\n${problems.join("\n")}`)
}

/**
 * 用一份字节替换当前表（回退 / 云端上传共用）
 *
 * 表、QQ→行绑定、完成情况锁**必须作为同一次状态转换**处理：
 * 只换 xlsx 的话，旧行号会指到新表里的另一个人，本人一打开页面就把别人的昵称改成自己（AQ-03）。
 * 走 table().replace —— 与普通保存同一条队列，读/校验/存底/提交都在一个临界区里（AQ-06）。
 *
 * @param {Buffer} bytes 新的表文件
 * @param {string} label 日志里用的来源说明
 * @param {object} [opts]
 * @param {string} [opts.expect] 调用方读到的那一版指纹；不一致 → 冲突（不覆盖别人的改动）
 * @returns {Promise<{version:string, size:number, fp:string, bindings:object, locks:object}>}
 */
const replaceTable = async (bytes, label, { expect } = {}) => {
  if (!bytes?.length) throw new Error("内容是空的")
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`文件过大（${Math.round(bytes.length / 1024 / 1024)}MB），拒绝替换`)

  /** 先探一次"这到底是不是 xlsx"：错的是文件类型，不该报成"结构不完整" */
  try {
    const probe = await openWorkbook(bytes)
    if (!probe.sheets?.length) throw new Error("里面没有任何工作表")
  } catch (err) {
    throw new Error(`这份文件不是能读的 xlsx：${err?.message ?? err}`)
  }

  const bindStore = await store()
  let snapshot = ""
  let plan = null
  let rebuilt = { bindKept: 0, bindDropped: 0, lockKept: 0, lockDropped: 0 }
  let out
  try {
    out = await table().replace(bytes, {
      expect,
      validate: validateReplacement,
      /**
       * 关联状态迁移：绑定与锁按**新表**的群昵称重新对账
       * 昵称在新表里唯一命中 → 跟过去（改名/挪行都认）；命中不了 → 作废，绝不按旧行号认人
       */
      transition: ({ before, after }) => {
        rebuilt = rebuildOwnership(after.models, bindStore.data.binds ?? {}, loadLocks().rows ?? {}, before.models)
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return rebuilt
      },
      beforeWrite: async () => {
        snapshot = await snapshotBeforeWrite()
      },
      afterCommit: info => persistState(info, plan),
    })
  } catch (err) {
    if (err?.conflict) throw err
    /** buildModel 的报错（表头行 / 群昵称列）单看太像内部错误，这里补一句"这是替换被拒的原因" */
    const msg = String(err?.message ?? err)
    if (/找不到表头行|表头缺少/.test(msg)) throw new Error(`这份表结构不完整，拒绝替换：${msg}`)
    throw err
  }

  console.log(
    `[editor] 已用 ${label} 覆盖当前表（${bytes.length} 字节，替换前存了 ${snapshot || "未存版本"}）；` +
      `归属重新对账：绑定保留 ${rebuilt.bindKept}、作废 ${rebuilt.bindDropped}；锁保留 ${rebuilt.lockKept}、作废 ${rebuilt.lockDropped}`,
  )
  return {
    version: snapshot,
    size: bytes.length,
    fp: out.fp,
    bindings: { kept: rebuilt.bindKept, dropped: rebuilt.bindDropped },
    locks: { kept: rebuilt.lockKept, dropped: rebuilt.lockDropped },
  }
}

/* ------------------------- 群成员名单（候选人 + 按 QQ 对账） ------------------------- */

/**
 * `loadRoster` / `saveRoster` / `nickCandidates` / `nickOf` 的实现都在 `editor/roster.js`，
 * 装配点在上方「装配：群名单 / 白名单 / 锁」。这里只留"按 QQ 对账表"那段业务（见下）。
 */

/**
 * 把某一榜的数据行压紧：删掉 dropRows，其余整体上移，队列不留空洞
 *
 * 序号是按行算的公式（=ROW()-偏移），所以只搬 B–H，尾部多出来的行清空，序号自然还是 1..N。
 *
 * 每行自己的样式（B–H 逐格的 s：填充/边框/条件格式观感）要**跟着这一行一起搬**。
 * 图省事用 ctx.setCell 默认的整列采样样式会把逐行差别抹平——上移后的行就套上了别人那一行的
 * 底色（AQ-15 的延伸：清空同一行保住了行样式，搬行却还在丢），所以这里先按源行读一遍
 * `ctx.rowStyles` 再逐格显式带上。源行没有那一格（null）时保留目标格原有样式：
 * 空行本身没有样式可搬，硬抹掉只会在表里挖出一个白洞。
 * @returns {{removed: number, moved: number}}
 */
const compactSheet = async (ctx, model, dropRows) => {
  const drop = new Set(dropRows.map(Number))
  if (!drop.size) return { removed: 0, moved: 0 }
  const rows = []
  for (let r = model.dataStart; r <= model.dataEnd; r++) rows.push(r)
  const kept = rows.filter(r => !drop.has(r))
  const valueOf = new Map()
  for (const item of model.rows) valueOf.set(item.row, item)
  const nextRowOf = new Map()
  kept.forEach((oldRow, i) => nextRowOf.set(oldRow, model.dataStart + i))

  for (const oldRow of kept) {
    const target = nextRowOf.get(oldRow)
    const item = valueOf.get(oldRow)
    /** 样式按"搬走之前"那一行读：写入都排在临界区末尾落表，所以读到的还是旧样式 */
    const from = await ctx.rowStyles(model.name, oldRow)
    for (const f of FIELDS) {
      if (!model.col?.[f.key]) continue
      ctx.setCell(model.name, target, f.key, item ? String(item[f.key] ?? "") : "", from[f.key])
    }
  }
  /** 尾部空出来的行只清值、样式保持该位置原本的空行样式（退队删行不该在表尾留下一条花花绿绿的空行） */
  for (let r = model.dataStart + kept.length; r <= model.dataEnd; r++) ctx.clearRow(model.name, r)
  return { removed: drop.size, moved: kept.length }
}

/**
 * 按名单对账：改了群名片 → 同步表里该 QQ 那行的群昵称；退群/被移出 → 删掉那一行并压紧
 *
 * 删行前会自动存历史版本（同一临界区里做），所以退群删错能回退。
 *
 * 绑定与锁的迁移**只从不可变旧快照读、写进全新对象、最后整体替换**（AQ-08）：
 * 原地读旧键 / 写新键 / 删旧键时，新键可能正好是还没迁移的另一条锁，
 * 结果一条被覆盖、另一条落在错的行上——被锁住的人变成了别人。
 * @returns {Promise<{renamed:number, removed:number}>}
 */
const reconcileRoster = async members => {
  const byQq = new Map()
  for (const m of members) {
    const qq = String(m?.qq ?? "").trim()
    if (qq) byQq.set(qq, String(m?.nick ?? "").trim())
  }
  const bindStore = await store()
  const renamed = []
  const gone = []
  for (const [sheet, list] of Object.entries(bindStore.data.binds ?? {})) {
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      if (!row) continue
      if (!byQq.has(String(qq))) {
        gone.push({ sheet, row, qq })
        continue
      }
      const nick = byQq.get(String(qq))
      const old = String(info?.nickname ?? "").trim()
      if (nick && nick !== old) renamed.push({ sheet, row, qq, from: old, nick })
    }
  }
  if (!renamed.length && !gone.length) return { renamed: 0, removed: 0 }

  let removedRows = 0
  let plan = null

  await table().mutate(
    async ctx => {
      await snapshotBeforeWrite()

      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      const lockRows = state.locks

      /**
       * 1) 改名：直接改那一行的群昵称；绑定与锁上记的昵称一起换（否则归属就"对不上"了）
       *
       * 「帮帮完成情况」里记着他旧昵称的 token 一并跟着换（口径见 `statusRenamePlan`）：
       * 先按改之前的表算，再写昵称——写完这一行就不叫旧昵称了，唯一性判定会落空。
       * 同一次同步里改多行时，逐条叠加（`statusOf` 让后面几条看得到前面几条的结果）。
       */
      const statusWritten = new Map()
      for (const r of renamed) {
        const model = ctx.model(r.sheet)
        const plan = statusRenamePlan(model, {
          row: r.row,
          from: r.from,
          to: r.nick,
          qq: r.qq,
          binds: bindView(binds),
          statusOf: row => (statusWritten.has(row.row) ? statusWritten.get(row.row) : row.status),
        })
        for (const c of plan.changes) {
          statusWritten.set(c.row, c.status)
          if (model.col?.status) ctx.setCell(r.sheet, c.row, "status", c.status)
        }
        if (plan.skipped) console.log(`[editor] 群名单同步改名：${plan.skipped}`)
        if (model.col?.nickname) ctx.setCell(r.sheet, r.row, "nickname", r.nick)
        bindSet(binds, r.sheet, r.qq, { row: r.row, nickname: r.nick })
        renameLock(lockRows, r.sheet, r.row, r.nick)
      }

      /** 2) 退群：按榜分组，删行 + 压紧 */
      const bySheet = new Map()
      for (const g of gone) {
        if (!bySheet.has(g.sheet)) bySheet.set(g.sheet, [])
        bySheet.get(g.sheet).push(g.row)
      }

      /** 先把各榜的 drop / 位移算出来：迁移绑定与锁都只读这一份，不再回头改表 */
      const moves = new Map()
      for (const [sheet, rows] of bySheet) {
        const model = ctx.model(sheet)
        const drop = new Set(rows.map(Number))
        const shift = new Map()
        let kept = 0
        for (let r = model.dataStart; r <= model.dataEnd; r++) {
          if (drop.has(r)) continue
          shift.set(r, model.dataStart + kept)
          kept++
        }
        moves.set(sheet, { model, drop, shift })
      }

      /** 绑定：QQ 是身份，按 QQ 迁移，压紧后整体替换（不会撞键） */
      for (const [sheet, { drop, shift }] of moves) {
        for (const [qq, info] of Object.entries(binds[sheet] ?? {})) {
          const row = Number(info?.row)
          if (!row) continue
          if (drop.has(row)) {
            delete binds[sheet][qq]
            continue
          }
          if (shift.has(row) && shift.get(row) !== row) binds[sheet][qq] = { ...info, row: shift.get(row) }
        }
        if (binds[sheet] && !Object.keys(binds[sheet]).length) delete binds[sheet]
      }

      /**
       * 锁：从不可变旧快照（lockRows）生成全新的对象，迁移完整体替换，
       * 并且**校验归属** —— 锁上记的人必须就是被搬走那一行上的人，否则作废
       */
      const nextLocks = {}
      for (const [key, lock] of Object.entries(lockRows)) {
        const sheet = lockSheetOf(key)
        const row = lockRowOf(key)
        const move = moves.get(sheet)
        if (!move) {
          nextLocks[key] = lock
          continue
        }
        if (move.drop.has(row) || !move.shift.has(row)) continue
        const atRow = String(move.model.rows.find(r => r.row === row)?.nickname ?? "").trim()
        const nick = String(lock?.nickname ?? "").trim() || atRow
        /** 锁错人比不锁更糟：归属对不上就丢掉，让主播重新填一次 */
        if (nick && atRow && nick !== atRow) continue
        const to = lockKey(sheet, move.shift.get(row))
        if (nextLocks[to]) continue
        nextLocks[to] = { ...lock, ...(nick ? { nickname: nick } : {}) }
      }

      for (const [sheet, { model, drop }] of moves) {
        const out = await compactSheet(ctx, model, [...drop])
        removedRows += out.removed
        console.log(`[editor] 群成员退群，已从「${sheet}」删掉 ${out.removed} 行并压紧（${out.moved} 行上移）`)
      }

      plan = { binds, locks: nextLocks }
      return { renamed: renamed.length, removed: removedRows }
    },
    { afterCommit: info => persistState(info, plan) },
  )

  if (renamed.length)
    console.log(
      `[editor] 按群名单同步群昵称：` + renamed.map(r => `${r.sheet} 第 ${r.row} 行「${r.from}」→「${r.nick}」`).join("；"),
    )
  return { renamed: renamed.length, removed: removedRows }
}

/* ------------------------------ HTTP ------------------------------ */

/**
 * HTTP 层的三块都在 `editor/http/` 下，这里只做装配（与 acl / versions / ownership 同一套工厂写法）：
 *   - `respond.js`：`json` / 读请求体 / 取口令 / `FEATURES`（纯函数，不碰业务与配置）
 *   - `auth.js`：口令、身份签名、主人与白名单（`createAuth`）
 *   - `pages.js`：三个提示页 + 页脚（`createPages`）
 * 路由与业务编排仍在本文件（见下面的 `server`）。
 */
const { applySecurityHeaders, json, readBody, readRawBody, FEATURES, BodyTooLarge } = await import("./http/respond.js")

const { authorized, callerOf, canManageAdmins, roleOf } = createAuth({
  token: TOKEN,
  adminToken: ADMIN_TOKEN,
  signKey: SIGN_KEY,
  loadAdmins,
  loadOwners,
  verifyIdentity,
})

/**
 * 链接认领（`editor/claims.js`）：一条链接由第一台打开它的设备认领，其余设备只能看
 *
 * 它建在身份签名**之上**——先由 `auth.js` 把链接身份验出来（30 天有效的 `u/s`），
 * 再看这条链接有没有被别的设备认领过。认领记录落在 `<数据目录>/abyss-editor-claims.json`。
 */
const claims = createClaims({ file: CLAIMS_FILE, signKey: SIGN_KEY })

/**
 * 每个请求**只判一次身份**，判完就记住
 *
 * 为什么必须记住：认领判定会**往响应里种设备 cookie**，而审计（`audit.js`）与路由都要问身份。
 * 各问一次就会出现"审计那一次又被当成新设备、再种一个 cookie"（`res` 已经写完，轻则审计记的是
 * 另一个人，重则 `ERR_HTTP_HEADERS_SENT`）。`dict` 的 key 是 `req`，一个请求一份结果。
 */
const resolvedCallers = new WeakMap()
const callerNow = req => {
  if (!resolvedCallers.has(req)) resolvedCallers.set(req, { value: callerOf(req), windowed: false })
  return resolvedCallers.get(req)
}

/**
 * 写操作的请求级审计（一行一条，见 `editor/audit.js`）
 *
 * 出口：宿主注入的框架 logger（有时间戳与等级）；独立跑时回落到 `console`，
 * 而独立跑的 `setupLogFile` 会把 console 同时写进 `data/editor.log`。
 */
const auditLog = makeAuditLog({ log: injectedLog() ?? (line => console.log(line)), callerOf: req => callerNow(req).value })

const { footerHtml, denialPage, ownerOnlyPage, expiredLinkPage } = createPages({ footHtml: FOOTER_HTML })

/**
 * 问一下云端现在是哪一版表（推表前用）
 *
 * 拿不到就返回空串：云端还没有 /api/version 时，推表照旧（不带版本 = 不做冲突检测），
 * 不能因为一个接口取不到就把"上传覆盖云端"整个弄坏。
 *
 * 云端这条也是**经过认领那一层**的：主人打开本机编辑器时带的就是他自己那台设备的 cookie
 * （同一个浏览器、同一个域名），原样转发给云端的 `/api/version` 与 `/api/upload`，
 * 云端才认得出"这是主人本人"，而不是"一条别人的链接"。
 */
const cloudVersion = async req => {
  try {
    const res = await fetch(`${CLOUD_URL}/api/version?k=${encodeURIComponent(TOKEN)}`, {
      headers: req?.headers?.cookie ? { cookie: String(req.headers.cookie) } : {},
      signal: AbortSignal.timeout(15000),
    })
    const out = await res.json()
    return res.ok && out?.ok ? String(out.version ?? "") : ""
  } catch (err) {
    console.warn(`[editor] 取云端版本失败（推表将不做冲突检测）：${err?.message ?? err}`)
    return ""
  }
}

/**
 * 请求处理器：**独立进程与"挂在 bot 的 server 上"共用同一个入口**
 *
 * 它只做 `(req, res)` 这一件事，**不 listen** —— 谁挂它、挂在哪，由调用方决定
 * （独立进程见文件末尾的 `startEditor()`）。
 *
 * 挂载注意：它按 `req.url` 里的**完整路径**（含挂载前缀）自己路由，所以宿主**不要剥前缀**——
 * 在 bot 的 express 上要挂成"根级中间件 + 自己按前缀过滤"，不能用 `app.use("/queue", handler)`，
 * 那会把前缀吃掉、编辑器认不出来。
 */
export const handler = async (req, res) => {
  /**
   * 安全响应头在**路由之前**设好：301 / 403 / 410 / 500 这些提前返回的路径也全部带上
   * （三个头是什么、为什么不加整份 CSP，见 `http/respond.js` 的 `SECURITY_HEADERS`）
   */
  applySecurityHeaders(res)
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  const pathname = innerPath(url.pathname)
  /** 审计：非 GET 的请求在响应结束时记一行（成功与失败都记；行里**不含** query，所以不会带口令） */
  auditLog.install(req, res, pathname)

  /**
   * 尾斜杠规范化：`<前缀>` → `<前缀>/`（301）
   *
   * 首页里的请求全是**相对路径**（`api/data`、`api/meta`、`font/cn.woff`）：地址栏不以 `/` 结尾时，
   * 浏览器会把它们解析到**站根**（`/api/data`），在子路径部署下就是一连串 404（数据、字体、页脚全没了）。
   * 把规范形式固定下来，页面自己不用再拼前缀。
   */
  if (pathname === "/" && url.pathname.length > 1 && !url.pathname.endsWith("/")) {
    res.writeHead(301, { location: `${url.pathname}/${url.search ?? ""}`, "cache-control": "no-store" })
    return res.end()
  }

  /**
   * 短链：`<editor_url>/s/<码>` → 换成带身份的长地址再跳过去
   *
   * 群里发的是这个短链（机器人用 signTicket 签的，见 model/identity.js）：
   * 码只有 16 个字符、看不出结构（QQ 经置换 + MAC），群名片在这里按 QQ 从群名单补上，
   * 所以链接能短到四十来个字符。
   * 这一步**先于口令校验**：码本身就是凭证，验过才换到带 `k=` 的地址；
   * 验不过就给一页"回群里重新发 #排队"，而不是落回"输入口令"那页（免得让人以为口令错了）。
   */
  if (req.method === "GET" && (pathname === `/${SHORT_PATH}` || pathname.startsWith(`/${SHORT_PATH}/`))) {
    let code = ""
    try {
      code = decodeURIComponent(pathname.slice(SHORT_PATH.length + 2))
    } catch {}
    const ticket = verifyTicket(code, SIGN_KEY)
    /**
     * 短链上那段**签发时刻 + 发送者群昵称**（`?t=&ts=&n=`，机器人发链接时签的，见 `model/identity.js`
     * 的 `signFreshness`）：验得过就用它当身份的签发时间——认领层靠这个判"谁手里那条更新"
     * （主人重新发一次 `#排队` 就该抢回被先点者占住的写权限）。**没带或验不过**（旧链接）退回短码
     * 自己的窗口时间，行为与以前一字不差；`n` 一起作废（验不过的昵称一个字都不采信）。
     *
     * **群昵称**：`n` 是**发链接那一刻**发送者的群名片。正常路径仍然是"按 QQ 从群名单里现取"
     * （名单是每天推的，名字最准），只有在名单里查不到这个 QQ 时才用它兜底——现场是主人第一次点
     * 自己的链接、云端群名单里没有他，身份昵称空成一片，页面认不出"自己那一行"。
     */
    const linkNick = decodeLinkNick(url.searchParams.get("n"))
    const freshAt = ticket
      ? verifyFreshness(code, url.searchParams.get("t"), url.searchParams.get("ts"), SIGN_KEY, {
          ttl: IDENTITY_TTL,
          nick: linkNick,
        })
      : 0
    const id = ticket
      ? signIdentity({ qq: ticket.qq, nick: (await nickOf(ticket.qq)) || (freshAt ? linkNick : "") }, SIGN_KEY, freshAt || ticket.issuedAt)
      : null
    if (!id) {
      res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(expiredLinkPage())
    }
    const params = new URLSearchParams()
    if (TOKEN) params.set("k", TOKEN)
    params.set("u", id.u)
    params.set("s", id.s)
    /**
     * 顺手把**这一次**的时间窗签进去（`w/ws`）：短码本身按 30~60 天窗口存活，
     * 而"点开之后这条链接还能用多久"由这 5 分钟窗口说了算——机器人每 5 分钟换一批短码，
     * 上一批就算有人留着，点开时签出来的窗口也已经作废（`verifyWindow` 只认当期与上一期）。
     */
    const win = signWindow({ qq: ticket.qq }, SIGN_KEY)
    if (win) {
      params.set("w", win.w)
      params.set("ws", win.ws)
    }
    /**
     * 跳回哪一段路径：请求里带了前缀（nginx 原样转发）就用请求里那段，否则用挂载配置
     * （nginx 把前缀剥掉、或本机挂在根目录 `/` 时，请求里没有前缀可依）
     */
    const at = url.pathname.lastIndexOf(`/${SHORT_PATH}/`)
    const prefix = at > 0 ? url.pathname.slice(0, at) : MOUNT
    res.writeHead(302, { location: `${prefix}/?${params}`, "cache-control": "no-store" })
    return res.end()
  }

  /**
   * 网页标签页图标（favicon）——**先于口令校验**
   *
   * 浏览器请求 favicon 时**不带 `?k=`**（页面口令存在 localStorage 里，不是 cookie），
   * 所以这条必须排在 `authorized()` 之前，否则正式部署会拿到 403、标签页图标根本不显示。
   * 它只是随插件入库的一张图（`resources/image/`），不含任何数据，公开无妨。
   *
   * **为什么用 256 那版**：favicon 会被浏览器按 16/32/48 画到标签页，还会被"固定到任务栏"
   * 或当 apple-touch-icon 用（可达 180），64 那版在这些位置只能靠插值放大、发虚。
   * 代价是首次访问多下 ~264KB（`max-age=86400`，之后一天内走缓存）；
   * 面板那边的图标由锅巴直接读 64 那版（显示尺寸小，够用）。
   *
   * 按自己算出的插件根去读，**不需要单独的启动参数**；两份都拿不到时回落 64 那版，再不行 404。
   */
  if (req.method === "GET" && pathname === "/favicon.ico") {
    const candidates = ["HuTao_LeLouvre_256.ico", "HuTao_LeLouvre.ico"]
    for (const name of candidates) {
      try {
        const buf = await fsp.readFile(path.join(PLUGIN_DIR, "resources", "image", name))
        res.writeHead(200, {
          "content-type": "image/x-icon",
          "content-length": String(buf.length),
          "cache-control": "public, max-age=86400",
        })
        return res.end(buf)
      } catch {
        /* 换下一份候选 */
      }
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    return res.end("favicon unavailable")
  }

  if (!authorized(req)) {
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(denialPage())
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("forbidden")
  }

  /**
   * 链接的**时间窗**：只认带 `w/ws` 的链接（以及"认领过这条链接的那台设备"）
   *
   * 身份签名（`u/s`）管 30 天，这层窗口管 5 分钟（`model/identity.js` 的 `WINDOW_MS`）：
   * 机器人每 5 分钟换一批链接，旧链在路上超过一个窗口就作废。过期时刻**签在链接里**
   * （`w/ws`），所以这里不需要服务器记住"这条链是什么时候发的"。
   *
   * 四层共存时谁先说话：
   *   1. 短链 `/s/<码>`：码本身就是凭证，按它自己的 30~60 天窗口判（那条路由不在这里）；
   *   2. 设备 cookie（认领记录，见 `editor/claims.js`）：认领过的设备**不必**再带窗口，
   *      管理员 24 小时内、群友本次会话内直接就是那个身份；
   *   3. 带 `w/ws`：验不过就**拒绝**（410 + 可读页）——旧窗口的链接一律作废，即便同一台设备；
   *   4. **没带 `w/ws` 的身份链接：只放行"认领过这条链接的那台设备"**，其余一律 410。
   *
   * 第 4 条是本阶段落地的：上一阶段为兼容放过"不带 `w/ws` 的老链首次仍可认领"，
   * 那等于给已经发出去的旧链接留了 30 天口子。现在只认带 `w/ws` 的链接。
   *
   * **为什么还要给认领过的设备留口子**：编辑器页面自己不带窗口——它打开链接时把 `k/u/s/a` 收进
   * 存储、把地址栏清干净（见 `editor.html` 的 `withToken()`），之后每一次 `/api/*` 都只带身份不带窗口；
   * 首页刷新时那条"从存储里拼回地址栏"的路（`http/pages.js` 的 `denialPage`）也一样。
   * 那些请求都带**认领时种下的设备 cookie**，所以"这台设备就是这条链接的主人"是能验的
   * （`claims.holderOf` 按 cookie 反查，签名里绑着具体哪条链接）。真正的转发链接没有这份 cookie，
   * 一律落到 410 那一侧。
   *
   * 拒绝给的是 410 + 可读页面（与短链失效同一份文案）：拿到旧链的人需要知道的是
   * "回群里重新取一条"，而不是"口令错了"。
   */
  {
    const w = url.searchParams.get("w") ?? ""
    const ws = url.searchParams.get("ws") ?? ""
    if (w || ws) {
      const linkQq = String(decodeIdentity(url.searchParams.get("u") ?? "")?.qq ?? "")
      if (!verifyWindow(w, ws, { qq: linkQq }, SIGN_KEY)) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        return res.end(expiredLinkPage())
      }
      /**
       * 记一笔"这条链接带的是当期的窗口"（只作诊断用）
       */
      callerNow(req).windowed = true
    } else if (url.searchParams.has("u")) {
      /**
       * 没带 `w/ws` 却有身份：只认**认领过这条链接的那台设备**
       *
       * 判据用**验签过的**身份（`callerNow()` 里的 `identity`），不是 `u` 里解出来的 QQ：
       * 伪造 `u`（签名对不上）的请求本来就什么权限都拿不到——它连认领键都算不出来（键里要有 QQ），
       * 到这里当成"没有身份"放过去，由 `auth.js` / 认领那一层按访客处理，而不是给失效页
       * （否则"签名被改过"与"链接过期"这两种情况就分不出来了）。
       *
       * **机器人身份（`ROSTER_QQ`）豁免这一条**：名单推送 / 每日整理 / 插队都是机器人**代签**
       * 的一次性请求，没有"设备"可认领，而这份签名只有插件有（`model/roster.js` 的 `ROSTER_QQ`）。
       * 插件侧现在也会带时间窗（`model/identity.js` 的 `signedEditorQuery`），两道一起上：
       * 窗口挡别人，豁免挡"机器人自己因为时钟/旧版本没带上窗口"——2026-10 复审 §2-#1 就是
       * 名单同步与每日整理被这条闸 410 挡死（当时插件侧没带窗口、编辑器侧测试还替它补上了）。
       */
      const linkQq = String(callerNow(req).value.identity?.qq ?? "")
      const fromBot = Boolean(linkQq) && linkQq === ROSTER_QQ
      const holder = linkQq && !fromBot ? claims.holderOf(req) : null
      if (linkQq && !fromBot && String(holder?.qq ?? "") !== linkQq) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        return res.end(expiredLinkPage())
      }
    }
  }

  /**
   * 链接**认领**：这条链接归第一台打开它的设备
   *
   * 判定与"为什么这么设计"见 `editor/claims.js`；这里只负责把它接在路由前：
   *   - 认领者是本设备 → 身份与角色照旧（管理员 24 小时 cookie / 群友会话 cookie）；
   *   - 认领者是别的设备 → **降级为只读访客**（写接口一律 403），链接本身还能打开看。
   *
   * 认领键用**链接自己的 30 天签发窗口**：短链展开成长链时身份是现签的，
   * 长链按身份里的签发时间算同一个量（`model/identity.js` 的 `TICKET_WINDOW_MS`）。
   * 拿不到稳定 QQ 的链接（只有口令、没有身份）没有认领这回事。
   */
  {
    const state = callerNow(req)
    const linkQq = String(state.value.identity?.qq ?? "")
    /** 认领键一律由**链接自己**说了算；设备反查只用来回答"这条链接是不是我的" */
    const holder = linkQq ? null : claims.holderOf(req)
    /**
     * 认领过的设备再回来（页面早把地址栏清干净了，请求里没有 `u/s`）
     *
     * 这就是"管理员 24 小时内不必再带链接"：按设备反查出来的身份**现算**角色
     * （白名单随时可改，所以状态里不存角色），再把 cookie 续期一次——不续的话
     * 那 24 小时是"从第一次认领起算"，续期才是"每次回来都往后推"。
     */
    if (holder) {
      const role = roleOf({ qq: holder.qq })
      const nick = await nickOf(holder.qq)
      state.value = { ...state.value, identity: { qq: holder.qq, nick: String(nick ?? ""), issuedAt: holder.epoch * TICKET_WINDOW_MS }, ...role }
      claims.touch(req, res, { key: holder.key, qq: holder.qq, role: state.value.role })
      /** 页面要拿这份令牌自己存下来（cookie 被挡的 webview 靠它认设备，见 claims.js 的 DEVICE_HEADER） */
      state.deviceToken = claims.tokenOf(holder.entry.device, holder.key, holder.qq)
    } else {
      /**
       * 反查出来的那条键可能来自上一个 30 天窗口——那时两条键都指向同一台设备，
       * 续期的是**当前这条**（否则等于认领记录永远停在旧窗口上）。
       */
      const key = claimKeyOf({
        qq: linkQq,
        /**
         * 用途按**链接身份自己**的角色分（不是按这次请求最终落到谁头上——那会把
         * "新来的、还没认领的人"也算成 member，管理链接会被记成普通链接）。
         * 同一条链接只可能有一种用途（角色是身份算出来的）。
         */
        purpose: roleOf(state.value.identity).role === "admin" ? "admin" : "member",
        epoch: Math.floor((Number(state.value.identity?.issuedAt) || 0) / TICKET_WINDOW_MS),
      })
      const out = claims.resolve({
        req,
        res,
        caller: state.value,
        key,
        roleOf,
        nickOf,
        /** 这条链接的**签发时刻**：认领层用它判"谁手里那条更新"（够新才能接管，见 claims.js） */
        issuedAt: Number(state.value.identity?.issuedAt) || 0,
      })
      state.value = out.caller
      /** 这次认领 / 续期拿到的设备令牌（给页面注入；降级成访客时是空串，不给） */
      state.deviceToken = out.device ? claims.tokenOf(out.device, key, linkQq) : ""
      if (out.caller.downgraded && !state.deniedLogged) {
        state.deniedLogged = true
        console.warn(`[editor] 这条链接已被别的设备认领，本次按只读访客处理（qq=${linkQq || "-"}，${pathname}）`)
      }
    }
  }

  /**
   * 只给主人用（本机编辑器用这个开关开着）
   *
   * 本机那份是云端数据的备份/工作副本，只让主人碰：其他人一律挡在门外，
   * 免得群友在本机界面上改到备份、又被传回云端。
   * 例外是几个**只读且不含表格数据**的口子，它们本来就只凭口令放行：
   *   - `/api/snapshot`：机器人拉快照
   *   - `/api/version`：推表前问一版（只回表指纹）
   *   - `/api/meta`：页面元信息（页脚 HTML / 版本 / 版本份数）——不给的话"需要口令"页也拉不到页脚
   *   - `/healthz`：启动器 / 运维探活
   */
  if (
    OWNER_ONLY &&
    pathname !== "/api/snapshot" &&
    pathname !== "/api/version" &&
    pathname !== "/api/meta" &&
    pathname !== "/healthz"
  ) {
    const owner = callerNow(req).value
    if (!owner.owner && !owner.adminTokenOk) {
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" })
        return res.end(ownerOnlyPage())
      }
      return json(res, 403, { ok: false, error: "本机编辑器只有主人能打开；群友请用群里 #排队 拿到的链接（云端编辑器）" })
    }
  }

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await fsp.readFile(TEMPLATE, "utf8")
      /**
       * 模板里的 `__MOUNT__` 换成**这次请求实际带的前缀**（nginx 原样转发时就是它；剥掉前缀时是空串，
       * 那时图标就是 `/favicon.ico`）。页面里的图标 href 因此不再是"站根绝对路径"——
       * 挂在 `/queue` 下时指到站根会被框架 404，那条路径不归编辑器。
       */
      const prefix = String(url.pathname)
        .replace(/\/+$/, "")
        .replace(/\/index\.html$/, "")
      /**
       * `__DEVICE__` 换成这台设备的令牌（认领时算出来的，见认领那一段）：
       * 页面存下来之后每次 `/api/*` 用 `x-abyss-device` 带上——cookie 被内置浏览器挡掉时，
       * 这是页面自己那串请求能证明"这台设备认领过这条链接"的唯一办法。
       * 没认领（访客 / 只带口令 / 已被别的设备认领）时是空串，页面就不带这个头。
       *
       * `__WHO__` 是**这条链接的 QQ**（认领块算出来的 `identity.qq`）：页面拿它把设备令牌**按人**存在
       * 浏览器里。只存一条的话，"先开过 A 的链接、再开 B 的链接"就会把 A 的令牌发给 B
       * （服务端一律 410——现场：PC 上打开别人的链接报"读取失败"）。降级访客这里是空串，
       * 于是它一个旧令牌都不会带，老老实实靠时间窗只读浏览。
       */
      const deviceToken = String(callerNow(req).deviceToken ?? "")
      const who = String(callerNow(req).value.identity?.qq ?? "")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(
        html.replaceAll("__MOUNT__", prefix).replaceAll("__DEVICE__", deviceToken).replaceAll("__WHO__", who),
      )
    }

    /**
     * 表格快照：把当前 xlsx 原样吐出来，给机器人当**只读数据源**
     *
     * 机器人不碰本地文件，每次按 TTL 从这里拉一份；这里是全量取（不按身份裁剪），
     * 所以同样要口令 —— `?k=<ABYSS_EDITOR_TOKEN>`。
     */
    if (req.method === "GET" && pathname === "/api/snapshot") {
      const buf = await fsp.readFile(xlsxPath)
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-length": String(buf.length),
        "cache-control": "no-store",
      })
      return res.end(buf)
    }

    /**
     * 编辑器页面的中文字体（原神标准字体：汉仪文黑-65W）
     *
     * 字体**随源码入库**（`resources/common/font/`，与 Axiu-Plugin / Atlas-Plugin 同位置），
     * 这里只是把它按固定路径吐出去，**没有任何下载或缓存逻辑**；
     * 拿不到就 404，页面自动回落到系统中文（英文数字由页面的 Times New Roman 负责）。
     */
    if (req.method === "GET" && pathname === "/font/cn.woff") {
      try {
        const buf = await fsp.readFile(path.join(PLUGIN_DIR, "resources", "common", "font", "HYWH-65W.woff"))
        res.writeHead(200, {
          "content-type": "font/woff",
          "content-length": String(buf.length),
          "cache-control": "public, max-age=604800",
        })
        return res.end(buf)
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        return res.end("font unavailable")
      }
    }

    /**
     * 当前表版本（只凭口令，和 /api/snapshot 一样）
     *
     * "本机 → 云端"推表之前先问一句云端现在是哪一版，再由上传把它带回来：
     * 中间要是有人改过云端，上传会被拒（冲突），而不是把别人的改动盖掉（AQ-06）。
     */
    if (req.method === "GET" && pathname === "/api/version")
      return json(res, 200, { ok: true, version: await table().fingerprint() })

    /**
     * 页面元信息：**只凭口令**（与 /api/version、/api/snapshot 同一档）
     *
     * 只回"画页面要用"的东西，不碰表格数据：
     *   - `footer`：插件配置 `footer.html` 的自由 HTML + 编辑器追加的**规范署名行**（空串 = 不显示页脚）。
     *     它是维护者自己写的内容，不是群友输入，所以前端**故意用 innerHTML 插进去**；
     *     别把用户可控的字符串接到这里（那等于给公网页面开一个 XSS 口子）。
     *   - `versionsKeep`：页面上「历史版本」那句提示里的份数。
     *
     * 为什么不并进 /api/data：那一份是表格数据（含按身份裁剪的行），
     * 而页脚在"还没有表格数据"时也该画得出来；分开也让这个响应天然可缓存。
     */
    if (req.method === "GET" && pathname === "/api/meta")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        footer: footerHtml(),
        versionsKeep: VERSIONS_KEEP,
      })

    /** 身份判定**只用一份**（认领那一关已经判过并按结果降级，见上面的 `resolvedCallers`） */
    const caller = callerNow(req).value
    /** 手动收录名单（「帮帮完成情况」的临时成员）：首个请求读一次，之后走内存 */
    await ensureExtraNames()
    if (req.method === "GET" && pathname === "/api/data") {
      /**
       * 先确认绑定/锁是**对着这一版表**的（整表替换或外部改表之后就不是了）：
       * 对不上就按群昵称重新对账，绝不拿旧行号认人（AQ-03）
       */
      await alignOwnership()
      /** 再按 QQ 认人（顺手同步改了名片的昵称、记下绑定），最后按身份裁剪数据 */
      const sync = await syncIdentity(caller)
      /** 管理员打开时，把表里手填、下拉里没有的名字归档成选项 */
      const archived = await archiveOptions(caller)
      /** 管理员打开时，到点的榜把残留的「等待开启」翻成「排队中」 */
      const opened = await catchUpOpenStatus(caller)
      const payload = await buildPayload(caller)
      return json(res, 200, { ...payload, sync: { ...sync, archived, opened } })
    }

    if (req.method === "POST" && pathname === "/api/save") {
      /**
       * **先判角色再读请求体**：访客（只有口令、没有签名身份）一条也写不了，
       * 角色判定又不用看 body —— 先读就等于白白替没权限的人扛带宽与内存。
       * 判不出权限的接口（比如上传）才只能先读。
       */
      if (caller.role === "guest")
        return json(res, 403, {
          ok: false,
          error: "这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）",
        })
      const body = await readBody(req)
      const out = await applySave(caller, body)
      auditLog.note(req, {
        sheet: body?.sheet,
        rows: Array.isArray(body?.rows) ? body.rows.length : undefined,
        written: out?.written,
        cleared: out?.cleared,
      })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 插队：把某一行挪到它上方最近的一位「排队中」前面（`#插队` 调的就是这里）
     *
     * 位置由**编辑器**算（插件只给"哪一榜、哪一行、怎么挪"）：见 `applyMoveRow`。
     * 权限只认白名单管理员 / 主人；本人与访客一律 403——一条消息就能改全表的顺序，
     * 不该由"能改自己那一行"的身份来触发。
     */
    if (req.method === "POST" && pathname === "/api/move-row") {
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有白名单管理员可以插队" })
      const body = await readBody(req)
      const out = await applyMoveRow(caller, body)
      auditLog.note(req, { sheet: body?.sheet, row: body?.row, from: out?.from, to: out?.to, moved: out?.moved })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 每日整理：把「已完成」的人前移、「排队中」的人后移（「等待开启」当挡位不动）
     *
     * 位置与顺序都由**编辑器**算（见 `applyTidy` / `tidyOrder`）；插件每天到点调一次。
     * 权限与 `/api/roster` 同一套：**机器人身份**（插件签的 `ROSTER_QQ`）或主人——
     * 一次就能重排全表，不该由"能改自己那一行"的身份来触发。
     */
    if (req.method === "POST" && pathname === "/api/tidy") {
      const fromBot = Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ
      if (!fromBot && !canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有机器人或主人能整理表格" })
      const body = await readBody(req)
      const out = await applyTidy(caller, body)
      auditLog.note(req, { sheet: body?.sheet, moved: out.moved })
      return json(res, 200, { ok: true, ...out })
    }

    /** 表头上方的「主播列表」：只有白名单管理员能改（带 `version` 就做版本冲突检测） */
    if (req.method === "POST" && pathname === "/api/anchors") {
      /** 同上：不是管理员就没必要先收请求体（角色判定不用看 body） */
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有白名单管理员可以改主播列表" })
      const body = await readBody(req)
      const out = await applyAnchors(caller, body)
      auditLog.note(req, {
        sheet: body?.sheet,
        rows: Array.isArray(body?.rows) ? body.rows.length : undefined,
        inserted: out?.inserted,
      })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 「帮帮完成情况」的手动收录（白名单管理员 / 主人）
     *
     * 用于收录**临时成员**：既不在主播区、也不是这一行的本人（例如临时帮忙打了一次的朋友）。
     * POST { sheet, name } → 记进表旁的收录名单；从此这一列的下拉里就有他，
     * 而且**不会被"候选净化"清掉**（净化只清表里那份下拉验证的残留，见 mergeStatusOptions）。
     */
    if (req.method === "POST" && pathname === "/api/status-names") {
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有白名单管理员可以收录名字" })
      const body = await readBody(req)
      const sheetName = String(body?.sheet ?? "").trim()
      if (!sheetName) return json(res, 400, { ok: false, error: "缺少 sheet" })
      try {
        const names = await addExtraName(sheetName, body?.name)
        auditLog.note(req, { sheet: sheetName, name: body?.name, names: names?.length })
        return json(res, 200, { ok: true, names })
      } catch (err) {
        return json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    }

    /**
     * 归属状态（**主人专用**，与 /api/admins 同一口径）
     *
     *   GET  → 当前 QQ → 行 的绑定到底还可不可信（stale / conflict / 记的昵称 vs 表里现在的昵称）+ 锁的摘要
     *   POST { action: "rebuild" } → 按当前表 + 群名单重建（能确认的保留、对不上账的作废），回报做了什么
     *
     * 为什么不给表加"稳定成员 ID"列（方案 B）与这个接口补上了什么，见 editor/README.md。
     * 权限**只认主人**：白名单管理员与本人链接都拿不到（他们要么不该看到全表的归属，
     * 要么本来就只该看到自己那一行）。
     */
    if (pathname === "/api/ownership") {
      if (!canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有主人能查看 / 重建归属状态" })
      if (req.method === "GET") return json(res, 200, { ok: true, ...(await ownershipAudit()) })
      if (req.method === "POST") {
        const body = await readBody(req)
        const action = String(body?.action ?? "").trim()
        /** 只认显式动作：不写 action 就当参数错误，免得一个手滑的 POST 就把归属全重建了 */
        if (action !== "rebuild") return json(res, 400, { ok: false, error: '请求格式不对：需要 { action: "rebuild" }' })
        const out = await rebuildOwnershipNow()
        auditLog.note(req, { op: "rebuild", kept: out?.kept?.length, dropped: out?.dropped?.length })
        return json(res, 200, { ok: true, ...out })
      }
    }

    /**
     * 历史版本 + 归档清单（主人或管理口令）
     *
     * 版本目录默认是空的——从第一次写表开始攒，不预置任何版本。
     * 归档里：`queue-YYYY-MM.xlsx` = 每月最后一次修改；`queue-YYYY-MM-DD.xlsx` = 每日起始状态（只留最近几天）。
     */
    if (req.method === "GET" && pathname === "/api/versions") {
      if (!canManageAdmins(caller) && caller.role !== "admin")
        return json(res, 403, { ok: false, error: "只有主人或白名单管理员能看历史版本" })
      const st = fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath) : null
      return json(res, 200, {
        ok: true,
        keep: VERSIONS_KEEP,
        archiveDays: ARCHIVE_DAYS,
        dir: VERSIONS_DIR,
        archivesDir: ARCHIVES_DIR,
        current: st ? { at: st.mtime.toISOString(), size: st.size } : null,
        versions: listVersions(),
        archives: listArchives(),
      })
    }

    /**
     * 下载某个历史版本 / 归档（主人、管理口令或白名单管理员）—— 归档可以随身带走
     *
     * id 只允许是版本或归档目录里的文件名（挡掉路径穿越）。
     */
    if (req.method === "GET" && pathname === "/api/download") {
      if (!canManageAdmins(caller) && caller.role !== "admin")
        return json(res, 403, { ok: false, error: "只有主人或白名单管理员能下载历史版本/归档" })
      const id = path.basename(String(url.searchParams.get("id") ?? ""))
      /** 认不认这个文件名，只由 `editor/versions.js` 的两条正则决定（与列表/存版本同一份口径） */
      const target = resolveStoredFile(VERSIONS_DIR, ARCHIVES_DIR, id)
      if (!target.kind || !fs.existsSync(target.file)) return json(res, 404, { ok: false, error: `没有这一份：${id}` })
      const buf = await fsp.readFile(target.file)
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-length": String(buf.length),
        "content-disposition": `attachment; filename="${id}"`,
        "cache-control": "no-store",
      })
      return res.end(buf)
    }

    /**
     * 回退到某个历史版本（主人、管理口令或白名单管理员）
     *
     * 替换前会先把"当前状态"也存成一个版本，所以回退错了还能再退回来。
     */
    if (req.method === "POST" && pathname === "/api/restore") {
      if (!canManageAdmins(caller) && caller.role !== "admin")
        return json(res, 403, { ok: false, error: "只有主人或白名单管理员能回退版本" })
      const body = await readBody(req)
      const id = path.basename(String(body?.id ?? ""))
      if (!RE_VERSION.test(id)) return json(res, 400, { ok: false, error: "版本号不对" })
      const file = path.join(VERSIONS_DIR, id)
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: `没有这个版本：${id}` })
      const out = await replaceTable(await fsp.readFile(file), `历史版本 ${id}`, { expect: body?.version })
      auditLog.note(req, { version: id })
      return json(res, 200, { ok: true, restored: id, ...out })
    }

    /**
     * 覆盖当前表（云端上传入口，主人或管理口令）
     *
     * 本机编辑器把「本机那份表」直接 POST 上来：校验 → 存底（版本 + 归档）→ 原子替换。
     */
    if (req.method === "POST" && pathname === "/api/upload") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能覆盖云端表" })
      const bytes = await readRawBody(req)
      /** `?v=<读到的版本>`：上传方声明"我是照着哪一版改的"，对不上就报冲突，不覆盖别人刚提交的改动（AQ-06） */
      const out = await replaceTable(bytes, `上传的表（${caller.identity?.nick || caller.identity?.qq || "主人"}）`, {
        expect: url.searchParams.get("v") ?? "",
      })
      auditLog.note(req, { bytes: bytes.length, sheets: out?.sheets?.length })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 本机编辑器 → 云端：把本机这份表推上去覆盖云端（只有配了 --cloud 的本机才有）
     *
     * 认证用同一套口令与签名密钥：本机按调用者的身份重新签一次，云端验签后按主人放行。
     * **身份要连当期时间窗一起签**：云端只认带 `w/ws` 的身份链接（见「链接的时间窗」），
     * 只给 `u/s` 会被它按"旧链"挡在 410。
     * 推之前先问一下云端当前版本并原样带回去：中间云端有人写过就变成冲突，而不是把人家的改动盖掉。
     */
    if (req.method === "POST" && pathname === "/api/push-cloud") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能把本机的表传上云端" })
      if (!CLOUD_URL) return json(res, 400, { ok: false, error: "本机没配云端地址（--cloud / ABYSS_EDITOR_CLOUD）" })
      const bytes = await fsp.readFile(xlsxPath)
      const who = { qq: caller.identity?.qq ?? "", nick: caller.identity?.nick ?? "" }
      const id = signIdentity(who, SIGN_KEY)
      const win = signWindow(who, SIGN_KEY)
      /** 调用者的设备 cookie 原样转给云端：云端认得出"这是主人本人那台设备"，而不是一条别人的链接 */
      const forwarded = req.headers.cookie ? { cookie: String(req.headers.cookie) } : {}
      const remoteVersion = await cloudVersion(req)
      const target =
        `${CLOUD_URL}/api/upload?k=${encodeURIComponent(TOKEN)}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}` +
        (win ? `&w=${win.w}&ws=${encodeURIComponent(win.ws)}` : "") +
        (remoteVersion ? `&v=${encodeURIComponent(remoteVersion)}` : "")
      const res2 = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...forwarded },
        body: bytes,
        signal: AbortSignal.timeout(60000),
      })
      const text = await res2.text()
      let out = null
      try {
        out = JSON.parse(text)
      } catch {
        out = { ok: false, error: `云端返回了非 JSON（HTTP ${res2.status}）：${text.slice(0, 200)}` }
      }
      console.log(
        `[editor] 上传覆盖云端 ${CLOUD_URL}：HTTP ${res2.status} ${out?.ok ? "成功" : out?.error ?? ""}` +
          (remoteVersion ? `（推之前云端版本 ${remoteVersion.slice(0, 12)}）` : ""),
      )
      auditLog.note(req, { cloud: CLOUD_URL, cloud_status: res2.status })
      return json(res, res2.status === 200 && out?.ok ? 200 : 400, { ...out, cloud: CLOUD_URL })
    }

    /**
     * 群成员名单推送（机器人 → 编辑器）
     *
     * 只认机器人身份（ROSTER_QQ）或主人：成员拿不到机器人身份的签名，所以推不动。
     * 收到后就地按 QQ 对账：改名同步表里的群昵称；退群删行并压紧（删前自动存底）。
     */
    if (req.method === "POST" && pathname === "/api/roster") {
      const fromBot = Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ
      if (!fromBot && !canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有机器人或主人能推送群成员名单" })
      const body = await readBody(req)
      const members = Array.isArray(body?.members) ? body.members.slice(0, 5000) : null
      if (!members) return json(res, 400, { ok: false, error: "缺少 members" })
      /** 空名单绝不用于对账：那等于把绑定过的人都判成退群 */
      const previous = loadRoster()
      if (!members.length && (previous.members ?? []).length)
        return json(res, 400, { ok: false, error: "推来的是空名单，拒绝按它对账（先确认机器人取成员是否正常）" })

      saveRoster({ group: body?.group, members })
      const out = await reconcileRoster(members)
      auditLog.note(req, { group: body?.group, members: members.length })
      return json(res, 200, { ok: true, total: members.length, ...out, candidates: nickCandidates().length })
    }

    /** 白名单维护：主人（或管理口令 ?a=），普通管理员与个人链接都不行 */
    if (pathname === "/api/admins") {
      if (!canManageAdmins(caller))
        return json(res, 403, {
          ok: false,
          error: ADMIN_TOKEN ? "只有主人或管理口令能维护白名单" : "服务端没设主人名单（owner / --owner），无法维护白名单",
        })
      const audit = aclAudit()
      /** fromFile 是**原始条目**：历史昵称条目要能被主人删掉，所以不先过滤 */
      const fromFile = adminFileList("admins")
      const payload = {
        ok: true,
        admins: loadAdmins(),
        owners: loadOwners(),
        env: ENV_ADMINS,
        file: fromFile,
        /** 当不了权限的历史条目（群昵称等）+ "该改成哪个 QQ"的建议（仍要主人确认）（AQ-01） */
        ignored: audit.ignored,
        suggestions: audit.suggestions,
      }
      if (req.method === "GET") return json(res, 200, payload)
      const body = await readBody(req)
      const add = Array.isArray(body?.add) ? body.add : []
      const remove = Array.isArray(body?.remove) ? body.remove : []
      /** 加人只收 QQ：群昵称本人随时能改，收进来就等于留了一条越权口子（AQ-01） */
      const bad = add.map(s => String(s).trim()).filter(s => s && !aclQq(s))
      if (bad.length) {
        /**
         * 被拒的那几个值**当场去群名单里查一次 QQ**：填昵称的人多半就是"不知道 QQ"，
         * 只回一句"解析不出 QQ"等于让人自己去翻群资料。查得到就直说「要加就填这个号」，
         * 查不到（不在名单里 / 重名）就照旧只说规则。
         */
        const fresh = {}
        for (const name of bad) {
          const qq = rosterQqOfNick(name)
          if (qq) fresh[name] = qq
        }
        const merged = { ...audit.suggestions, ...fresh }
        const hints = Object.entries(fresh).map(([name, qq]) => `「${name}」在群名单里的 QQ 是 ${qq}，要加就填这个号`)
        return json(res, 400, {
          ok: false,
          error:
            `白名单只能填 QQ 号：「${bad.join("、")}」解析不出 QQ。` +
            "群昵称是可修改的展示名，不能当权限（改了名片就顶替别人的权限了）。" +
            (hints.length ? ` ${hints.join("；")}。` : ""),
          ignored: audit.ignored,
          suggestions: merged,
        })
      }
      const next = fromFile
        .map(s => String(s).trim())
        .filter(s => s && !remove.some(x => String(x).trim().toLowerCase() === s.toLowerCase()))
      for (const item of add) {
        const qq = aclQq(item)
        if (qq && !next.includes(qq) && !ENV_ADMINS.some(e => aclQq(e) === qq)) next.push(qq)
      }
      saveAdmins(next)
      auditLog.note(req, { add: add.length, remove: remove.length, admins: next.length })
      return json(res, 200, { ...payload, file: next })
    }

    /**
     * 健康检查：部署时用来确认服务活着，也用来确认"跑的是哪一版"（升级后忘了重启会在这里看出来）
     *
     * **只凭口令就能看**，所以这里不回吐服务器路径与云端地址（那两样对排障没帮助，泄露了反而多余）；
     * 只给布尔开关与计数。
     */
    if (req.method === "GET" && pathname === "/healthz")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        features: FEATURES,
        fields: FIELDS.map(f => f.key),
        bind: BIND,
        port: PORT,
        mount: MOUNT,
        auth: Boolean(TOKEN),
        sign_key: SIGN_KEY !== TOKEN,
        owner_only: OWNER_ONLY,
        /** 只数"能当权限的 QQ"（AQ-01）；解析不出来的历史昵称条目在 acl_invalid 里 */
        admins: loadAdmins().length,
        owners: loadOwners().length,
        acl_invalid: aclAudit().ignored.length,
        roster: (loadRoster().members ?? []).length,
        roster_group: loadRoster().group || "",
        versions_keep: VERSIONS_KEEP,
        archive_days: ARCHIVE_DAYS,
        admin_api: Boolean(ADMIN_TOKEN),
        aliases: compileAliases(config.anchor_aliases).length,
      })
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    /** 版本冲突（表在保存期间被换掉了）要能和普通参数错误区分开：409 + 明确提示（AQ-06） */
    /**
     * 请求体超限：错误响应本身就是"这次连接上的最后一句"，写完就断开。
     * 声明 `connection: close` 是为了让读不完的请求体到此为止（不关的话客户端会一直往里灌字节）
     */
    if (err instanceof BodyTooLarge) res.setHeader("connection", "close")
    json(res, err?.conflict ? 409 : 400, { ok: false, conflict: Boolean(err?.conflict), error: err?.message ?? String(err) })
  }
}

/**
 * 启动**独立进程**：fail-closed 检查 → 建 server → listen → 打启动横幅
 *
 * 直接 `node editor/editor.mjs` 时由文件末尾的守卫调用；被 import 时**什么都不做**——
 * 那一路（bot 把编辑器挂到自己的 server 上）用的是上面导出的 `handler`，与这里共用同一份路由。
 *
 * 两处硬检查（"开了主人专用却没有 owner" / "没配口令"）也收在这里，所以 **import 这个模块
 * 不会因为漏配而 `process.exit`**。
 *
 * @returns {import("node:http").Server} 已经 listen 的 server（调用方要关就关它）
 */
export function startEditor() {
  /**
   * 主人专用模式却没有主人名单 = 谁都进不来；没配口令 = 谁来都是管理员 —— 两种漏配都**拒绝启动**
   *
   * 与其让人对着 403 猜、或者干脆敞着门，不如启动时就把话说清楚（fail closed，不会因为漏配就放开）。
   * 注意"主人名单"现在只认 QQ（AQ-01）：只写群昵称等于没写。
   */
  if (OWNER_ONLY && !loadOwners().length) {
    const audit = aclAudit()
    console.error(
      `[editor] 开了「主人专用」但白名单里没有能用的 owner（${ADMINS_FILE}）：没人能打开。` +
        "请把主人的 **QQ 号**填进 owner（群昵称本人随时能改，不能当权限）" +
        (audit.ownerIgnored.length ? `。当前这些条目解析不出 QQ：${audit.ownerIgnored.join("、")}` : ""),
    )
    process.exit(1)
  }
  if (!TOKEN && !ALLOW_NO_TOKEN) {
    console.error(
      "[editor] 没配访问口令（--token / ABYSS_EDITOR_TOKEN）：这种状态下**任何人都能改表、覆盖云端、改白名单**。" +
        "已拒绝启动；本机测试要裸跑请显式加 --allow-no-token（或 ABYSS_EDITOR_ALLOW_NO_TOKEN=1）",
    )
    process.exit(1)
  }
  /**
   * 白名单里解析不出 QQ 的条目：权限只认 QQ，这些条目必须**当场说清楚**
   *
   * 否则表现是"配了那个人却进不来"（或者反过来，以为配了昵称就等于授权）。
   */
  {
    const audit = aclAudit()
    if (audit.ignored.length)
      console.warn(
        `[editor] 白名单里有 ${audit.ignored.length} 条解析不出 QQ 的历史条目，已**拒绝作为权限**（群昵称是可以随时改的展示名，不能当身份）：` +
          `${audit.ignored.join("、")}。请改填对应成员的 QQ 号；` +
          (Object.values(audit.suggestions).some(Boolean)
            ? `群名单里能对上的：${Object.entries(audit.suggestions)
                .filter(([, qq]) => qq)
                .map(([nick, qq]) => `${nick}→${qq}`)
                .join("、")}（确认无误再填）`
            : "群里发一次 #排队 让机器人推群名单后，页面上会给出候选 QQ"),
      )
  }

  const server = http.createServer(handler)
  server.listen(PORT, BIND, () => {
    console.log(`排队表编辑器已启动：http://${BIND === "0.0.0.0" ? "127.0.0.1" : BIND}:${PORT}`)
    console.log(`  版本：${pluginVersion}`)
    console.log(`  监听：${BIND}:${PORT}${BIND === "0.0.0.0" ? "（对外）" : "（仅本机）"}`)
    console.log(`  挂载前缀：${MOUNT || "（无，直接挂在根路径）"}`)
    console.log(
      `  数据目录：${DATA_BASE}${TEST_PATHS ? "（测试模式：ABYSS_EDITOR_TEST_PATHS=1，允许指到插件外）" : "（固定在插件内，不可配置）"}`,
    )
    console.log(`  表文件：${xlsxPath}`)
    console.log(`  口令：${TOKEN ? "已设置" : ALLOW_NO_TOKEN ? "未设置（--allow-no-token，任何人都能改，仅本机测试）" : "未设置"}`)
    console.log(
      `  身份签名密钥：${
        SIGN_KEY !== TOKEN
          ? "单独配置（推荐）"
          : "与口令相同 —— 只在「回环绑定 + ABYSS_EDITOR_TEST_PATHS=1」的本地兼容模式下才允许启动；" +
            "拿到链接的人能伪造别人的身份，正式部署请配 ABYSS_EDITOR_SIGN_KEY"
      }`,
    )
    /**
     * 本地兼容模式（复用口令当特权凭证）被放行时**必须当场说清楚**：
     * 配置文件放行的只是"起得来"，它没法告诉运营者"我现在正敞着哪一扇门"。
     */
    if (SHARED_SECRETS.length)
      console.warn(
        `[editor] 本机兼容模式（仅本机联调可用）：${SHARED_SECRETS.join("；")}。` +
          `放行条件是「回环绑定（当前 ${BIND}）+ ABYSS_EDITOR_TEST_PATHS=1」，两个条件缺一个都会被拒绝启动；` +
          "对外部署请另配独立的 --sign-key / --admin-token。",
      )
    console.log(`  白名单：${loadAdmins().length} 人（${ADMINS_FILE}）${aclAudit().ignored.length ? `；另有 ${aclAudit().ignored.length} 条解析不出 QQ 的条目已被拒绝作为权限` : ""}`)
    console.log(`  主人：${loadOwners().join(" / ") || "（未设置，白名单只能靠管理口令维护）"}`)
    console.log(`  主人专用：${OWNER_ONLY ? "是（其他人打不开，只有 /api/snapshot、/api/version 与 /healthz 放行）" : "否（按身份分权）"}`)
    console.log(`  历史版本：${VERSIONS_KEEP > 0 ? `保留最近 ${VERSIONS_KEEP} 份（${VERSIONS_DIR}）` : "已关闭"}`)
    console.log(`  归档：每月最后一次修改长期保留（最多 ${ARCHIVES_KEEP} 个月），每日归档只留最近 ${ARCHIVE_DAYS} 天（${ARCHIVES_DIR}）`)
    console.log(`  云端地址：${CLOUD_URL || "（未配置：本机没有「上传覆盖云端」入口）"}`)
    {
      const roster = loadRoster()
      console.log(
        `  群名单：${
          (roster.members ?? []).length
            ? `${(roster.members ?? []).length} 人（群 ${roster.group}，${new Date(roster.updatedAt).toLocaleString("zh-CN")}）`
            : "（还没有收到机器人推来的群成员名单）"
        }`,
      )
    }
    console.log(`  管理接口：${ADMIN_TOKEN ? "已启用（?a=<管理口令>）" : "未启用（主人仍可在「权限管理」里维护白名单）"}`)
    console.log(`  填写字段：${FIELDS.map(f => f.label).join(" / ")}`)
    console.log("  按任意键退出")
  })
  return server
}

/**
 * 只有**直接跑这个文件**时才自己 listen
 *
 * 被 import（bot 挂载那一路）时什么都不做。路径比较按平台来：Windows 大小写不敏感，
 * 不能直接拿字符串比，否则 `D:\Yunzai\...` 与 `d:\yunzai\...` 会被判成"不是入口"、编辑器干脆不启动。
 */
const SELF_PATH = fileURLToPath(import.meta.url)
const isMain = process.argv[1]
  ? process.platform === "win32"
    ? path.resolve(process.argv[1]).toLowerCase() === SELF_PATH.toLowerCase()
    : path.resolve(process.argv[1]) === SELF_PATH
  : false
if (isMain) startEditor()

/** 装配结果（路径 / 开关 / 落点）：给"挂到 bot 上"那一路读挂载前缀、口令与表路径用 */
export { cfg }
