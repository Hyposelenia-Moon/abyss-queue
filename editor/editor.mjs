/**
 * 排队表在线编辑器（零额外依赖：只用 node 内置模块 + jszip）
 *
 * 群友在浏览器里填表，机器人在群里发链接。设计要点：
 *   - 只暴露「需要填的字段」：群昵称 / 原神游戏名 / 选择主播 / 难度及目标 / 帮帮完成情况 / 备注
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
 * 状态文档固定 `data/queue.json`（`queue.xlsx` 是它的导出镜像）、凭证由宿主注入（详见 editor/README.md）。
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
import crypto from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createConfig } from "./config.js"
import { injectedBoolFlag, injectedFlag, injectedGroupCall, injectedLog, injectedOwnerAlert, isHostMode } from "./injected.js"
import { makeAuditLog, oneLine } from "./audit.js"
import { aclQq, createAcl, lockKey, lockRowOf, lockSheetOf } from "./acl.js"
import { createRoster } from "./roster.js"
import { createChanges } from "./changes.js"
import { createQuota } from "./quota.js"
import { createAlerts } from "./alert.js"
import { readJson } from "./util.js"
import {
  ATTACK_SHEET,
  ATTACK_TARGET_NAMES,
  attackCompletedStatus,
  attackPendingStatus,
  attackModeNames,
  attackStatusParts,
  attackVersions,
  parseAttackGoal,
} from "../components/attack.js"
import {
  attackCycle,
  abyssCycle,
  dramaCycle,
  phaseOf as cyclePhaseOf,
  stygianCycle,
  SHEET_ABYSS,
  SHEET_ATTACK,
  SHEET_DRAMA,
  SHEET_STYGIAN,
} from "../components/cycle.js"
import { AUTOSAVE_SNAPSHOT_MS, createVersions, resolveStoredFile, RE_VERSION } from "./versions.js"
import { bindView, bindDel, bindSet, createOwnership, dropBindsAt, rebuildOwnership, renameLock } from "./ownership.js"
import { createAuth } from "./http/auth.js"
import { createLinkGuard, clientIpOf } from "./http/link-guard.js"
import { createPages } from "./http/pages.js"
import { createSession } from "./http/session.js"
import { tidyOrder } from "./reorder.js"
import { autoAnchorOfStatus } from "./status-anchor.js"
import { createActions } from "./actions.js"
import { registerEditorService } from "./service.js"

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
 * 行为与以前逐字一致；宿主（bot）注入后，口令 / 表路径 / 挂载前缀就只有 `config.editor` 一份来源。
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
  changesFile: CHANGES_FILE,
  changesKeep: CHANGES_KEEP,
  quotaFile: QUOTA_FILE,
  quotaMaxPerSave: QUOTA_MAX_PER_SAVE,
  quotaWindowMs: QUOTA_WINDOW_MS,
  quotaMaxPerWindow: QUOTA_MAX_PER_WINDOW,
  rosterTrustMs: ROSTER_TRUST_MS,
  linksFile: LINKS_FILE,
  rosterQq: ROSTER_QQ,
  versionsDir: VERSIONS_DIR,
  versionsKeep: VERSIONS_KEEP,
  archivesDir: ARCHIVES_DIR,
  archiveDays: ARCHIVE_DAYS,
  archivesKeep: ARCHIVES_KEEP,
} = cfg

/** 插件侧的运行时配置（`anchor_aliases` 等，见 editor/config.js 的 `internal`） */
const { config } = internal

/** 装配根把句柄放进 ctx：子模块（anchors 等）从这里读配置，避免 import 成环 */
installCtx({ config })

/* ------------------------- 编辑器自己的小工具 ------------------------- */
/**
 * 日期戳与 JSON 读写已抽到 `editor/util.js`（顶部 import）——
 * 版本归档、群名单、白名单三处都要用，放一处避免各写一份。
 */

const shared = rel => import(pathToFileURL(path.join(PLUGIN_DIR, rel)).href)

/**
 * 编辑器页面用到的字体：路径 → 文件名
 *
 * 三份字体都在 `resources/common/font/`（与 Axiu-Plugin / Atlas-Plugin 同位置），
 * 只按固定路径吐出去，**没有任何下载或缓存逻辑**；拿不到就 404，页面自动回落到系统中文。
 * - `/font/cn.woff`：汉仪文黑 65W，正文与表格（旧页面就在用，路径保持不变）
 * - `/font/display.woff`：印品南征北战 NZBZ，只给品牌与页级大标题
 * - `/font/num.woff`：tttgbnumber，等宽数字（序号 / 人数 / 百分比 / 时间）
 */
const FONT_FILES = new Map([
  ["/font/cn.woff", "HYWH-65W.woff"],
  ["/font/display.woff", "NZBZ.woff"],
  ["/font/num.woff", "num.woff"],
])

const {
  decodeIdentity,
  signIdentity,
  verifyIdentity,
  signWindow,
  verifyWindow,
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
const { JsonTable } = await shared("model/json-table.js")
const { docFileOf } = await shared("model/queue-doc.js")
const { BindStore } = await shared("model/store.js")
const { readLinkTarget } = await shared("model/editor-links.js")
const { matchOption, locateSelf } = await shared("modules/queue.js")
const { canonicalAnchor, compileAliases } = await shared("components/aliases.js")
const { groupNameOfAnchor, readAnchorNames } = await shared("model/anchor-names.js")
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
/**
 * 状态文档：`data/queue.json` 是唯一事实源，`queue.xlsx` 只是它的导出镜像
 *
 * 镜像仍按 `xlsxPath` 写在原位置：下载、版本快照、云上传、以及"用 Excel 看表"都还认它；
 * 改动只落在 JSON 上，镜像在每次提交后重建。
 */
const STATE_PATH = docFileOf(xlsxPath)

/** 清榜账本与手动收录名单的落点跟着 `DATA_BASE`（与绑定文件同一个数据目录） */
initCycleLedger({ dataBase: DATA_BASE })
const table = () => (TABLE ??= new JsonTable({ file: STATE_PATH, mirror: xlsxPath }))
const store = () => (STORE ??= new BindStore(path.join(DATA_BASE, "abyss-editor-bindings.json")).load())

/** 插队置顶名单：只影响每日整理的队首顺序，不参与绑定 */
const queueFrontOf = sheet => {
  const list = STORE?.data?.queueFront?.[sheet]
  return Array.isArray(list) ? list.map(name => String(name ?? "").trim()).filter(Boolean) : []
}

/** 记下「这个人排到队首」：后来的插队优先，同一个人只留一条 */
const rememberQueueFront = async (sheet, nickname) => {
  const name = String(nickname ?? "").trim()
  if (!name) return
  const bindStore = await store()
  const map = bindStore.data.queueFront && typeof bindStore.data.queueFront === "object" ? bindStore.data.queueFront : {}
  const list = (Array.isArray(map[sheet]) ? map[sheet] : []).filter(n => String(n ?? "").trim() !== name)
  map[sheet] = [name, ...list].slice(0, 50)
  bindStore.data.queueFront = map
  await bindStore.save()
}

/**
 * 表指纹的**便宜版本**：`mtime:size` 没变就回上次算出来的那一份
 *
 * 只给页面轮询用（`/api/version?fast=1`，见那条路由）。指纹口径与 `table().fingerprint()`
 * 完全一致，差别只是"省掉这次读盘 + sha256"——而排队表是几百 KB，十几个页面每 5 秒各读一遍
 * 是白花的 I/O。写表走的是"临时文件 + rename"，mtime 与大小一定变，所以真有人改了表，
 * 最长一个轮询周期就会被发现；轮询本来就只是"要不要去拉一份新的"，晚一轮是自愈的。
 */
let fpFastCache = { key: "", version: "" }
const fingerprintFast = async () => {
  try {
    const st = await fsp.stat(STATE_PATH)
    const key = `${st.mtimeMs}:${st.size}`
    if (key === fpFastCache.key) return fpFastCache.version
    const version = await table().fingerprint()
    fpFastCache = { key, version }
    return version
  } catch (err) {
    if (err?.code === "ENOENT") return ""
    throw err
  }
}

/* ------------------------- 装配：群名单 / 白名单 / 锁 ------------------------- */

/** 群名单：给页面的昵称候选、给链接身份补昵称；`isMember` 是**本群守卫**（谁能改表） */
const roster = createRoster({ rosterFile: ROSTER_FILE, store, trustMs: ROSTER_TRUST_MS })
const { loadRoster, saveRoster, nickCandidates, nickOf, avatarOf, isMember, trusted: rosterTrusted, ageMs: rosterAgeMs } = roster

/**
 * 填表口令（固定入口页）的有效期
 *
 * 与链接时间窗同一档：5 分钟。口令过期后重新发 `#排队`。
 */
/** 按 6 位数字填表口令反查登记簿里的完整链接；找不到/过期返回 null */
const linkByCode = code => readLinkTarget(code, { file: LINKS_FILE })

/**
 * 改动记录（留痕）：谁在什么时候改了哪一行的哪个字段
 *
 * 实现见 `editor/changes.js`；写入点在"写表成功之后、仍在同一个临界区里"（`afterCommit`），
 * 所以记录与表**永远对得上**——不会出现"记了却没写成"或"写成了没记"。
 */
const changes = createChanges({ file: CHANGES_FILE, keep: CHANGES_KEEP })

/**
 * 越界配额：群友改**别人的行**的限速（口径与两条诚实说明见 `editor/quota.js`）
 *
 * 三个数走配置（默认 3 行/次、10 行/10 分钟），窗口状态落在 `<数据目录>/abyss-editor-quota.json`。
 */
const quota = createQuota({
  file: QUOTA_FILE,
  maxPerSave: QUOTA_MAX_PER_SAVE,
  windowMs: QUOTA_WINDOW_MS,
  maxPerWindow: QUOTA_MAX_PER_WINDOW,
})

/**
 * 越界告警：私聊告诉主人（编辑器只负责"该告警了 / 告给谁 / 说什么"，发送由宿主做）
 *
 * 硬红线每次都发；其他越界按 5 分钟合并成一条。主人名单**现读**（白名单改了立刻生效）。
 */
const alerts = createAlerts({
  send: payload => {
    const hook = injectedOwnerAlert()
    if (!hook) return null
    return hook({ ...payload, owners: loadOwners() })
  },
  log: (level, line) => (injectedLog() ? injectedLog()(line) : console.log(line)),
})

/** 记一条越界告警（发不出去只记日志，绝不影响保存判定） */
const alertOwner = (caller, { kind, text, force = false }) =>
  alerts.alert({ qq: caller?.identity?.qq ?? "", nick: caller?.identity?.nick ?? "", kind, text, force })

/**
 * 群名单**过期**了 ⇒ 提醒主人一次（**最多 24 小时一条**，免得每次打开页面都打扰）
 *
 * 为什么要提醒：名单不可信时编辑器**不放权也不拒人**（群友只能改自己那一行、也看不到整张表），
 * 也就是"新的那套权限悄悄失效了"。这件事必须让人知道，否则主人只会觉得"怎么还是老样子"。
 *
 * **"一次都没推过"不在这里吵**：机器人启动后 20 秒会推一次，每次重启都报一遍"名单没同步"
 * 就是纯噪音；真没配群号那种情况插件侧启动时已经报过了（`apps/queue.js`）。
 */
const ROSTER_ALERT_GAP_MS = 24 * 60 * 60 * 1000
let rosterAlertAt = 0
const maybeAlertStaleRoster = () => {
  const age = rosterAgeMs()
  if (!Number.isFinite(age)) return
  if (age <= ROSTER_TRUST_MS) return
  const now = Date.now()
  if (now - rosterAlertAt < ROSTER_ALERT_GAP_MS) return
  rosterAlertAt = now
  alerts.alert({
    qq: "",
    nick: "机器人",
    kind: "roster",
    force: true,
    text:
      `群成员名单已经 ${Math.round(age / 3_600_000)} 小时没更新了` +
      "：编辑器现在**不放权也不拒人**（群友只能改自己那一行、也看不到整张表）。请发一次 #排队同步名单。",
  })
}

import { catchUpOpenStatus, compactClearedRows, compactSheet, dropRowsAndMigrate, moveCell, replaceTable, tidySheetsCore, validateReplacement } from "./table-ops.js"
import { createHandler } from "./http/server.js"
import { aliasCanonicalNames, anchorBaseOf, anchorNameOf, anchorValuesOf, applyAnchors, archiveOptions, effectiveOptions, remapRowsOf, shiftRowsOf, validationPlan, writeValidationPlan } from "./anchors.js"


import {
  ANCHOR_CALL_COOLDOWN_MS,
  ANCHOR_FIELDS,
  ANCHOR_FIRST_ROW,
  ANY_ANCHOR,
  APPEND_ROWS_MAX,
  blank,
  CYCLE_PROTOCOL,
  EXCLUSIVE_VALUES,
  FIELDS,
  MOVE_COLUMN_KEYS,
  OPEN_RULES,
  PENDING_STATUS,
  PUBLIC_ANCHOR,
  PUBLIC_QUEUE_NAME,
  QUEUED_STATUS,
  REPLACE_REQUIRED_COLUMNS,
  SELF_DONE,
  SHEET_SHORT,
  sheetShortOf,
  WAITING_STATUS,
} from "./defs.js"
import {
  assertMemberRows,
  changeAuthor,
  composeRowMap,
  diffRows,
  editRecord,
  redLine,
  rowConflict,
  rowFingerprint,
  rowNumbersOf,
  sameNick,
  validateRows,
} from "./rows.js"
import { ctx, installCtx } from "./ctx.js"
import { afterSaveFollowUp, missingCandidates, nicknameCheckNow, pruneMissingRows, reconcileRoster } from "./roster-sync.js"
import { cleanNickValue, normNick, rosterQqOfNick, anchorQqOf, anchorQueueCounts, queueTextOf, queuePillsOf, buildPayload, memberStateOf, callTargetOf } from "./queue-view.js"


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

/** 编辑器可写的字段（顺序与原表的 B–G 列一致：序号与其它列一律不动） */


import { defaultStatusOf, statusWithSelfDone, statusTokens, statusLabels, statusRenamePlan, isDoneStatus, attackDisplayStatus, cycleDisplayStatus } from "./status.js"


/**
 * 汇总为前端可用的结构
 *
 * 按调用者身份裁剪：
 *   admin —— 全部行，可改所有人（另有白名单可维护）
 *   self  —— **本群成员**（名单可信且他在名单里）⇒ 整表（"能看到才能改"，见下节）；否则退回
 *            "只给按 QQ 定位到的自己那些行"（名单不可信时不放权也不拒人）
 *   guest —— 全部行只读（链接被转发、或直接打开域名）
 */
/**
 * 四榜的清榜安排快照（页面「清榜安排」页直接用，不自己算日期）
 *
 * 页面是纯内联脚本，import 不到 `components/cycle.js`，而清榜规则（每月 1 日 / 16 日、
 * 42 天一轮、版更日）散着好几个函数，照抄一份必然会与插件那边算偏一天。
 * 所以这里算好再下发：每榜 `{ phase, lastClear, nextClear, reminder }`，日期一律 ISO 字符串。
 *
 * @returns {Array<{sheet:string, phase:'queued'|'waiting', lastClear:string|null, nextClear:string|null, reminder:string|null, note:string}>}
 */
const cyclePlan = (now = new Date()) => {
  const at = new Date(now)
  const iso = d => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null)
  /** 清榜前一日 12:00 提醒（与 `components/cycle.js` 的口径一致） */
  const reminderOf = clear => {
    const r = new Date(clear.getTime() - 24 * 60 * 60 * 1000)
    r.setHours(12, 0, 0, 0)
    return r
  }
  const rows = []

  /** 剧诗：每月 1 日 04:00 */
  {
    const c = dramaCycle(at)
    rows.push({
      sheet: SHEET_DRAMA,
      phase: cyclePhaseOf(SHEET_DRAMA, at),
      lastClear: iso(c.lastClear),
      nextClear: iso(c.nextClear),
      reminder: iso(c.reminder),
      note: "每月 1 日 04:00 清空",
    })
  }

  /** 深渊：每月 16 日 04:00（16 日之前是「等待开启」） */
  {
    const c = abyssCycle(at)
    const past = at.getTime() >= c.clear.getTime()
    /** 这个函数只给当月，上月 / 下月按同一个点推 */
    const lastClear = new Date(c.clear)
    if (past) lastClear.setMonth(lastClear.getMonth() - 1)
    const nextClear = past ? new Date(at.getFullYear(), at.getMonth() + 1, 16, 4) : c.clear
    rows.push({
      sheet: SHEET_ABYSS,
      phase: cyclePhaseOf(SHEET_ABYSS, at),
      lastClear: iso(lastClear),
      nextClear: iso(nextClear),
      reminder: iso(reminderOf(nextClear)),
      note: "每月 16 日 04:00 清空，15 日 12:00 提醒",
    })
  }

  /** 危战：42 天一轮，第 34 天 04:00 清榜 */
  {
    const c = stygianCycle(at)
    const past = at.getTime() >= c.clear.getTime()
    /** 这一轮清过了就取下一轮的那次清榜；没过就是本轮的 */
    const nextClear = past ? stygianCycle(c.nextStart).clear : c.clear
    const lastClear = past ? c.clear : stygianCycle(new Date(c.start.getTime() - 24 * 60 * 60 * 1000)).clear
    rows.push({
      sheet: SHEET_STYGIAN,
      phase: cyclePhaseOf(SHEET_STYGIAN, at),
      lastClear: iso(lastClear),
      nextClear: iso(nextClear),
      reminder: iso(reminderOf(nextClear)),
      note: "42 天一轮，第 34 天 04:00 清空",
    })
  }

  /** 攻炼：长期开放，版更日 10:00 只清已完成 */
  {
    const c = attackCycle(at)
    rows.push({
      sheet: SHEET_ATTACK,
      phase: cyclePhaseOf(SHEET_ATTACK, at),
      lastClear: iso(c.lastStart),
      nextClear: iso(c.nextStart),
      reminder: iso(c.reminder),
      note: "长期开放，版更日 10:00 只清已完成",
    })
  }

  return rows
}


const recordChanges = list => (Array.isArray(list) && list.length ? changes.append(list) : 0)

/** 呼叫冷却：同一个人同一行短时间内只 @ 一次（内存态，重启即清） */
const anchorCallCooldown = new Map()

/* ------------------------- 呼叫 TA（管理员） ------------------------- */


/**
 * 管理员点「呼叫TA」：按 `sheet + row` 找绑定 QQ，再交给宿主发群消息
 *
 * @param {{role: string, identity?: object}} caller
 * @param {{sheet?: string, row?: number|string}} body
 * @returns {Promise<{ok: true, group: number}>}
 */
const applyCall = async (caller, { sheet, row } = {}) => {
  if (caller.role !== "admin") throw new Error("只有主人或白名单管理员可以呼叫")
  const name = String(sheet ?? "").trim()
  const rowNum = Number(row)
  if (!name || !Number.isInteger(rowNum) || rowNum <= 0)
    throw new Error("请求格式不对：需要 { sheet, row }")

  const found = await table().read(({ models }) => {
    const model = models.get(name)
    const r = model?.rows.find(x => x.row === rowNum)
    return r
      ? {
          nickname: String(r.nickname ?? "").trim(),
          goal: String(r.goal ?? "").trim(),
          status: String(r.status ?? "").trim(),
        }
      : null
  })
  if (!found) throw new Error("这一行已经不在表里了，刷新后再试")
  const status = attackDisplayStatus(name, found.goal, cycleDisplayStatus(name, found.status))
  const parts = attackStatusParts(status)
  const queued = parts ? parts.some(part => part.kind === "queued") : status === QUEUED_STATUS
  if (!queued) throw new Error("该成员不在排队中，无法呼叫")

  const bindStore = await store()
  const binds = bindView(bindStore.data.binds ?? {})
  const target = callTargetOf(binds, name, rowNum, found.nickname)
  if (!target.ok) throw new Error(target.error)

  const hook = injectedGroupCall()
  if (!hook) {
    const err = new Error("当前没有机器人连接，无法发群消息")
    err.statusCode = 503
    throw err
  }

  const out = await hook({
    qq: target.qq,
    sheet: name,
    row: rowNum,
    nickname: found.nickname,
    text: ` 主播喊你打${sheetShortOf(name)}了`,
  })
  return { ok: true, group: Number(out?.group) || 0 }
}

/**
 * 所有人点主播区「呼叫TA」：按榜 + 主播行的名字，去群名单里找唯一 QQ
 *
 * 与成员行的 `applyCall` 分开：主播行没有归属绑定，靠群名单的群昵称匹配；
 * 普通成员同一 QQ/榜/主播行 5 分钟一次，管理员/主人不限。
 *
 * @param {{role: string, identity?: object}} caller
 * @param {{sheet?: string, row?: number|string}} body
 * @returns {Promise<{ok: true, group: number}>}
 */
const applyAnchorCall = async (caller, { sheet, row } = {}) => {
  const callerQq = String(caller.identity?.qq ?? "").trim()
  /**
   * 管理员可能从本机/管理口令进来，没有群身份；他们不需要按 QQ 限频，
   * 所以只拦“没有身份的普通人”。普通人的 QQ 是 5 分钟冷却的钥匙。
   */
  if (!callerQq && caller.role !== "admin") {
    const err = new Error("请用带身份的填表链接打开，才能呼叫主播")
    err.statusCode = 403
    throw err
  }

  const name = String(sheet ?? "").trim()
  const rowNum = Number(row)
  if (!name || !Number.isInteger(rowNum) || rowNum <= 0)
    throw new Error("请求格式不对：需要 { sheet, row }")

  const found = await table().read(({ models }) => {
    const model = models.get(name)
    const anchor = model?.anchors.find(x => x.row === rowNum)
    return anchor ? { name: String(anchor.name ?? "").trim() } : null
  })
  if (!found?.name) throw new Error("这一位主播已经不在表里了，刷新后再试")

  const target = anchorQqOf(found.name)
  if (!target) throw new Error(`群名单/别名表里找不到唯一对应「${found.name}」的主播 QQ，无法 @`)

  const cooldownKey = `${callerQq}|${name}|${rowNum}`
  if (caller.role !== "admin") {
    const until = anchorCallCooldown.get(cooldownKey) ?? 0
    if (Date.now() < until) throw new Error("同一位主播 5 分钟内只能呼叫一次")
  }

  const hook = injectedGroupCall()
  if (!hook) {
    const err = new Error("当前没有机器人连接，无法发群消息")
    err.statusCode = 503
    throw err
  }

  const out = await hook({
    qq: target,
    sheet: name,
    row: rowNum,
    nickname: found.name,
    text: ` 快开播打${sheetShortOf(name)}了`,
  })
  if (caller.role !== "admin") anchorCallCooldown.set(cooldownKey, Date.now() + ANCHOR_CALL_COOLDOWN_MS)
  return { ok: true, group: Number(out?.group) || 0 }
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
       * **只认非空的新名片**：身份里没有群名片时（云端群名单里没这个人，
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
        if (plan.skipped) console.log(`[editor] QQ ${qq} 改名：${oneLine(plan.skipped)}`)
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
        oneLine(renamedRows.map(({ model, hit }) => `${model.name} 第 ${hit.row} 行「${hit.renamedFrom}」→「${hit.nick}」`).join("；")),
    )
  }
  return result
}


/**
 * 这个完成情况值**值不值得锁**：必须是"某位完成人"，且**不是本人自己的标记**
 *
 * 不锁这几种：空、状态词（`排队中` / `等待开启`）、字面「本人已完成」、以及**本行自己的群昵称**
 * （`本人已完成` 落表后就是它）。前两者是"这一行还在排队"，后两者是**本人的自有标记**——
 * 就算主播代点了一次「本人已完成」，本人也应当能自己撤回（改回「排队中」或重新点一次）。
 * 锁只用来保护"某位主播"这种**别人给的记录**。
 *
 * @param {string} value 完成情况的原值
 * @param {string} nickname 这一行的群昵称
 */
const lockWorthy = (value, nickname) => {
  const tokens = statusLabels(value).filter(token => !PENDING_STATUS.includes(token))
  if (!tokens.length) return false
  if (tokens.every(t => PENDING_STATUS.includes(t))) return false
  const nick = String(nickname ?? "").trim()
  return !tokens.every(t => t === SELF_DONE || (Boolean(nick) && t === nick))
}

/**
 * 这把锁**现在还算不算数**：锁只在"这一格当前确实记着某位完成人、且不是本人自有标记"时才生效
 *
 * 下发 `statusLocked` 与保存时的锁忽略循环**用同一个判断**，否则会出现"页面能改、存下去被拦"。
 * 过期 / 无效的锁一律当没有：页面显示成可编辑，本人照常能改；下一次正常写表会把它顺手清掉。
 *
 * 为什么需要它（2026-10-17 维护者录屏）：主播代点过「本人已完成」⇒ 值落成本人群昵称 + 一把锁，
 * 于是本人自己那一格既没有 `×` 也没有 `＋`（只读胶囊），想改回「排队中」**改不动**。
 *
 * @param {object} row 表里那一行（读**原值** `row.status`，不是下发时换过的展示值）
 * @param {object} locks 锁表（`榜#行号` → 记录）
 * @param {string} sheet 榜名
 */
const lockIsLive = (row, locks, sheet) => Boolean(row && locks?.[lockKey(sheet, row.row)]) && lockWorthy(row.status, row.nickname)

/**
 * 服务单例统一交给 `ctx`：`queue-view.js` 这类只读模块从这里取，
 * 直接 import 装配根会成环。放在这里是因为它要的 `lockIsLive` / `cyclePlan`
 * 都在这之前定义好了（`const` 有 TDZ，早了会读到未初始化）。
 */
installCtx({
  table,
  store,
  versions,
  ownership,
  acl,
  roster,
  changes,
  quota,
  alerts,
  cyclePlan,
  lockIsLive,
  statePath: STATE_PATH,
  xlsxPath,
  cfg,
})

import {
  addExtraName,
  createCycleIntent,
  cycleExclusive,
  ensureExtraNames,
  extraNamesOf,
  initCycleLedger,
  intentKey,
  intentPath,
  loadCycleLedger,
  mergeStatusOptions,
  monthKey,
  extraKeyOf,
  readCycleIntent,
  removeCycleIntent,
  saveCycleLedger,
  writeJsonSynced,
} from "./cycle-ledger.js"




/** 表模型里的当前主播行 → anchorValuesOf 的 base（入口两列在 cells 里） */

/** A 列原文是「主播名【推荐度】」，推荐度单独一格填，这里拼回去 */





/* ------------------------- 历史版本 / 归档 / 覆盖写入 ------------------------- */

/**
 * 版本与归档的实现都在 `editor/versions.js`（连文件名正则一起），装配点在上方；
 * 本文件只留**整表替换**——它要和绑定/锁的归属重建在同一次状态转换里，不能搬走。
 */

/** 归档清单（新的在前）：月度在前，其次每日 —— 见 `editor/versions.js` */




/* ------------------------- 群成员名单（候选人 + 按 QQ 对账） ------------------------- */

/**
 * `loadRoster` / `saveRoster` / `nickCandidates` / `nickOf` 的实现都在 `editor/roster.js`，
 * 装配点在上方「装配：群名单 / 白名单 / 锁」。这里只留"按 QQ 对账表"那段业务（见下）。
 */






/* ------------------------------ HTTP ------------------------------ */

/**
 * HTTP 层的三块都在 `editor/http/` 下，这里只做装配（与 acl / versions / ownership 同一套工厂写法）：
 *   - `respond.js`：`json` / 读请求体 / 取口令 / `FEATURES`（纯函数，不碰业务与配置）
 *   - `auth.js`：口令、身份签名、主人与白名单（`createAuth`）
 *   - `pages.js`：三个提示页 + 页脚（`createPages`）
 * 路由与业务编排仍在本文件（见下面的 `server`）。
 */
const { applySecurityHeaders, cspForPage, json, sendText, paramOf, readBody, readRawBody, drainRequest, FEATURES, BodyTooLarge } =
  await import("./http/respond.js")

// 子模块要用的服务单例一律经 ctx 拿：`anchors.js` 与 `roster-sync.js` 都不 import 装配根。
const { moveRow: applyMoveRow, tidy: applyTidy, roster: applyRoster, save: applySave, checkDone: applyCheckDone, cycleStatus: applyCycleStatus, cycle: applyCycle, linkCode: applyLinkCode, health: applyHealth } = createActions({
  table,
  store,
  changes,
  snapshotBeforeWrite: opts => snapshotBeforeWrite(opts),
  ownershipIn: (ctx, bindStore) => ownershipIn(ctx, bindStore),
  persistState: (info, plan) => persistState(info, plan),
  remapRowsOf: (state, sheet, toRow) => remapRowsOf(state, sheet, toRow),
  moveCell: (ctx, sheet, key, col, row, value, current, style) => moveCell(ctx, sheet, key, col, row, value, current, style),
  rememberQueueFront: (sheet, nick) => rememberQueueFront(sheet, nick),
  tidySheetsCore: sheet => tidySheetsCore(sheet),
  MOVE_COLUMN_KEYS,
  QUEUED_STATUS,
  /** 口令兑换（`linkCode`）：`linkByCode` 就是本文件 :273 那个登记簿查询，原实现一字未改 */
  linkByCode,
  /** 周期清榜（`cycle` / `cycleStatus`）：账本、intent 与判据都在本文件里，只有 `isDoneStatus` 定义在更后面 */
  CYCLE_PROTOCOL,
  cycleExclusive,
  loadCycleLedger,
  saveCycleLedger,
  readCycleIntent,
  createCycleIntent,
  removeCycleIntent,
  isDoneStatus: status => isDoneStatus(status),
  /** 群名单推送（`roster`）：名单读写与昵称候选在 :251，对账定义在 :2804（箭头防 TDZ） */
  loadRoster,
  saveRoster,
  reconcileRoster: members => reconcileRoster(members),
  nickCandidates,
  /** 保存（`save`）那一摊的依赖：实现都在本文件里，这里只把函数/常量传进动作层 */
  AUTOSAVE_SNAPSHOT_MS,
  FIELDS,
  PENDING_STATUS,
  PUBLIC_ANCHOR,
  SELF_DONE,
  WAITING_STATUS,
  afterSaveFollowUp: (caller, sheet, statusChanged, sortChanged) => afterSaveFollowUp(caller, sheet, statusChanged, sortChanged),
  alertOwner,
  assertMemberRows,
  attackCompletedStatus,
  attackPendingStatus,
  attackStatusParts,
  autoAnchorOfStatus,
  bindSet,
  bindView,
  blank,
  cleanNickValue,
  compactClearedRows: (sheet, rows) => compactClearedRows(sheet, rows),
  composeRowMap: (first, second) => composeRowMap(first, second),
  defaultStatusOf,
  diffRows,
  dropBindsAt,
  editRecord,
  locateSelf,
  lockIsLive,
  lockKey,
  lockWorthy,
  memberStateOf,
  parseAttackGoal,
  quota,
  recordChanges,
  redLine,
  renameLock,
  rosterQqOfNick,
  rowConflict,
  rowFingerprint,
  rowNumbersOf,
  sameNick,
  statusLabels,
  statusRenamePlan,
  statusTokens,
  statusWithSelfDone,
  validateRows,
  validationPlan: (model, anchorsOverride) => validationPlan(model, anchorsOverride),
  writeValidationPlan: (ctx, sheet, plan, opts) => writeValidationPlan(ctx, sheet, plan, opts),
  /** 探活（`health`）：版本与挂载前缀是本文件的常量，名单人数由 `loadRoster` 现读 */
  version: pluginVersion,
  mount: MOUNT,
  log: line => console.log(line),
})

registerEditorService({ moveRow: applyMoveRow, tidy: applyTidy, roster: applyRoster, save: applySave, checkDone: applyCheckDone, cycleStatus: applyCycleStatus, cycle: applyCycle, linkCode: applyLinkCode, health: applyHealth })

installCtx({
  tidySheetsCore,
  recordChanges,
  alertOwner,
  dropRowsAndMigrate,
  snapshotBeforeWrite,
  ownershipIn,
  persistState,
  queueFrontOf,
  moveCell,
  compactClearedRows,
  linkByCode,
  rememberQueueFront,
  lockWorthy,
})

const { authorized, callerOf, canManageAdmins, roleOf } = createAuth({
  token: TOKEN,
  adminToken: ADMIN_TOKEN,
  signKey: SIGN_KEY,
  loadAdmins,
  loadOwners,
  verifyIdentity,
})

/**
 * 填表口令的防枚举（口径、为什么状态放内存、来源 IP 怎么取：见 `http/link-guard.js`）
 *
 * 这一层只挡**猜测**：按来源 IP 限流 + 连续失败冷却。兑换成功不计数、不作废——
 * 链接发给整个群，同一条口令在 5 分钟有效期内可以被多人反复点（见下方 `/api/link-code`）。
 * 兑换本身仍然走 `actions.linkCode`（保持只读），因为机器人发链接前要用它自检
 * "这条口令能不能换回同一条完整链接"（见 `apps/queue.js` 的 `prepareEntry`）。
 */
const linkGuard = createLinkGuard()

/**
 * 诊断日志限频：窗口类提示是**请求级**信息，但同一个浏览器会每隔几秒
 * 轮询 `/api/data`、`/api/version`；每个请求都打一行就会把终端刷满。
 * 同一 key 10 分钟只留一行，足够排查，也不影响任何权限判定。
 */
const LOG_THROTTLE_MS = 10 * 60 * 1000
const logThrottle = new Map()
const logThrottled = (key, message) => {
  const now = Date.now()
  if (now - (logThrottle.get(key) ?? 0) < LOG_THROTTLE_MS) return
  logThrottle.set(key, now)
  /** 防止长期运行积累无数条一次性 key */
  if (logThrottle.size > 500) {
    for (const [k, t] of logThrottle) if (now - t >= LOG_THROTTLE_MS) logThrottle.delete(k)
  }
  console.log(message)
}

/**
 * 每个请求**只判一次身份**，判完就记住
 *
 * 为什么必须记住：管理员进门那一步会**往响应里种 24 小时会话 cookie**，而审计（`audit.js`）与路由
 * 都要问身份。各问一次就会重复种 cookie（`res` 已经写完，轻则审计记的是另一个人，重则
 * `ERR_HTTP_HEADERS_SENT`）。`dict` 的 key 是 `req`，一个请求一份结果。
 */
const resolvedCallers = new WeakMap()
function callerNow(req) {
  if (resolvedCallers.has(req)) return resolvedCallers.get(req)
  let value = callerOf(req)
  /**
   * 带 `abyss_admin_ok` 的浏览器没有链接参数，`callerOf()` 只能判成访客。
   * 这里用签名 cookie 里的 QQ 现算角色，补出管理员身份，`/queue` 才能直接打开。
   * 仍每次现算：白名单移除后，旧 cookie 不再给管理员身份。
   */
  if (!value?.identity?.qq) {
    const session = adminSessionOf(req)
    if (session) {
      const role = roleOf({ qq: session.qq })
      if (role.role === "admin") {
        value = { ...value, identity: { qq: session.qq, nick: "" }, ...role }
      }
    }
  }
  const state = { value, windowed: false }
  resolvedCallers.set(req, state)
  return state
}

/**
 * 管理员会话 cookie（24 小时）：实现整块在 `http/session.js`，这里只按签名密钥装一份。
 *
 * 它与表格、名单、路由都不相干，只认 `SIGN_KEY`；搬出去之后，本文件少了一段纯签名逻辑。
 */
const { adminSessionOf, adminSessionOk, setAdminSession } = createSession({ signKey: SIGN_KEY })

/**
 * 写操作的请求级审计（一行一条，见 `editor/audit.js`）
 *
 * 出口：宿主注入的框架 logger（有时间戳与等级）；独立跑时回落到 `console`，
 * 而独立跑的 `setupLogFile` 会把 console 同时写进 `data/editor.log`。
 */
const auditLog = makeAuditLog({ log: injectedLog() ?? (line => console.log(line)), callerOf: req => callerNow(req).value })

const { footerHtml, entryPage, ownerOnlyPage, expiredLinkPage } = createPages({ footHtml: FOOTER_HTML })

/**
 * 问一下云端现在是哪一版表（推表前用）
 *
 * 拿不到就返回空串：云端还没有 /api/version 时，推表照旧（不带版本 = 不做冲突检测），
 * 不能因为一个接口取不到就把"上传覆盖云端"整个弄坏。
 *
 * 云端这条要**带上主人自己的凭据**：主人打开本机编辑器时带的就是他那份身份（同一个浏览器、
 * 同一个域名），原样转发给云端的 `/api/version` 与 `/api/upload`，云端才认得出
 * "这是主人本人"，而不是"一条别人的链接"。
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
 * 锅巴面板的「保存时回填线上枪战状态」入口。
 *
 * 只改「等待开启 / 排队中」这两类派生状态：按当前 `attack_versions` 的 open_at
 * 重算，已完成/带完成人的状态一个字不碰。写表仍走 `table().mutate`，
 * 备份、版本与并发保护与编辑器正常保存同一条路径。
 */
export async function syncAttackStatuses() {
  let changed = 0
  /** 配置里的 open_at / 具体模式变化后也要重新排序；状态回填写完再整理一次 */
  let tidied = null
  await table().mutate(async ctx => {
    const model = ctx.model(ATTACK_SHEET)
    for (const r of model.rows) {
      const goal = String(r.goal ?? "").trim()
      if (!goal) continue
      const old = String(r.status ?? "").trim()
      const parts = attackStatusParts(old)
      if (!parts && old !== WAITING_STATUS && old !== QUEUED_STATUS) continue
      const next = parts?.some(part => part.kind === "done")
        ? attackCompletedStatus(goal, old)
        : attackPendingStatus(goal)
      if (!next || next === old) continue
      ctx.setCell(ATTACK_SHEET, r.row, "status", next)
      changed++
    }
    /** 深渊的裸状态同样按当前日历回填；页面显示层和表里的旧值一起收口 */
    const abyss = ctx.model("深境螺旋")
    const abyssNext = defaultStatusOf("深境螺旋")
    for (const r of abyss.rows) {
      const old = String(r.status ?? "").trim()
      if (old !== WAITING_STATUS && old !== QUEUED_STATUS) continue
      if (old === abyssNext) continue
      ctx.setCell("深境螺旋", r.row, "status", abyssNext)
      changed++
    }
  })
  /** 状态回填写完再整理：`attack_versions` 的具体模式变化会改变模式数量，
   * 不重新 tidy 的话，表里会停在旧配置算出来的顺序。 */
  tidied = await tidySheetsCore(ATTACK_SHEET, { snapshotThrottleMs: AUTOSAVE_SNAPSHOT_MS })
  return { changed, tidied }
}

/* ------------------------- 头像代理 ------------------------- */

/**
 * 头像缓存：`qq → { buf, type, at }`
 *
 * 页面左下角那张 32px 圆头像每次加载都会请求一次；腾讯那边一张几 KB，
 * 但一个人一天开几十次页面也没必要每次出网。30 分钟够用，进程重启丢了也无所谓。
 */
const AVATAR_CACHE_MS = 30 * 60 * 1000
const AVATAR_CACHE_MAX = 400
const avatarCache = new Map()

/**
 * 允许出网的头像主机
 *
 * 上游地址只有两个来源：名单里适配器给的那条、按 QQ 拼的腾讯直链；
 * **不接受请求参数里的任意 URL**——`/api/avatar` 是公开端点，开放任意 URL 等于给内网开一个 GET 代理。
 * 以后要接头像源就改这里，别放开参数。
 */
const AVATAR_HOSTS = new Set(["q.qlogo.cn", "p.qlogo.cn", "api.dicebear.com"])

/** 按顺序试：名单里适配器给的那份 → 按 QQ 拼的腾讯直链；都不行返回 null（由调用方回 404） */
const fetchAvatar = async qq => {
  const urls = []
  const stored = String(avatarOf(qq) ?? "").trim()
  if (stored) urls.push(stored)
  urls.push(`https://q.qlogo.cn/g?b=qq&s=100&nk=${encodeURIComponent(qq)}`)
  for (const url of urls) {
    try {
      if (!AVATAR_HOSTS.has(new URL(url).hostname)) continue
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length) continue
      return { buf, type: String(r.headers.get("content-type") ?? "").trim() || "image/jpeg" }
    } catch {
      /* 换下一份候选 */
    }
  }
  return null
}

const sendAvatar = (res, { buf, type }) => {
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(buf.length),
    /** 私有缓存：头像是"这个人"的，别让中间代理把同一张图算到别人头上 */
    "cache-control": "private, max-age=3600",
  })
  return res.end(buf)
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
    console.log(`  状态文档：${STATE_PATH}（唯一事实源；xlsx 是它的导出镜像）`)
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
    console.log(`  主人专用：${OWNER_ONLY ? "是（其他人打不开，只有 /api/version 与 /healthz 放行）" : "否（按身份分权）"}`)
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

export const handler = createHandler({
  ADMIN_TOKEN,
  ARCHIVES_DIR,
  ARCHIVE_DAYS,
  AVATAR_CACHE_MAX,
  AVATAR_CACHE_MS,
  BIND,
  BodyTooLarge,
  CHANGES_KEEP,
  CLOUD_URL,
  ENV_ADMINS,
  FEATURES,
  FIELDS,
  FONT_FILES,
  MOUNT,
  OWNER_ONLY,
  PLUGIN_DIR,
  PORT,
  RE_VERSION,
  ROSTER_QQ,
  SIGN_KEY,
  TEMPLATE,
  TOKEN,
  VERSIONS_DIR,
  VERSIONS_KEEP,
  aclAudit,
  aclQq,
  addExtraName,
  adminFileList,
  adminSessionOf,
  adminSessionOk,
  alignOwnership,
  applyAnchorCall,
  applyAnchors,
  applyCall,
  applyCheckDone,
  applyCycle,
  applyCycleStatus,
  applyLinkCode,
  applyMoveRow,
  applyRoster,
  applySave,
  applySecurityHeaders,
  applyTidy,
  archiveOptions,
  attackVersions,
  auditLog,
  authorized,
  avatarCache,
  buildPayload,
  callerNow,
  canManageAdmins,
  catchUpOpenStatus,
  changeAuthor,
  changes,
  clientIpOf,
  cloudVersion,
  compileAliases,
  config,
  crypto,
  cspForPage,
  decodeIdentity,
  drainRequest,
  ensureExtraNames,
  entryPage,
  expiredLinkPage,
  fetchAvatar,
  fingerprintFast,
  footerHtml,
  fs,
  fsp,
  http,
  innerPath,
  json,
  linkGuard,
  listArchives,
  listVersions,
  loadAdmins,
  loadOwners,
  loadRoster,
  logThrottled,
  maybeAlertStaleRoster,
  memberStateOf,
  mineRows,
  missingCandidates,
  nickOf,
  ownerOnlyPage,
  ownership,
  ownershipAudit,
  paramOf,
  path,
  pluginVersion,
  pruneMissingRows,
  readBody,
  readRawBody,
  rebuildOwnershipNow,
  recordChanges,
  replaceTable,
  resolveStoredFile,
  roleOf,
  roster,
  rosterQqOfNick,
  saveAdmins,
  sendAvatar,
  sendText,
  setAdminSession,
  signIdentity,
  signWindow,
  store,
  syncIdentity,
  table,
  verifyWindow,
  versions,
  xlsxPath,
})

const isMain = process.argv[1]
  ? process.platform === "win32"
    ? path.resolve(process.argv[1]).toLowerCase() === SELF_PATH.toLowerCase()
    : path.resolve(process.argv[1]) === SELF_PATH
  : false
if (isMain) startEditor()

/** 装配结果（路径 / 开关 / 落点）：给"挂到 bot 上"那一路读挂载前缀、口令与表路径用 */
export { cfg }
