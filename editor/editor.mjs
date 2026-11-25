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

import { effectiveOptions } from "./anchors.js"
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




/**
 * 主播行的可写值：字段与 ANCHOR_FIELDS 一一对应，值一律 trim。
 *
 * `base` 是这一行当前的表值：请求里**没有出现**的键沿用 base，而不是补空串。
 * 只提交部分字段的旧客户端/人工请求不能把 G/H 的直播入口抹掉；
 * 显式提交空串仍表示清空。
 */
export const anchorValuesOf = (values, base = null) =>
  Object.fromEntries(
    ANCHOR_FIELDS.map(f => {
      const provided = values && Object.prototype.hasOwnProperty.call(values, f.key)
      const v = provided ? values[f.key] : base?.[f.key]
      return [f.key, String(v ?? "").trim()]
    }),
  )

/** 表模型里的当前主播行 → anchorValuesOf 的 base（入口两列在 cells 里） */

export const anchorBaseOf = a =>
  a
    ? {
        name: a.name,
        recommend: a.recommend,
        duty: a.duty,
        skills: a.skills,
        platform: a.cells?.platform ?? "",
        link: a.cells?.link ?? "",
      }
    : null

/** A 列原文是「主播名【推荐度】」，推荐度单独一格填，这里拼回去 */

export const anchorNameOf = values => (values.recommend ? `${values.name}【${values.recommend}】` : values.name)

/**
 * 插行之后把绑定与锁里的行号一起搬走（只搬被插的那一榜、插入点及以下的行）
 *
 * **必须搬**：绑定/锁下一步会被盖上"新版本"的戳，行号却还指着上一行 —— 下次本人打开页面时
 * 版本对得上（于是不做重建），人就被认到别人的行上去了。搬法与群名单对账那边同一口径：
 * 从不可变旧快照读、写进全新对象、最后整体替换（原地读写会让新键覆盖还没搬的另一条）。
 */
export const shiftRowsOf = ({ binds, locks }, sheet, from, count) => {
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
export const remapRowsOf = ({ binds, locks }, sheet, toRow) => {
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
 * 别名表里的「正名」集合（`config.anchor_aliases` 的键）
 *
 * 别名表是手写的 YAML（`config/config.yaml`）：键是正名、值是它的各种写法。改主播名时，
 * 如果旧名正好是这里的键，配置里的别名就再也指不到人了 —— 与其让编辑器偷偷去改配置文件
 * （那是运维手写的东西，改了会被下次覆盖 / 也可能根本改不动），不如**在写表之前就拦住**。
 *
 * 取键时按 `compileAliases()` 的同一口径去空白；另外把没写别名的空键也算进来：
 * 那种键改名之后同样是断的（只是断得没那么明显）。
 */
export const aliasCanonicalNames = () => {
  const out = new Set()
  for (const name of Object.keys(config?.anchor_aliases ?? {})) {
    const text = String(name ?? "").trim()
    if (text) out.add(text)
  }
  for (const a of compileAliases(config?.anchor_aliases)) out.add(a.name)
  return out
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
export const applyAnchors = async (caller, { sheet, rows, added, version }) => {
  if (caller.role !== "admin") throw new Error("只有白名单管理员可以改主播列表")
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  /** 页面上新加的主播还没有行号（要插入时才定得下来），单独放在 `added` 里 */
  const fresh = Array.isArray(added) ? added : []
  if (rows.length + fresh.length > 100) throw new Error("一次提交的主播行数过多（>100）")

  let plan = null
  let insertShift = null
  const out = await table().mutate(
    async ctx => {
      /** 行号必须是表里已有的主播行，避免把内容写到数据区或其它地方（读的是同一版表） */
      const model = ctx.model(sheet)
      const known = new Map(model.anchors.map(a => [a.row, a]))

      const normalized = []
      /** 别名表里登记过的正名：改名前要对一遍（见 `aliasCanonicalNames`） */
      const aliasNames = aliasCanonicalNames()
      for (const r of rows) {
        const row = Number(r?.row) || 0
        const before = known.get(row)
        if (!before) throw new Error(`第 ${row} 行不是主播列表里的行，不能改`)
        const values = anchorValuesOf(r?.values, anchorBaseOf(before))
        if (!values.name) throw new Error(`第 ${row} 行：主播名不能为空（要删掉这位主播请在表格里删行）`)
        /**
         * **改名前断言别名表已同步**：旧名是 `anchor_aliases` 的正名键时，表里改完名、
         * 配置里的别名就全指向一个不存在的名字了（群里按老昵称叫人也对不上）。
         * 编辑器不替人去改 YAML，只拒绝并说清楚要改哪一行。
         */
        if (before.name !== values.name && aliasNames.has(String(before.name ?? "").trim()))
          throw new Error(
            `第 ${row} 行：「${before.name}」是 config/config.yaml 里 anchor_aliases 的正名（别名都挂在它下面），` +
              `只改表会让别名失效。请先把 anchor_aliases 的键「${before.name}」改成「${values.name}」，再回来改名`,
          )
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
        /** 插在主播区末尾、排队区上面：插入点以下的数据行整体下移，历史记录的位置也要跟着搬 */
        insertShift = Object.fromEntries(
          model.rows.filter(r => r.row >= insertedAt).map(r => [r.row, r.row + addedValues.length]),
        )
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
      writeValidationPlan(ctx, sheet, listPlan, { single: false })
      /** 表换了版本：绑定与锁要跟着盖上新版本，否则下次对账会把它们全作废 */
      const state = await ownershipIn(ctx, await store())
      /** 插了行，插入点以下的行号全变了：绑定与锁搬完再盖章（漏搬 = 本人被认到别人的行上） */
      const moved = shiftRowsOf(state, sheet, insertedAt, addedValues.length)
      plan = { binds: moved.binds, locks: moved.locks }
      return { written: normalized.length + addedValues.length, inserted: addedValues.length, options: options.length }
    },
    { expect: version, afterCommit: info => persistState(info, plan) },
  )
  if (out?.inserted && insertShift) changes.remap(sheet, insertShift)
  return out
}

/**
 * 把"已排队的某个人"挪到这一榜所有「排队中」的人最前面
 *
 * **只给 `#插队` 用**（管理员在群里发指令，插件调 `/api/move-row`，见 apps/inserter.js）。
 * 位置由**编辑器**算：插件只给"哪一榜、哪一行、怎么挪"，算不出目标就整表不动。
 *
 * 口径（与插件侧同一份）：
 *   - 目标行 = 数据区里**第一条**「排队中」；这一行本来就在最前面 ⇒ 什么都不做
 *     （不是错误，返回 `moved:false` + `reason`），插件照原样回一句"已经在最前面"；
 *   - 动作 = 把 `[目标行, 来源行]` 这一段**整体轮转**：来源行的人 → 目标行，
 *     目标行及中间的人各后移一位。不是只交换两端——跨多位时要保证中间那一段真的让位；
 *   - 不新增行、不删除行、不改任何行号 ⇒ 排队区不出现空行/缺行，序号列（`=ROW()-k` 的缓存值）
 *     逐行不动，仍然是 1..N；
 *   - 样式随内容一起换（每格把**来源行**的 `s` 显式带上）：不这么做，隔行配色会留在原地，
 *     人一挪就顶着别人的底色；
 *   - 绑定与锁的行号由 `remapRowsOf` 搬（来源行 → 目标行，`[目标行, 来源行-1]` 各 +1）：这一步不能省——
 *     `ownershipIn` 在写表后按行号记归属，不搬就等于"表换了、归属还指着旧行号"。
 *
 * 失败即整表不动：任何一步不满足预期都抛错，由 `mutate()` 原样中止这一轮（表 / 绑定 / 锁 / 版本都不动）。
 * @param {{role: string}} caller 调用者（非管理员直接抛错）
 * @param {{sheet: string, row: number|string, mode: string, nick?: string}} body 请求体
 * @returns {Promise<{moved: boolean, sheet: string, from?: number, to?: number, fromSeq?: number,
 *   toSeq?: number, nickname?: string, crossed?: string, reason?: string}>}
 */
/**
 * 插队（实现搬到 `editor/actions.js`，这里只装配依赖）
 *
 * 依赖用箭头包一层：`moveCell` 定义在本文件更靠后的位置，直接取值会撞 TDZ。
 */
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

/** 把动作注册到进程内注册表：插件侧 getEditorService() 直接调，不再绕 HTTP */
registerEditorService({ moveRow: applyMoveRow, tidy: applyTidy, roster: applyRoster, save: applySave, checkDone: applyCheckDone, cycleStatus: applyCycleStatus, cycle: applyCycle, linkCode: applyLinkCode, health: applyHealth })



/**
 * 整理的核心（**所有榜**或指定的那一榜）：按
 * "**已完成 → 等待开启 → 排队中**" 分组，组内按难度/目标/强度排序（口径见 `tidyOrder` / `reorder.js`）
 *
 * 与 `#插队` 同一条理由由编辑器干这件事：插件对表**只读**，动整张表只有拿着表的编辑器做得到。
 * 动作 = **换内容**（与 `#插队` 同一套 `moveCell`）：不插行、不删行、行号一个都不变，
 * A 列序号（`=ROW()-k`）原地不动；归属（绑定与锁）按"哪一行的人去了哪一行"重排（`remapRowsOf`）。
 *
 * **已经是有序的 ⇒ 一个字都不写**：`mutate()` 只在真写了格时才落盘，所以这里提前 return
 * 就等于"没动过"——不产生历史版本、不刷新版本指纹（维护者要求：若当前表格也为此状态则不做改动）。
 *
 * 两个入口共用这一份：每天到点的那一次（`/api/tidy` → `applyTidy`）与**改了完成情况就立刻做**
 * 的那一次（`applySave` 的收尾，见 `afterSaveFollowUp`）。
 *
 * @param {string} wanted 榜名；空串 = 所有榜
 * @param {object} [opts]
 * @param {number} [opts.snapshotThrottleMs] 存历史版本的节流（只给"改完成情况之后立刻整理"那条路用：
 *   那一次紧跟在一次保存之后，而保存已经存过底了，再存一份只会白占版本位；见 `AUTOSAVE_SNAPSHOT_MS`）
 * @returns {Promise<{moved: number, tidied: Array<{sheet: string, moved: number, reason?: string}>}>}
 */
const tidySheetsCore = async (wanted, { snapshotThrottleMs = 0 } = {}) => {
  const tidied = []
  /** 榜名 → `{老行号: 新行号}`：内容换过位置的行，页面的草稿键按它搬（见 `applySave` 的 `rowMap`） */
  const shiftRows = {}
  let plan = null
  let moved = 0
  await store()

  await table().mutate(
    async ctx => {
      const names = wanted ? [wanted] : [...ctx.models.keys()]
      /** 先算出每个榜"要不要动、怎么动"；一个都不用动的榜不进 ops（也就不写任何格） */
      const ops = []
      for (const name of names) {
        const model = ctx.model(name)
        const target = tidyOrder(model, {
          tempNames: extraNamesOf(name),
          frontNames: queueFrontOf(name),
        })
        if (!target) {
          tidied.push({ sheet: name, moved: 0, reason: "已经是有序的（或没有可排序的行），一个字都没写" })
          continue
        }
        ops.push({ name, model, ...target })
      }
      if (!ops.length) return { moved: 0 }

      /**
       * 写表前留底：历史版本 + 每日/换月归档（只有真的要动表时才留）
       *
       * "改完成情况之后立刻整理"那一次带节流（`snapshotThrottleMs`）：它紧跟在一次保存之后，
       * 而那次保存已经存过底了（自动保存那条路本来就有 5 分钟节流），再存一份只是白占版本位。
       */
      await snapshotBeforeWrite(snapshotThrottleMs ? { throttleMs: snapshotThrottleMs } : {})
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
        /** 页面的草稿键要按"哪个人去了哪一行"搬（见 `applySave` 的 `rowMap`）：只记真的换了位置的 */
        shiftRows[op.name] = Object.fromEntries(rowMap)
        merged = remapRowsOf(merged, op.name, r => rowMap.get(r) ?? r)
      }
      plan = merged
      return { moved }
    },
    { afterCommit: info => persistState(info, plan) },
  )

  if (moved)
    console.log(
      `[editor] 每日整理：共挪 ${moved} 行（${oneLine(tidied.filter(t => t.moved).map(t => `${t.sheet} ${t.moved}`).join("、"))}）`,
    )
  return { moved, tidied, shiftRows }
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
 *   2. 表里手填/在用的其它值（不在名单里的主播、公共队列、排队中…）**自动收进来当选项**
 *      —— 这就是"手填的主播自动归档为下拉选项"，免得表里能用、下拉里却没有
 * @param {object} model 榜模型
 * @param {string[]|null} anchorsOverride 主播区刚改完的名单（保存主播列表时用）
 */
export const validationPlan = (model, anchorsOverride = null) => {
  const names = (anchorsOverride ?? model.anchors.map(a => a.name)).map(s => String(s ?? "").trim()).filter(Boolean)
  const anchors = [...new Set(names)]
  const anchorCol = model.col?.anchor
  const statusCol = model.col?.status
  const anchor = anchorCol ? effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) }).anchor : []
  const status = statusCol ? mergeStatusOptions(model, anchors, { withExtra: false }) : []
  /**
   * 一个**单选**下拉列也要把名单写回表里（2026-10-18 维护者：「禁止此类下拉菜单的单元格的手写功能」）：
   * 它是单选（`goal`），所以用 `errorStyle: "stop"` —— 表格里手扫一个值会被拦下，
   * 只能从下拉里挑；而「选择主播」「帮帮完成情况」是**多值**列，必须留 `warning` 才能手打「A,B」。
   * 名单与页面下发的是同一份（`effectiveOptions`：老写法已归一化）。
   */
  const goalCol = model.col?.goal
  const opts = effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) })
  /** 绝境攻炼的 30 个组合值超过 Excel 内联下拉 255 字符，页面自己下发；不写表内验证 */
  const goal = goalCol && !/攻炼|绝境/.test(String(model.name ?? "")) ? (opts.goal ?? []) : []
  return { anchorCol, statusCol, anchor, status, goalCol, goal }
}

/**
 * 把这几份名单写进表
 *
 * 单选列（难度及目标）用 **stop**：拦手写；多值列（选择主播 / 帮帮完成情况）用
 * **warning**：Excel 的数据验证不支持真多选，stop 会把「A,B」这种手填值一并拦下。
 */
export const writeValidationPlan = (ctx, sheet, plan, { single = true } = {}) => {
  if (plan.anchorCol && plan.anchor.length) ctx.setValidationList(sheet, plan.anchorCol, plan.anchor, { errorStyle: "warning" })
  if (plan.statusCol && plan.status.length) ctx.setValidationList(sheet, plan.statusCol, plan.status, { errorStyle: "warning" })
  /**
   * 单选列**只在保存成员行的这条路上**写（`single = true`）：改主播列表 / 归档手填名字
   * 是另一件事，不该顺手把「难度及目标」的下拉也重写一遍。
   */
  if (!single) return
  if (plan.goalCol && plan.goal.length) ctx.setValidationList(sheet, plan.goalCol, plan.goal, { errorStyle: "stop" })
}

/**
 * 表里手填了新名字就把它归档进下拉选项（只有管理员打开时做，且只在真有新名字时才写表）
 *
 * 读与写同样在同一个临界区里：不然"读出来要归档"和"真写进去"之间表可能已经被换掉（AQ-06）。
 */
export const archiveOptions = async caller => {
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
      for (const { name, plan: p } of work) writeValidationPlan(ctx, name, p, { single: false })
      const state = await ownershipIn(ctx, await store())
      plan = { binds: state.binds, locks: state.locks }
      return { archived: work.reduce((n, x) => n + x.fresh.length, 0) }
    },
    { afterCommit: info => persistState(info, plan) },
  )
  if (!work.length) return 0
  const total = work.reduce((n, x) => n + x.fresh.length, 0)
  console.log(
    `[editor] 已把手填的 ${total} 个名字归档进下拉选项：` +
      oneLine(work.map(x => `${x.name}（${x.fresh.join("、")}）`).join("；")),
  )
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
      /**
       * 翻成「排队中」的那几行**不该再锁着**：顺手把它们的锁删掉
       *
       * 读侧已经有 `lockIsLive` 兜底（过期锁不生效），这里只是别让陈旧记录一直躺在盘上；
       * 正常情况下这几行本来就没有锁（`等待开启` 的行造不出锁），这一步是给"手工改表"留的自愈。
       */
      if (state.locks) for (const o of opened) delete state.locks[lockKey(o.sheet, o.row)]
      plan = { binds: state.binds, locks: state.locks }
      return { opened: opened.length }
    },
    { afterCommit: info => persistState(info, plan) },
  )
  if (!opened.length) return 0
  console.log(
    `[editor] 开榜时间已到，把 ${opened.length} 行的「${WAITING_STATUS}」改成「${QUEUED_STATUS}」：` +
      oneLine(opened.map(o => `${o.sheet} 第 ${o.row} 行${o.nickname ? `「${o.nickname}」` : ""}`).join("；")),
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
 * 替换前的结构校验（AQ-07）
 *
 * 名字对得上不代表内容对：空表壳或别的表也会"上传成功"，结果编辑器和机器人都读不出任何数据。
 * 所以逐表确认表头、必要列与建模结果。
 * @throws {Error} 带具体缺失项的中文说明
 */
const validateReplacement = (after, before) => {
  /**
   * 允许**在当前表末尾新增「绝境攻炼」**（长期模块的第一张表）；其余增删/换序一律拒绝。
   * 不能直接放开成"任意多表"：上传覆盖是主人入口，但结构漂移会让机器人与页面一起读错。
   */
  const kept = before.names.every((name, i) => after.names[i] === name)
  const added = after.names.slice(before.names.length)
  if (!kept || added.some(name => name !== ATTACK_SHEET))
    throw new Error(
      `工作表对不上：文件里是「${after.names.join("、")}」，当前表是「${before.names.join("、")}」，拒绝替换` +
        `（只允许在末尾新增「${ATTACK_SHEET}」）`,
    )
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
 * 删行 + **绑定 / 锁的迁移**（`reconcileRoster` 的退群删行与"主人确认删候选行"共用这一份）
 *
 * 口径（AQ-03 / AQ-08，两处必须一模一样，所以只留一处实现）：
 *   - **绑定**：QQ 是身份，按 QQ 迁移、压紧之后整体替换；被删掉的那些行解绑；
 *   - **锁**：从不可变旧快照（`lockRows`）生成全新对象、迁移完整体替换，并且**校验归属**——
 *     锁上记的人必须就是被搬走那一行上的人，否则作废（锁错人比不锁更糟，让主播重新填一次）；
 *   - 两件事都只读"这一版表"的模型与旧快照，**不回头改表**（原地读写会撞键、把锁落到错的行上）。
 *
 * @param {object} ctx 临界区上下文（`table().mutate` 的回调参数）
 * @param {Map<string, number[]>} drops 榜名 → 要删掉的行号
 * @param {object} binds 绑定对象（**原地改**，调用方随后整体落盘）
 * @param {object} lockRows 锁的旧快照
 * @returns {Promise<{locks: object, removed: number, moved: number}>} 新的锁对象 + 删掉/搬走的行数
 */
const dropRowsAndMigrate = async (ctx, drops, binds, lockRows) => {
  /** 先把各榜的 drop / 位移算出来：迁移绑定与锁都只读这一份，不再回头改表 */
  const moves = new Map()
  for (const [sheet, rows] of drops) {
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

  /** 锁：校验归属之后迁移（见上面第 2 条） */
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
    if (nick && atRow && nick !== atRow) continue
    const to = lockKey(sheet, move.shift.get(row))
    if (nextLocks[to]) continue
    nextLocks[to] = { ...lock, ...(nick ? { nickname: nick } : {}) }
  }

  let removed = 0
  let moved = 0
  /**
   * 行号搬家表（榜名 → `{老行号: 新行号}`，只记真的换了位置的）：**页面的草稿键按它搬**
   *
   * 搬行之后"第 N 行"已经换了人，页面上按行号存的草稿（榜 × 行号）若还指着老行号，
   * 下一次自动保存就会拿这个人的值去写那一行现在的人（轻则被红线拒掉、草稿卡住，
   * 重则把别人顶掉）。所以搬家表要跟着回执回到页面（见 `applySave` 的 `rowMap`）。
   */
  const shiftRows = {}
  for (const [sheet, { drop, shift }] of moves)
    for (const [from, to] of shift) if (!drop.has(from) && to !== from) (shiftRows[sheet] ??= {})[from] = to

  for (const [sheet, { model, drop }] of moves) {
    const out = await compactSheet(ctx, model, [...drop])
    removed += out.removed
    moved += out.moved
    console.log(`[editor] 已从「${oneLine(sheet)}」删掉 ${out.removed} 行并压紧（${out.moved} 行上移）`)
  }
  /** 被删掉的行，历史记录里对应的 `current` 标成 0（不再命中任何现存行）；余下的按压紧映射搬 */
  for (const [sheet, { drop }] of moves)
    if (drop.size) changes.remap(sheet, Object.fromEntries([...drop].map(r => [r, 0])))
  for (const [sheet, map] of Object.entries(shiftRows)) changes.remap(sheet, map)
  return { locks: nextLocks, removed, moved, shiftRows }
}


/**
 * 清空行之后**立刻**压紧：把下面那些行整体提上来，序号列不留空档
 *
 * 现场（维护者截图）：页面上的序号读成 14、15、17。原因是两件事凑在一起——
 *   1. A 列序号是**按行算**的公式 `=ROW()-k`，一行占一个行号，删掉的行不会自己让位；
 *   2. 页面只画"表里还有内容的行"（`model.rows` 不收整行空掉的行，见 `model/schema.js`），
 *      于是空着的那一行从页面上消失，它下面的行号就跳号了。
 * 压紧就是让空档合上：下面的行整体上移一格，A 列一格都不动（序号本来就等于位置）。
 * 动作与"退群删行 / 主人确认删候选行"完全一样，所以共用 `dropRowsAndMigrate`——
 * 绑定与完成情况锁的行号也跟着搬，不会有人被认到别人的行上。
 *
 * **另起一个临界区**（而不是塞进保存那一趟，见 `applySave` 调用处的说明）：
 * 保存那一趟里 `setCell` / `clearRow` 都还只是排队的写入，`compactSheet` 按行读内容时会读到
 * 清空前的旧值，等于把刚删掉的那一行又搬回来。
 *
 * 只压紧**这一刻真的空着、而且下面还有活着的行**的那几行：
 *   - 行号可能已经被别人的保存改过（`model.rows` 里又有内容了）⇒ 跳过，别删到别人的行上；
 *   - 清空的是数据区最后一行 ⇒ 后面没有行要上移，这一趟等于把整张表重写一遍，收益为零。
 *
 * 压紧的是**夹在活人中间的空行**（不是"这一次清掉的那几行"）：压紧是另一个临界区，两次几乎同时的
 * 删除可能这样交错——A 的保存提交、A 的压紧还没跑，B 的删除落地并**先**压紧（把 A 要删的那一行顶上了
 * 别人），A 再压紧时守卫跳过 ⇒ 空档留在表里（2026-10-18 审核观察到的"并发删行后编号空档"）。
 * 反正只有"删过行"才会进这个函数，扫一遍不增加额外开销，还能把漏掉的那次一起合上。
 *
 * **为什么只扫"夹在中间"的**：数据区末尾那一大片空行是"还能填的格子"（页面就是往空行里加人，
 * `pickRowNumber` 找的是第一个空行），把它们一起压紧等于把整张表重写一遍——`dataEnd` 里有近百行空行。
 * 空档在界面上表现为**序号跳号**，而序号 = 位置（A 列公式），所以空档只可能是"中间那一格"。
 * @param {string} sheet 榜名
 * @param {number[]} rows 这一轮被清空的行号（保存那一趟收集的；只用来判断"这趟要不要压紧"）
 * @returns {Promise<{compacted: {removed: number, moved: number}|null}>} `compacted` 为 null = 没写任何格
 */
const compactClearedRows = async (sheet, rows) => {
  const wanted = (Array.isArray(rows) ? rows : []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  if (!wanted.length) return { compacted: null }
  const bindStore = await store()
  let plan = null
  return table().mutate(
    async ctx => {
      const model = ctx.model(sheet)
      /** 还有内容的行号：`model.rows` 不收整行空掉的行，所以"不在这份名单里"= 这一行现在空着 */
      const live = new Set(model.rows.map(r => r.row))
      /** 第一行与最后一行活人之间的空行（末尾那片空闲格不算空档，见函数头） */
      const first = Math.min(...live)
      const last = Math.max(...live)
      const empties = []
      for (let row = Math.max(first, model.dataStart); row < last; row++) if (!live.has(row)) empties.push(row)
      if (!empties.length) return { compacted: null }
      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      const migrated = await dropRowsAndMigrate(ctx, new Map([[sheet, empties]]), binds, state.locks)
      plan = { binds, locks: migrated.locks }
      return { compacted: { removed: migrated.removed, moved: migrated.moved }, shift: migrated.shiftRows?.[sheet] ?? {} }
    },
    { afterCommit: info => persistState(info, plan) },
  )
}


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

// `roster-sync.js` 里的整理收尾要用整理核心，经 ctx 拿（它定义在上面，不会撞 TDZ）。
installCtx({
  tidySheetsCore,
  recordChanges,
  alertOwner,
  dropRowsAndMigrate,
  snapshotBeforeWrite,
  ownershipIn,
  persistState,
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

  /**
   * 头像代理：**公开**（与 favicon 同一个理由）
   *
   * 页面里的 `<img src>` 带不了 `x-abyss-*` 请求头，而口令存在 localStorage（不是 cookie），
   * 所以这条必须排在 `authorized()` 之前；CSP 又是 `img-src 'self' data:`，外链头像根本进不来
   * ——只能从自己的源把图转出去。
   *
   * 安全边界：只认纯数字 QQ（5–12 位），上游地址按 `AVATAR_HOSTS` 白名单挑，
   * **没有任意 URL 参数**；公开也拿不到表里的数据（QQ 头像本来就是公开图）。
   */
  if (req.method === "GET" && pathname === "/api/avatar") {
    const qq = String(paramOf(req, "qq") ?? "").trim()
    if (!/^\d{5,12}$/.test(qq)) return json(res, 400, { ok: false, error: "qq 不对" })
    const hit = avatarCache.get(qq)
    if (hit && Date.now() - hit.at < AVATAR_CACHE_MS) return sendAvatar(res, hit)
    const got = await fetchAvatar(qq)
    if (!got) return json(res, 404, { ok: false, error: "没取到这个人的头像" })
    const entry = { ...got, at: Date.now() }
    avatarCache.set(qq, entry)
    if (avatarCache.size > AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value)
    return sendAvatar(res, entry)
  }

  /**
   * 固定入口页的口令兑换：**公开**（页面本身不带口令）
   *
   * 群消息里只有 6 位数字口令，没有完整 URL；用户在这里换成完整链接再跳转。
   * 这能避开 QQ 对群消息里每条新 URL 的风控，同时不需要另建一套编号表：`v` 本来就在
   * `model/editor-links.js` 的登记簿里，机器人发链接时把完整链接一起记进去。
   *
   * **口令只有 6 位数字、这个端点又是公开的**，所以必须防枚举（两轮见 `http/link-guard.js`）：
   *   1. 同一来源 IP 失败太多次 ⇒ 冷却期内一律 429（`retry-after` 给出还要等几秒）；
   *   2. 无效 / 过期回**同一句** 410，不让枚举者从响应里区分"差一点"。
   *
   * 成功兑换**不计数、不作废**（维护者 2026-11-26：链接面向所有群成员，要允许多名成员重复点）：
   * 同一条口令在 `LINK_CODE_TTL_MS`（5 分钟）内来多少次都换回同一条完整链接，过期后自然 410。
   * 失败只 `fail`，不消耗口令（否则一个问题口令就能把好的挤掉）。
   */
  if (req.method === "GET" && pathname === "/api/link-code") {
    const ip = clientIpOf(req)
    if (!linkGuard.allow(ip)) {
      const wait = Math.ceil(linkGuard.retryAfterMs(ip) / 1000)
      res.setHeader("retry-after", String(Math.max(wait, 1)))
      return json(res, 429, { ok: false, error: "试得太频繁了，请过几分钟再回群里重新发一次 #排队" })
    }
    const code = String(paramOf(req, "code") ?? "").trim()
    /** 实现已搬到 `editor/actions.js` 的 `linkCode`（进程内同一份），端点只做请求解析与响应映射 */
    const { url } = code ? await applyLinkCode(null, { code }) : { url: null }
    if (!url) {
      linkGuard.fail(ip)
      return json(res, 410, { ok: false, error: "口令不对或已过期，请回群里重新发一次 #排队" })
    }
    linkGuard.succeed(ip)
    return json(res, 200, { ok: true, url })
  }

  const adminSession = adminSessionOf(req)
  const adminCookieOk = Boolean(adminSession && roleOf({ qq: adminSession.qq }).role === "admin")

  if (!authorized(req) && !adminCookieOk) {
    if (pathname === "/" || pathname === "/index.html") {
      /** 入口页有脚本（口令兑换 / 记着的访问口令自动补回），CSP 用一次一换的 nonce */
      const nonce = crypto.randomBytes(16).toString("base64url")
      applySecurityHeaders(res, { csp: cspForPage(nonce) })
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(entryPage(nonce))
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("forbidden")
  }

  /** 管理员用 cookie 直接回来时，顺手把这 24 小时续期 */
  if (adminCookieOk) setAdminSession(req, res, adminSession.qq)

  /**
   * 链接的**时间窗**：带 `w/ws` 的链接要在当期窗口内（管理员 / 私聊链接用）
   *
   * 身份签名（`u/s`）管 30 天，这层窗口管 5 分钟（`model/identity.js` 的 `WINDOW_MS`）：
   * 机器人每 5 分钟换一批链接，旧链在路上超过一个窗口就作废。过期时刻**签在链接里**
   * （`w/ws`），所以这里不需要服务器记住"这条链是什么时候发的"。
   *
   * 这几层共存时谁先说话：
   *   1. 带 `w/ws`：验不过就**拒绝**（410 + 可读页）——旧窗口的链接一律作废；
   *   2. **没带 `w/ws` 的身份链接：照旧放行**（群友的 `#code=` 短码兑换出来的就是这一档）。
   *
   * **页面自身的请求不带窗口**：编辑器页面打开链接时把 `k/u/s/a` 收进存储、把地址栏清干净
   * （见 `editor.html` 的 `withToken()`），之后每一次 `/api/*` 都只带身份不带窗口；
   * 这些请求**按第 2 条放行**。
   *
   * 拒绝给的是 410 + 可读页面（与链接失效同一份文案）：拿到旧链的人需要知道的是
   * "回群里重新取一条"，而不是"口令错了"。
   */
  {
    /** 时间窗与身份都走 `paramOf`：**请求头优先、query 兜底**（页面自己发的请求走头，见审核 S-04） */
    const w = paramOf(req, "w")
    const ws = paramOf(req, "ws")
    if (w || ws) {
      const linkQq = String(decodeIdentity(paramOf(req, "u"))?.qq ?? "")
      if (!verifyWindow(w, ws, { qq: linkQq }, SIGN_KEY)) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        return res.end(expiredLinkPage())
      }
      /**
       * 记一笔"这条链接带的是当期的窗口"（只作诊断用）；**管理员在这里进门**并种下 24 小时的会话
       * （见 `ADMIN_SESSION_COOKIE` 的说明：窗口过了之后，管理员不再能靠"删掉 w/ws"继续当管理员）
       */
      callerNow(req).windowed = true
      if (linkQq && roleOf({ qq: linkQq }).role === "admin") setAdminSession(req, res, linkQq)
    }
    /**
     * **没带 `w/ws` 却有身份链接（`u/s` 那一档）：照旧放行**
     *
     * 群友的 `#code=` 短码兑换出来的就是这一档：身份签名本身管 30 天，没有 5 分钟窗口。
     * 能写多少不在这里判——由**本群守卫**（`memberStateOf`）、额度与三条红线决定。
     */
  }

  /**
   * **管理员身份必须有当期窗口、或者窗口进门时种下的会话**（2026-10-18 审核 P1）
   *
   * 管理链接的 `w/ws` 只有 5 分钟，而"带身份、不带窗口"是放行的 ⇒ 把窗口参数删掉，就能让一条
   * 老管理链接在身份签名的 30 天里一直当管理员。现在：管理员只能从"窗口刚验过的那一刻"进门
   * （那一刻已种下 24 小时的会话 cookie，见 `setAdminSession`）；这之后不带窗口的管理员请求
   * 要么带会话 cookie，要么按**过期链接**处理（410 + 提示页，让用户回群里重新取链接）。
   *
   * 管理口令（`?a=`）不走这条路：它是独立的静态凭证，由页面存起来按请求头带，与时间窗无关。
   */
  {
    const state = callerNow(req)
    const qq = String(state.value?.identity?.qq ?? "").trim()
    if (state.value?.role === "admin" && !state.windowed && !state.value?.adminTokenOk && qq && !adminSessionOk(req, qq)) {
      logThrottled(
        `admin-window|${qq}`,
        `[editor] 管理员身份没有当期窗口、也没有会话 cookie（qq=${qq}，${pathname}）：按过期链接处理`,
      )
      res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(expiredLinkPage())
    }
  }

  /**
   * 只给主人用（本机编辑器用这个开关开着）
   *
   * 本机那份是云端数据的备份/工作副本，只让主人碰：其他人一律挡在门外，
   * 免得群友在本机界面上改到备份、又被传回云端。
   * 例外是几个**只读且不含表格数据**的口子，它们本来就只凭口令放行：
     *   - `/api/version`：推表前问一版（只回表指纹）
   *   - `/api/meta`：页面元信息（页脚 HTML / 版本 / 版本份数）——不给的话"需要口令"页也拉不到页脚
   *   - `/healthz`：启动器 / 运维探活
   */
  if (
    OWNER_ONLY &&
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
       * `__NONCE__` 换成**这一次响应现生成**的随机串，并把首页那份 CSP 换成"只认这个 nonce"的版本
       * （审核 S-03）：页面里两段内联 `<script>` 都带 `nonce="__NONCE__"`，被塞进来的第三方脚本
       * 没有这个 nonce 就执行不起来——这是 S-01/S-02 两个 innerHTML 面之外的最后兜底。
       * 每次响应都换：nonce 一旦可预测（比如写成常量）就等于没有。
       */
      const nonce = crypto.randomBytes(16).toString("base64url")
      applySecurityHeaders(res, { csp: cspForPage(nonce) })
      /**
       * 走 `sendText`：这是 200 KB 级的单文件页，按 `Accept-Encoding` 回 gzip / br。
       * 每响应现生成 nonce，同一 URL 的字节每次都不同，所以压不了静态副本、只能现压（见 `respond.js`）。
       */
      return sendText(
        req,
        res,
        200,
        html
          .replaceAll("__MOUNT__", prefix)
          .replaceAll("__NONCE__", nonce),
        { headers: { "cache-control": "no-store" } },
      )
    }
    /**
     * 编辑器页面的中文字体（原神标准字体：汉仪文黑-65W）
     *
     * 字体**随源码入库**（`resources/common/font/`，与 Axiu-Plugin / Atlas-Plugin 同位置），
     * 这里只是把它按固定路径吐出去，**没有任何下载或缓存逻辑**；
     * 拿不到就 404，页面自动回落到系统中文（英文数字由页面的 Times New Roman 负责）。
     */
    if (req.method === "GET" && FONT_FILES.has(pathname)) {
      try {
        const buf = await fsp.readFile(path.join(PLUGIN_DIR, "resources", "common", "font", FONT_FILES.get(pathname)))
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
     * 当前表版本（只凭口令）
     *
     * "本机 → 云端"推表之前先问一句云端现在是哪一版，再由上传把它带回来：
     * 中间要是有人改过云端，上传会被拒（冲突），而不是把别人的改动盖掉（AQ-06）。
     *
     * **`?fast=1` 给页面轮询用**（实时刷新那条路，见 `editor.html` 的 `pollVersion`）：
     * 它在内存里按 `mtime:size` 认一版，没变就直接回上次算出来的指纹（省掉每次读盘 + sha256 的
     * 几百 KB I/O）。**默认（不带 `fast`）照旧现读现算**——推表那条路要的是准，不是快。
     * 两者的差别只在"同一个毫秒里写了两次同样大小的内容"这种极限情况下才看得见，
     * 而轮询只是"要不要去拉一份新的"，晚一轮发现是自愈的。
     */
    if (req.method === "GET" && pathname === "/api/version")
      return json(res, 200, {
        ok: true,
        version: url.searchParams.get("fast") ? await fingerprintFast() : await table().fingerprint(),
      })

    /**
     * 页面元信息：**只凭口令**（与 /api/version 同一档）
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

    /**
     * 枪战版本表是锅巴配置的一部分，编辑器页面可能在配置改动前就打开了。
     * 单独给一个轻量接口，让页面回到前台/打开选择器时只刷新这一小块，
     * 不重读整张表，也不把用户正在编辑的草稿冲掉。
     */
    if (req.method === "GET" && pathname === "/api/attack-versions")
      return json(res, 200, { ok: true, versions: attackVersions() })

    /** 身份判定**只用一份**（见上面的 `resolvedCallers`：链接身份优先，没有链接才看 24 小时会话 cookie） */
    const caller = callerNow(req).value
    /** 手动收录名单（「帮帮完成情况」的临时成员）：首个请求读一次，之后走内存 */
    await ensureExtraNames()
    if (req.method === "GET" && pathname === "/api/data") {
      /**
       * 链接身份里的 `n` 只带签发那一刻的群名片；浏览器里没有 QQ 的本地缓存时，
       * 页面就只能拿这个旧值显示。它偶尔会是 QQ 号（现场：复制到浏览器后
       * 「群昵称」变成 QQ 号）。群名单/绑定里如果有这个 QQ 的现用名，以现用名为准，
       * 避免页面、`syncIdentity` 把表里的昵称也一起改回 QQ 号。
       *
       * 只补空值和 QQ 号：链接里带着有效群昵称时仍以它为准，不能拿旧名单把
       * 「刚改的新名片」又改回去。
       */
      if (caller.identity) {
        const linkNick = String(caller.identity.nick ?? "").trim()
        const qq = String(caller.identity.qq ?? "").trim()
        if (!linkNick || linkNick === qq) {
          const latestNick = await nickOf(qq)
          if (latestNick) caller.identity.nick = latestNick
          else if (linkNick === qq) caller.identity.nick = ""
        }
      }
      /**
       * 先确认绑定/锁是**对着这一版表**的（整表替换或外部改表之后就不是了）：
       * 对不上就按群昵称重新对账，绝不拿旧行号认人（AQ-03）
       */
      await alignOwnership()
      /**
       * 只读的那几档（访客 / 名单不可信 / 名单里没有他）**只查不写**：
       * 身份同步会改表里的群昵称、完成情况署名和绑定，不能让人"看一眼表"就顺手落盘。
       *
       * 判定口径与 `buildPayload` 里的 `perm.readonly` 是同一个式子，这里先算好再传进去；
       * 两处各算一遍的话，以后改一处就会漂移。
       */
      const member = memberStateOf(caller)
      const readonly = caller.role === "guest" || member === false
      /** 再按 QQ 认人（顺手同步改了名片的昵称、记下绑定），最后按身份裁剪数据 */
      const sync = readonly ? { renamed: 0, bound: 0, dropped: 0 } : await syncIdentity(caller)
      /** 管理员打开时，把表里手填、下拉里没有的名字归档成选项 */
      const archived = await archiveOptions(caller)
      /** 管理员打开时，到点的榜把残留的「等待开启」翻成「排队中」 */
      const opened = await catchUpOpenStatus(caller)
      const payload = await buildPayload(caller, req, { member })
      /** 有人打开页面时顺手看一眼群名单新不新（名单不新 ⇒ 新的权限口径静默失效，得让主人知道） */
      maybeAlertStaleRoster()
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
      /**
       * 被拒绝的保存**也要留痕**（`kind: "reject"`）：拒绝对审计最有价值——"谁在试"和"谁改成了"一样重要。
       *
       * 位置放在这里（拿到 body 之后、`applySave` 之外）：拒绝时那个"逐字段差异"还没算完就被拦下了，
       * 所以记的是**试图改哪几行 + 原因**。没有 body 的那一档（访客 403）不记——那一条由
       * `editor/audit.js` 的请求级审计覆盖，记在这里只是重复。
       */
      let out = null
      try {
        out = await applySave(caller, body, req)
      } catch (err) {
        recordChanges([
          {
            kind: "reject",
            at: Date.now(),
            sheet: String(body?.sheet ?? ""),
            rows: (Array.isArray(body?.rows) ? body.rows : []).map(r => Number(r?.row)).filter(Boolean),
            reason: err?.conflict ? "版本冲突（表被改过，这一份一个字都没写）" : String(err?.message ?? err),
            version: table().version,
            ...changeAuthor(caller),
          },
        ])
        throw err
      }
      auditLog.note(req, {
        sheet: body?.sheet,
        rows: Array.isArray(body?.rows) ? body.rows.length : undefined,
        written: out?.written,
        cleared: out?.cleared,
      })
      /**
       * 回执里带上**写完之后**那一版的 `version`：页面拿它立刻更新自己的版本号，
       * 于是"保存成功但重读失败"时再点重试不会撞 409（数据早落表了）——2026-10-10 审核 B-07。
       */
      return json(res, 200, { ok: true, ...out, version: table().version })
    }

    /**
     * 呼叫某一行的绑定 QQ（`POST /api/call`）
     *
     * 只给管理员：编辑器本身发不出群消息，真正发送走宿主注入的
     * `injectGroupCall`。无绑定 / 多绑定 / 绑定与当前昵称对不上都直接拒绝。
     */
    if (req.method === "POST" && pathname === "/api/call") {
      if (caller.role !== "admin") return json(res, 403, { ok: false, error: "只有主人或白名单管理员可以呼叫" })
      const body = await readBody(req)
      try {
        const out = await applyCall(caller, body)
        auditLog.note(req, { op: "call", sheet: body?.sheet, row: body?.row, group: out.group })
        return json(res, 200, out)
      } catch (err) {
        return json(res, Number(err?.statusCode) || 400, { ok: false, error: err.message })
      }
    }

    /**
     * 呼叫主播区某一位（`POST /api/anchor-call`）
     *
     * 所有人可用：有身份即可；普通成员由 `applyAnchorCall` 做 5 分钟限频，
     * 管理员/主人不限。与成员行的 `/api/call` 分开。
     */
    if (req.method === "POST" && pathname === "/api/anchor-call") {
      const body = await readBody(req)
      try {
        const out = await applyAnchorCall(caller, body)
        auditLog.note(req, { op: "anchor-call", sheet: body?.sheet, row: body?.row, group: out.group })
        return json(res, 200, out)
      } catch (err) {
        return json(res, Number(err?.statusCode) || 400, { ok: false, error: err.message })
      }
    }

    /**
     * 插队：把某一行挪到这一榜所有「排队中」的人最前面（`#插队` 调的就是这里）
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
      /** 留痕：**顺序**也是数据的一部分（谁把谁插到第几位），一次插队记一条 */
      recordChanges([
        {
          kind: "order",
          at: Date.now(),
          sheet: String(body?.sheet ?? ""),
          row: Number(body?.row) || 0,
          current: out?.moved ? Number(out.to) : Number(body?.row) || 0,
          from: Number(out?.from) || 0,
          to: Number(out?.to) || 0,
          moved: Number(out?.moved) || 0,
          version: table().version,
          ...changeAuthor(caller),
        },
      ])
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 每日整理：按「已完成 → 等待开启 → 排队中」分组，
     * 组内按难度/目标/强度排序（规则见 `reorder.js`）
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

    /**
     * 周期清榜 / 等待行翻排队中：**只认机器人身份或主人**
     *
     * 机器人先下载完整快照、在本地归档成功后才调这里；失败不推进状态，下一轮重试。
     */
    const canRunCycle = () =>
      (Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ) || canManageAdmins(caller)

    /** 先问“这一轮清过没有”：客户端在归档前先查，避免重试覆盖归档 */
    if (req.method === "GET" && pathname === "/api/cycle/status") {
      if (!canRunCycle()) return json(res, 403, { ok: false, error: "只有机器人或主人能查询周期清榜状态" })
      const eventKey = String(url.searchParams.get("eventKey") ?? "").trim()
      if (!eventKey) return json(res, 400, { ok: false, error: "缺少 eventKey" })
      const out = await applyCycleStatus(caller, { eventKey })
      return json(res, 200, { ok: true, ...out })
    }

    if (req.method === "POST" && pathname === "/api/cycle") {
      if (!canRunCycle()) return json(res, 403, { ok: false, error: "只有机器人或主人能执行周期清榜" })
      const body = await readBody(req)
      try {
        const out = await applyCycle(caller, body)
        if (!out?.skipped)
          auditLog.note(req, {
            op: "cycle",
            sheet: body?.sheet,
            mode: body?.mode,
            eventKey: String(body?.eventKey ?? "").trim().slice(0, 200),
            cleared: out?.cleared,
            promoted: out?.promoted,
          })
        return json(res, 200, { ok: true, ...out })
      } catch (err) {
        /** 不是清榜协议的错误（账本 / intent 读不出来）照旧交给外层：与搬走前同一个 400 口径 */
        if (!err?.statusCode) throw err
        return json(res, Number(err.statusCode), {
          ok: false,
          ...(err?.pending ? { pending: true } : {}),
          ...(err?.conflict ? { conflict: true } : {}),
          error: err?.message ?? String(err),
        })
      }
    }

    /** 清榜前核查：仅机器人/主人可写；只改仍排队的行，不做清榜/归档 */
    if (req.method === "POST" && pathname === "/api/check-done") {
      if (!canRunCycle()) return json(res, 403, { ok: false, error: "只有机器人或主人能写清榜核查结果" })
      const body = await readBody(req)
      try {
        const out = await applyCheckDone(caller, body)
        auditLog.note(req, { op: "check-done", sheet: body?.sheet, updated: out.updated })
        return json(res, 200, { ok: true, ...out })
      } catch (err) {
        if (err?.conflict) return json(res, 409, { ok: false, conflict: true, error: err?.message ?? "表格版本冲突" })
        return json(res, 400, { ok: false, error: err?.message ?? String(err) })
      }
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
     * POST { sheet, name } → 记进表旁的收录名单；**只在当前月、当前榜有效**，
     * 下个月自动失效（不是永久候选，也不会写进表里的下拉验证）。
     */
    if (req.method === "POST" && pathname === "/api/status-names") {
      /**
       * 收录本月临时成员：**本群成员都能用**（主播编辑仍限管理员）
       *
       * 拦访客与只读：访客没有身份、只读（不在群）本来也不能改表，
       * 让他们往名单里塞名字只会让下拉里长出查无此人的选项。
       */
      const readonlyCaller = caller.role === "guest" || memberStateOf(caller) === false
      if (readonlyCaller) return json(res, 403, { ok: false, error: "只有本群成员可以收录名字" })
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
      if (req.method === "GET") {
        const audit = await ownershipAudit()
        /**
         * QQ → 群昵称（查不到就是空串）
         *
         * 归属页要并排显示「QQ 号」和「群昵称」两列：只给 QQ 的话，
         * 主人得自己拿号去群名单里翻，一条一条对着看根本认不出是谁。
         * 同一份映射也给退群候选（没有 QQ 的行），那边昵称来自表格本身，不查群名单。
         */
        const qqList = [...new Set((audit.sheets ?? []).flatMap(s => (s.entries ?? []).map(e => e.qq)).filter(Boolean))]
        const nicks = {}
        for (const qq of qqList) nicks[qq] = await nickOf(qq)
        return json(res, 200, { ok: true, ...audit, nicks, missing: await missingCandidates() })
      }
      if (req.method === "POST") {
        const body = await readBody(req)
        const action = String(body?.action ?? "").trim()
        /** 只认显式动作：不写 action 就当参数错误，免得一个手滑的 POST 就把归属全重建了 */
        if (action === "rebuild") {
          const out = await rebuildOwnershipNow()
          auditLog.note(req, { op: "rebuild", kept: out?.kept?.length, dropped: out?.dropped?.length })
          return json(res, 200, { ok: true, ...out })
        }
        /** 删掉主人确认过的"退群候选行"（只删他点名的那几行，见 `pruneMissingRows`） */
        if (action === "prune-missing") {
          const out = await pruneMissingRows(body?.rows)
          auditLog.note(req, { op: "prune-missing", removed: out.removed })
          return json(res, 200, { ok: true, ...out })
        }
        return json(res, 400, { ok: false, error: '请求格式不对：需要 { action: "rebuild" } 或 { action: "prune-missing", rows }' })
      }
    }

    /**
     * 改动记录（留痕）：谁在什么时候改了哪一行的哪个字段
     *
     * **可见范围按身份分**（与 `/api/data` 的裁剪同一套思路）：
     *   - 主人 / 管理口令 / 白名单管理员 → 全部记录；
     *   - 本人（`self`）→ **自己发的** + **改到自己名下那些行的**（别人动了我的行，我得看得见）；
     *   - 访客 → 403（没有身份就没有"我的行"这个概念）。
     *
     * `limit` 只做上限（默认 200、最多 1000）：返回**新的在前**，页面直接顺着渲染。
     */
    if (req.method === "GET" && pathname === "/api/changes") {
      if (caller.role === "guest") return json(res, 403, { ok: false, error: "这个链接里没有你的身份，看不到改动记录" })
      const all = caller.role === "admin"
      const want = Number(url.searchParams.get("limit")) || 200
      const limit = Math.min(1000, Math.max(1, want))
      /** 本人视角要"我那些行"：与页面看到的行是同一份口径（`mineRows`） */
      const mine = all ? null : await mineRows(caller)
      return json(res, 200, {
        ok: true,
        all,
        keep: CHANGES_KEEP,
        entries: changes.list({ limit, all, qq: caller.identity?.qq ?? "", mine }),
      })
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
     * **身份要连当期时间窗一起签**：这样签出来的身份与"当期链接"完全同形，云端用同一套验签；
     * 注意 2026-10 之后已经**没有**"没带 `w/ws` 就按旧链 410"这条门了（链接身份自己就是凭证），
     * 带上窗口只是把身份签得更完整、不依赖任何豁免分支。
     * 推之前先问一下云端当前版本并原样带回去：中间云端有人写过就变成冲突，而不是把人家的改动盖掉。
     */
    if (req.method === "POST" && pathname === "/api/push-cloud") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能把本机的表传上云端" })
      if (!CLOUD_URL) return json(res, 400, { ok: false, error: "本机没配云端地址（--cloud / ABYSS_EDITOR_CLOUD）" })
      const bytes = await fsp.readFile(xlsxPath)
      const who = { qq: caller.identity?.qq ?? "", nick: caller.identity?.nick ?? "" }
      const id = signIdentity(who, SIGN_KEY)
      const win = signWindow(who, SIGN_KEY)
      /** 调用者的 24 小时管理员会话 cookie 原样转给云端：云端据此认得"这是主人本人登进来的那台浏览器" */
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
     * 实现与规则在 `editor/actions.js` 的 `roster`（`applyRoster`），这里只留权限门与审计。
     */
    if (req.method === "POST" && pathname === "/api/roster") {
      const fromBot = Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ
      if (!fromBot && !canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有机器人或主人能推送群成员名单" })
      const body = await readBody(req)
      try {
        const out = await applyRoster(caller, body)
        auditLog.note(req, { group: body?.group, members: out.total })
        return json(res, 200, out)
      } catch (err) {
        if (!err?.statusCode) throw err
        return json(res, Number(err.statusCode), { ok: false, error: err?.message ?? String(err) })
      }
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
      /**
       * QQ → 群昵称（查不到就是空串）
       *
       * 白名单只存 QQ，页面上「成员」一列得显示人名字，否则整行只有一串数字，
       * 与「角色」列并排时看着像两列重复（这个 bug 就是这么来的）。
       */
      const qqList = [...new Set([...loadOwners(), ...loadAdmins(), ...ENV_ADMINS])]
      const nicks = {}
      for (const qq of qqList) nicks[qq] = await nickOf(qq)
      const payload = {
        ok: true,
        admins: loadAdmins(),
        owners: loadOwners(),
        env: ENV_ADMINS,
        file: fromFile,
        nicks,
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
    if (err instanceof BodyTooLarge) {
      /**
       * 先把剩余请求体读掉，再回 400：客户端还在灌字节时立刻关连接，响应会被 RST 吃掉。
       * drain 只丢弃、不保留分块；最多等 5 秒，不能为了一个坏请求把连接一直挂着。
       */
      await drainRequest(req)
      res.setHeader("connection", "close")
    }
    /**
     * 冲突分两种，都回 409，但页面要区别对待：
     *   - `conflictRows` 非空：**行级冲突**（你改的那几行被人动过）——页面只把那几行挂起，其余照旧能存；
     *   - 没有 `conflictRows`：**整表冲突**（表被整表替换过）——页面暂停自动保存，等用户核对。
     */
    json(res, err?.conflict ? 409 : 400, {
      ok: false,
      conflict: Boolean(err?.conflict),
      rows: err?.conflictRows ?? undefined,
      error: err?.message ?? String(err),
    })
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
const isMain = process.argv[1]
  ? process.platform === "win32"
    ? path.resolve(process.argv[1]).toLowerCase() === SELF_PATH.toLowerCase()
    : path.resolve(process.argv[1]) === SELF_PATH
  : false
if (isMain) startEditor()

/** 装配结果（路径 / 开关 / 落点）：给"挂到 bot 上"那一路读挂载前缀、口令与表路径用 */
export { cfg }
