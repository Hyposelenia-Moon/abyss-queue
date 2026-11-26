/** 排队表在线编辑器（零额外依赖：只用 node 内置模块 + jszip） */
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

const { config } = internal

installCtx({ config })

const shared = rel => import(pathToFileURL(path.join(PLUGIN_DIR, rel)).href)

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

const innerPath = pathname => {
  if (MOUNT && (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`))) {
    const rest = pathname.slice(MOUNT.length)
    return rest === "" ? "/" : rest
  }
  return pathname
}

const { JsonTable } = await shared("model/json-table.js")
const { docFileOf } = await shared("model/queue-doc.js")
const { BindStore } = await shared("model/store.js")
const { readLinkTarget } = await shared("model/editor-links.js")
const { matchOption, locateSelf } = await shared("modules/queue.js")
const { canonicalAnchor, compileAliases } = await shared("components/aliases.js")
const { groupNameOfAnchor, readAnchorNames } = await shared("model/anchor-names.js")
const { pluginVersion } = await shared("components/pluginVersion.js")

let TABLE = null
let STORE = null

const STATE_PATH = docFileOf(xlsxPath)

initCycleLedger({ dataBase: DATA_BASE })
const table = () => (TABLE ??= new JsonTable({ file: STATE_PATH, mirror: xlsxPath }))
const store = () => (STORE ??= new BindStore(path.join(DATA_BASE, "abyss-editor-bindings.json")).load())

const queueFrontOf = sheet => {
  const list = STORE?.data?.queueFront?.[sheet]
  return Array.isArray(list) ? list.map(name => String(name ?? "").trim()).filter(Boolean) : []
}

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

const roster = createRoster({ rosterFile: ROSTER_FILE, store, trustMs: ROSTER_TRUST_MS })
const { loadRoster, saveRoster, nickCandidates, nickOf, avatarOf, isMember, trusted: rosterTrusted, ageMs: rosterAgeMs } = roster

const linkByCode = code => readLinkTarget(code, { file: LINKS_FILE })

const changes = createChanges({ file: CHANGES_FILE, keep: CHANGES_KEEP })

const quota = createQuota({
  file: QUOTA_FILE,
  maxPerSave: QUOTA_MAX_PER_SAVE,
  windowMs: QUOTA_WINDOW_MS,
  maxPerWindow: QUOTA_MAX_PER_WINDOW,
})

const alerts = createAlerts({
  send: payload => {
    const hook = injectedOwnerAlert()
    if (!hook) return null
    return hook({ ...payload, owners: loadOwners() })
  },
  log: (level, line) => (injectedLog() ? injectedLog()(line) : console.log(line)),
})

const alertOwner = (caller, { kind, text, force = false }) =>
  alerts.alert({ qq: caller?.identity?.qq ?? "", nick: caller?.identity?.nick ?? "", kind, text, force })
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

const versions = createVersions({
  versionsDir: VERSIONS_DIR,
  archivesDir: ARCHIVES_DIR,
  xlsxPath,
  versionsKeep: VERSIONS_KEEP,
  archiveDays: ARCHIVE_DAYS,
  archivesKeep: ARCHIVES_KEEP,
})
const { listVersions, listArchives, snapshotBeforeWrite } = versions

const ownership = createOwnership({ store, table, loadLocks, saveLocks, loadRoster, locateSelf })
const { ownershipIn, persistState, alignOwnership, ownershipAudit, rebuildOwnershipNow, mineRows } = ownership

import { defaultStatusOf, statusWithSelfDone, statusTokens, statusLabels, statusRenamePlan, isDoneStatus, attackDisplayStatus, cycleDisplayStatus } from "./status.js"

const cyclePlan = (now = new Date()) => {
  const at = new Date(now)
  const iso = d => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null)
  const reminderOf = clear => {
    const r = new Date(clear.getTime() - 24 * 60 * 60 * 1000)
    r.setHours(12, 0, 0, 0)
    return r
  }
  const rows = []
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
  {
    const c = abyssCycle(at)
    const past = at.getTime() >= c.clear.getTime()
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
  {
    const c = stygianCycle(at)
    const past = at.getTime() >= c.clear.getTime()
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

const anchorCallCooldown = new Map()

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

const applyAnchorCall = async (caller, { sheet, row } = {}) => {
  const callerQq = String(caller.identity?.qq ?? "").trim()
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
      renamedRows = actions.filter(a => a.hit.renamedFrom !== undefined && a.hit.row && !blank(a.hit.nick))
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

const lockWorthy = (value, nickname) => {
  const tokens = statusLabels(value).filter(token => !PENDING_STATUS.includes(token))
  if (!tokens.length) return false
  if (tokens.every(t => PENDING_STATUS.includes(t))) return false
  const nick = String(nickname ?? "").trim()
  return !tokens.every(t => t === SELF_DONE || (Boolean(nick) && t === nick))
}

const lockIsLive = (row, locks, sheet) => Boolean(row && locks?.[lockKey(sheet, row.row)]) && lockWorthy(row.status, row.nickname)

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

const { applySecurityHeaders, cspForPage, json, sendText, paramOf, readBody, readRawBody, drainRequest, FEATURES, BodyTooLarge } =
  await import("./http/respond.js")
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
  linkByCode,
  CYCLE_PROTOCOL,
  cycleExclusive,
  loadCycleLedger,
  saveCycleLedger,
  readCycleIntent,
  createCycleIntent,
  removeCycleIntent,
  isDoneStatus: status => isDoneStatus(status),
  loadRoster,
  saveRoster,
  reconcileRoster: members => reconcileRoster(members),
  nickCandidates,
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

const linkGuard = createLinkGuard()

const LOG_THROTTLE_MS = 10 * 60 * 1000
const logThrottle = new Map()
const logThrottled = (key, message) => {
  const now = Date.now()
  if (now - (logThrottle.get(key) ?? 0) < LOG_THROTTLE_MS) return
  logThrottle.set(key, now)
  if (logThrottle.size > 500) {
    for (const [k, t] of logThrottle) if (now - t >= LOG_THROTTLE_MS) logThrottle.delete(k)
  }
  console.log(message)
}

const resolvedCallers = new WeakMap()
function callerNow(req) {
  if (resolvedCallers.has(req)) return resolvedCallers.get(req)
  let value = callerOf(req)
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

const { adminSessionOf, adminSessionOk, setAdminSession } = createSession({ signKey: SIGN_KEY })

const auditLog = makeAuditLog({ log: injectedLog() ?? (line => console.log(line)), callerOf: req => callerNow(req).value })

const { footerHtml, entryPage, ownerOnlyPage, expiredLinkPage } = createPages({ footHtml: FOOTER_HTML })

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

export async function syncAttackStatuses() {
  let changed = 0
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
  tidied = await tidySheetsCore(ATTACK_SHEET, { snapshotThrottleMs: AUTOSAVE_SNAPSHOT_MS })
  return { changed, tidied }
}

const AVATAR_CACHE_MS = 30 * 60 * 1000
const AVATAR_CACHE_MAX = 400
const avatarCache = new Map()

const AVATAR_HOSTS = new Set(["q.qlogo.cn", "p.qlogo.cn", "api.dicebear.com"])

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
    }
  }
  return null
}

const sendAvatar = (res, { buf, type }) => {
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(buf.length),
    "cache-control": "private, max-age=3600",
  })
  return res.end(buf)
}

export function startEditor() {
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

export { cfg }
