/** 队列视图：把表读成前端要的 payload（`buildPayload`）以及它用到的行/视图小工具。 */
import fs from "node:fs"
import { attackStatusParts } from "../components/attack.js"
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { groupNameOfAnchor, readAnchorNames } from "../model/anchor-names.js"
import { extraNamesOf } from "./cycle-ledger.js"
import { ctx } from "./ctx.js"
import { FIELDS, MOVE_COLUMN_KEYS, ANCHOR_FIELDS, blank, WAITING_STATUS, QUEUED_STATUS, OPEN_RULES, PUBLIC_ANCHOR, PUBLIC_QUEUE_NAME, SHEET_SHORT, sheetShortOf, ANCHOR_CALL_COOLDOWN_MS, ANY_ANCHOR, PENDING_STATUS, SELF_DONE, EXCLUSIVE_VALUES, ANCHOR_FIRST_ROW, APPEND_ROWS_MAX, REPLACE_REQUIRED_COLUMNS, CYCLE_PROTOCOL } from "./defs.js"
import { bindView } from "./ownership.js"
import { attackDisplayStatus, cycleDisplayStatus, defaultStatusOf, isDoneStatus, statusLabels, statusWithSelfDone } from "./status.js"

export const cleanNickValue = value => String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "")

export const normNick = value => cleanNickValue(value).trim().toLowerCase()

export const rosterQqOfNick = nick => {
  const want = normNick(nick)
  if (!want) return ""
  const hits = (ctx.roster.loadRoster().members ?? []).filter(m => normNick(m?.nick) === want)
  return hits.length === 1 ? String(hits[0].qq ?? "") : ""
}

export const anchorQqOf = (name, mapping = null) => {
  const text = String(name ?? "").trim()
  if (!text) return ""
  const names = mapping ?? readAnchorNames()
  const mapped = String(groupNameOfAnchor(text, names) ?? "").trim()
  const list = compileAliases(ctx.config.anchor_aliases)
  const canonical = canonicalAnchor(text, list)
  const mappedCanonical =
    canonical === text ? mapped : String(groupNameOfAnchor(canonical, names) ?? "").trim()
  const candidates = new Set([text, canonical, mapped, mappedCanonical])
  for (const a of list) {
    if (a.name !== canonical && !a.re.test(text) && !a.re.test(canonical)) continue
    candidates.add(a.name)
    if (!/[.*+?^${}()|[\]\\]/.test(a.pattern)) candidates.add(a.pattern)
  }
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim()
    if (!value) continue
    if (/^\d{5,12}$/.test(value)) return value
    const qq = rosterQqOfNick(value)
    if (qq) return qq
  }
  return ""
}

export const anchorQueueCounts = model => {
  const out = new Map()
  const anchorNames = new Set(
    (model?.anchors ?? []).map(a => String(a.name ?? "").trim()).filter(Boolean),
  )
  const bump = (name, kind) => {
    if (!name) return
    const c = out.get(name) ?? { queued: 0, waiting: 0, done: 0 }
    c[kind] += 1
    out.set(name, c)
  }
  for (const row of model?.rows ?? []) {
    const parts = attackStatusParts(row.status)
    const kind = parts
      ? parts.some(p => p.kind === "queued")
        ? "queued"
        : parts.some(p => p.kind === "waiting")
          ? "waiting"
          : "done"
      : String(row.status ?? "").trim() === QUEUED_STATUS
        ? "queued"
        : String(row.status ?? "").trim() === WAITING_STATUS
          ? "waiting"
          : isDoneStatus(row.status)
            ? "done"
            : ""
    if (!kind) continue
    const selected = new Set(
      String(row.anchor ?? "")
        .split(/[,，、]/)
        .map(s => s.trim())
        .filter(Boolean),
    )
    if (kind === "done") {
      if (selected.has(PUBLIC_ANCHOR)) {
        bump(PUBLIC_ANCHOR, "done")
        continue
      }
      const nick = String(row.nickname ?? "").trim()
      const labels = statusLabels(row.status)
        .map(s => s.trim())
        .filter(s => s && s !== nick && s !== SELF_DONE && !PENDING_STATUS.includes(s))
      for (const label of new Set(labels)) {
        if (anchorNames.has(label)) bump(label, "done")
      }
      continue
    }
    for (const name of selected) bump(name, kind)
  }
  return out
}

export const queueTextOf = c => {
  const bits = []
  if (c?.queued) bits.push(`排队 ${c.queued}`)
  if (c?.waiting) bits.push(`等待 ${c.waiting}`)
  if (c?.done) bits.push(`完成 ${c.done}`)
  return bits.join(" · ") || "排队 0"
}

export const queuePillsOf = c => {
  const pills = []
  if (c?.queued) pills.push({ label: `排队中 ${c.queued}`, tone: "status-queued" })
  if (c?.waiting) pills.push({ label: `等待开启 ${c.waiting}`, tone: "status-attack-waiting" })
  if (c?.done) pills.push({ label: `已完成 ${c.done}`, tone: "status-self" })
  return pills.length ? pills : [{ label: "排队中 0", tone: "status-queued" }]
}

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
import { effectiveOptions } from "./anchors.js"

export const buildPayload = async (caller, req = null, seen = null) => {
  const locks = ctx.acl.loadLocks().rows
  const member = seen ? seen.member : memberStateOf(caller)
  const roam = member === true
  const mine = caller.role === "self" ? await ctx.ownership.mineRows(caller) : null
  const bindStore = caller.role === "admin" ? await ctx.store() : null
  const binds = bindStore ? bindView(bindStore.data.binds ?? {}) : null
  const data = await ctx.table().read(({ models }) => {
    const sheets = []
    for (const model of models.values()) {
      const rows = model.rows
        .filter(r => caller.role !== "self" || roam || mine.get(model.name)?.has(r.row))
        .map(r => {
          const o = { row: r.row, seq: r.seq ?? "" }
          for (const f of FIELDS) o[f.key] = r[f.key] ?? ""
          o.status = statusWithSelfDone(o.status, o.nickname)
          o.status = cycleDisplayStatus(model.name, o.status)
          o.status = attackDisplayStatus(model.name, o.goal, o.status)
          o.statusLocked = caller.role !== "admin" && ctx.lockIsLive(r, locks, model.name)
          if (caller.role === "admin") {
            const call = callTargetOf(binds, model.name, r.row, o.nickname)
            const parts = attackStatusParts(o.status)
            const queued = parts ? parts.some(part => part.kind === "queued") : o.status === QUEUED_STATUS
            o.callable = call.ok && queued
            o.callReason = !queued ? "该成员不在排队中，无法呼叫" : call.ok ? "" : call.error
          }
          o.fp = rowFingerprint(r)
          return o
        })
      const anchors = model.anchors.map(a => a.name).filter(Boolean)
      sheets.push({
        name: model.name,
        title: model.title,
        dataStart: model.dataStart,
        dataEnd: model.dataEnd,
        options: effectiveOptions(model),
        statusTemp: extraNamesOf(model.name),
        anchors,
        rows,
        taken: caller.role === "self" ? model.rows.map(r => r.row) : undefined,
        defaults: { status: /攻炼|绝境/.test(model.name) ? WAITING_STATUS : defaultStatusOf(model.name) },
        anchorRows: (() => {
          const counts = anchorQueueCounts(model)
          const rowOf = (a, c, extra = {}) => {
            const queuePills = queuePillsOf(c)
            return {
              row: a.row,
              name: a.name,
              recommend: a.recommend,
              duty: a.duty,
              skills: a.skills,
              platform: a.cells?.platform ?? "",
              link: a.cells?.link ?? "",
              entry: a.entry,
              queued: c.queued,
              waiting: c.waiting,
              done: c.done,
              queueText: queueTextOf(c),
              queuePills,
              callable: Boolean(extra.callable),
              callReason: extra.callReason ?? "",
              isPublic: Boolean(extra.isPublic),
            }
          }
          const out = []
          for (const a of model.anchors) {
            if (String(a.name ?? "").trim() === PUBLIC_ANCHOR) continue
            const callQq = anchorQqOf(a.name)
            const c = counts.get(String(a.name ?? "").trim()) ?? { queued: 0, waiting: 0, done: 0 }
            out.push(rowOf(a, c, {
              callable: Boolean(callQq),
              callReason: callQq ? "" : "群名单里找不到唯一对应的主播 QQ（含别名归一）",
            }))
          }
          return out
        })(),
        publicQueue: (() => {
          const c = anchorQueueCounts(model).get(PUBLIC_ANCHOR)
          const queuePills = []
          if (c?.queued) queuePills.push({ label: `排队中 ${c.queued}`, tone: "status-queued" })
          if (c?.waiting) queuePills.push({ label: `等待开启 ${c.waiting}`, tone: "status-attack-waiting" })
          if (!queuePills.length) return null
          return {
            name: PUBLIC_QUEUE_NAME,
            queued: c.queued,
            queuePills,
          }
        })(),
      })
    }
    return { sheets }
  })
  return {
    file: ctx.xlsxPath,
    fields: FIELDS,
    version: ctx.table().version,
    roster: (() => {
      const r = ctx.roster.loadRoster()
      const canSee = member !== false
      return {
        group: r.group,
        updatedAt: r.updatedAt,
        count: (r.members ?? []).length,
        candidates: canSee ? ctx.roster.nickCandidates() : [],
      }
    })(),
    sheets: data.sheets,
    mineRows: mine
      ? Object.fromEntries([...mine].map(([name, rows]) => [name, [...rows]]))
      : undefined,
    savedAt: fs.existsSync(ctx.statePath) ? fs.statSync(ctx.statePath).mtime.toLocaleString("zh-CN") : "",
    cycles: ctx.cyclePlan(),
    perm: {
      role: caller.role,
      readonly: caller.role === "guest" || member === false,
      outOfGroup: member === false,
      roam,
      nick: caller.identity?.nick ?? "",
      avatar: (() => {
        const qq = String(caller.identity?.qq ?? "").trim()
        return qq ? `api/avatar?qq=${encodeURIComponent(qq)}` : ""
      })(),
      owner: caller.owner,
      showAdmins: caller.owner || caller.adminTokenOk,
      versions: caller.owner || caller.adminTokenOk || caller.role === "admin",
      changes: caller.role !== "guest",
      manage: caller.owner || caller.adminTokenOk,
      versionsKeep: ctx.cfg.versionsKeep,
      archiveDays: ctx.cfg.archiveDays,
      cloud: ctx.cfg.cloudUrl,
      acl: caller.owner || caller.adminTokenOk ? ctx.acl.aclAudit() : undefined,
    },
  }
}

export const memberStateOf = caller =>
  caller?.role === "self" ? ctx.roster.isMember(String(caller.identity?.qq ?? "")) : null
export const callTargetOf = (binds, sheet, row, nickname) => {
  const ids = [...new Set((binds?.qqsOf?.(sheet, row) ?? []).map(id => String(id ?? "").trim()).filter(Boolean))]
  const rosterQq = rosterQqOfNick(nickname)
  if (ids.length === 1) {
    const info = binds?.get?.(sheet, ids[0])
    if (info?.nickname && sameNick(info.nickname, nickname)) return { ok: true, qq: ids[0] }
  }
  if (rosterQq) return { ok: true, qq: rosterQq }
  if (!ids.length) return { ok: false, error: "这一行还没有绑定 QQ，群名单里也找不到唯一对应的成员" }
  if (ids.length > 1) return { ok: false, error: "这一行有多个绑定 QQ，群名单里也找不到唯一对应的成员" }
  return { ok: false, error: "这一行的绑定和当前群昵称对不上，群名单里也找不到唯一对应的成员" }
}
