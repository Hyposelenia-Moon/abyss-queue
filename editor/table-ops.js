/** 表操作：整榜整理、换表、压紧、删行迁移、改完成情况 */
import { ATTACK_SHEET } from "../components/attack.js"
import { openWorkbook } from "../model/xlsx.js"
import { lockKey, lockRowOf, lockSheetOf } from "./acl.js"
import { remapRowsOf } from "./anchors.js"
import { oneLine } from "./audit.js"
import { ctx as services } from "./ctx.js"
import { extraNamesOf } from "./cycle-ledger.js"
import { FIELDS, MOVE_COLUMN_KEYS, OPEN_RULES, QUEUED_STATUS, REPLACE_REQUIRED_COLUMNS, WAITING_STATUS } from "./defs.js"
import { rebuildOwnership } from "./ownership.js"
import { tidyOrder } from "./reorder.js"
import { defaultStatusOf } from "./status.js"

export const tidySheetsCore = async (wanted, { snapshotThrottleMs = 0 } = {}) => {
  const tidied = []
  const shiftRows = {}
  let plan = null
  let moved = 0
  await services.store()
  await services.table().mutate(
    async ctx => {
      const names = wanted ? [wanted] : [...ctx.models.keys()]
      const ops = []
      for (const name of names) {
        const model = ctx.model(name)
        const target = tidyOrder(model, {
          tempNames: extraNamesOf(name),
          frontNames: services.queueFrontOf(name),
        })
        if (!target) {
          tidied.push({ sheet: name, moved: 0, reason: "已经是有序的（或没有可排序的行），一个字都没写" })
          continue
        }
        ops.push({ name, model, ...target })
      }
      if (!ops.length) return { moved: 0 }
      await services.snapshotBeforeWrite(snapshotThrottleMs ? { throttleMs: snapshotThrottleMs } : {})
      for (const op of ops) {
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
              ctx.refStyle(op.name, `${col}${from}`),
            )
          op.moved = (op.moved ?? 0) + 1
        }
      }
      const state = await services.ownershipIn(ctx, await services.store())
      let merged = { binds: state.binds, locks: state.locks }
      for (const op of ops) {
        const rowMap = new Map()
        for (let i = 0; i < op.slots.length; i++) if (op.slots[i] !== op.order[i]) rowMap.set(op.order[i], op.slots[i])
        tidied.push({ sheet: op.name, moved: op.moved ?? 0, segments: op.groups })
        moved += op.moved ?? 0
        shiftRows[op.name] = Object.fromEntries(rowMap)
        merged = remapRowsOf(merged, op.name, r => rowMap.get(r) ?? r)
      }
      plan = merged
      return { moved }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )
  if (moved)
    console.log(
      `[editor] 每日整理：共挪 ${moved} 行（${oneLine(tidied.filter(t => t.moved).map(t => `${t.sheet} ${t.moved}`).join("、"))}）`,
    )
  return { moved, tidied, shiftRows }
}

export const moveCell = (ctx, sheet, key, col, row, value, current, style) => {
  const next = String(value ?? "")
  if (next === String(current ?? "")) return
  if (next) ctx.setCell(sheet, row, key, next, style)
  else ctx.clearCell(sheet, `${col}${row}`)
}

export const catchUpOpenStatus = async caller => {
  if (caller.role !== "admin") return 0
  let opened = []
  let plan = null
  await services.table().mutate(
    async ctx => {
      opened = [...ctx.models.values()]
        .filter(m => OPEN_RULES.some(r => r.test.test(m.name)) && defaultStatusOf(m.name) === QUEUED_STATUS)
        .flatMap(m =>
          m.rows
            .filter(r => String(r.status ?? "").trim() === WAITING_STATUS)
            .map(r => ({ sheet: m.name, row: r.row, nickname: String(r.nickname ?? "").trim() })),
        )
      if (!opened.length) return { opened: 0 }
      await services.snapshotBeforeWrite()
      for (const o of opened) ctx.setCell(o.sheet, o.row, "status", QUEUED_STATUS)
      const state = await services.ownershipIn(ctx, await services.store())
      if (state.locks) for (const o of opened) delete state.locks[lockKey(o.sheet, o.row)]
      plan = { binds: state.binds, locks: state.locks }
      return { opened: opened.length }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )
  if (!opened.length) return 0
  console.log(
    `[editor] 开榜时间已到，把 ${opened.length} 行的「${WAITING_STATUS}」改成「${QUEUED_STATUS}」：` +
      oneLine(opened.map(o => `${o.sheet} 第 ${o.row} 行${o.nickname ? `「${o.nickname}」` : ""}`).join("；")),
  )
  return opened.length
}

export const validateReplacement = (after, before) => {
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

export const replaceTable = async (bytes, label, { expect } = {}) => {
  if (!bytes?.length) throw new Error("内容是空的")
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`文件过大（${Math.round(bytes.length / 1024 / 1024)}MB），拒绝替换`)
  try {
    const probe = await openWorkbook(bytes)
    if (!probe.sheets?.length) throw new Error("里面没有任何工作表")
  } catch (err) {
    throw new Error(`这份文件不是能读的 xlsx：${err?.message ?? err}`)
  }
  const bindStore = await services.store()
  let snapshot = ""
  let plan = null
  let rebuilt = { bindKept: 0, bindDropped: 0, lockKept: 0, lockDropped: 0 }
  let out
  try {
    out = await services.table().replace(bytes, {
      expect,
      validate: validateReplacement,
      transition: ({ before, after }) => {
        rebuilt = rebuildOwnership(after.models, bindStore.data.binds ?? {}, services.acl.loadLocks().rows ?? {}, before.models)
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return rebuilt
      },
      beforeWrite: async () => {
        snapshot = await services.snapshotBeforeWrite()
      },
      afterCommit: info => services.persistState(info, plan),
    })
  } catch (err) {
    if (err?.conflict) throw err
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

export const compactSheet = async (ctx, model, dropRows) => {
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
    const from = await ctx.rowStyles(model.name, oldRow)
    for (const f of FIELDS) {
      if (!model.col?.[f.key]) continue
      ctx.setCell(model.name, target, f.key, item ? String(item[f.key] ?? "") : "", from[f.key])
    }
  }
  for (let r = model.dataStart + kept.length; r <= model.dataEnd; r++) ctx.clearRow(model.name, r)
  return { removed: drop.size, moved: kept.length }
}

export const dropRowsAndMigrate = async (ctx, drops, binds, lockRows) => {
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
  const shiftRows = {}
  for (const [sheet, { drop, shift }] of moves)
    for (const [from, to] of shift) if (!drop.has(from) && to !== from) (shiftRows[sheet] ??= {})[from] = to
  for (const [sheet, { model, drop }] of moves) {
    const out = await compactSheet(ctx, model, [...drop])
    removed += out.removed
    moved += out.moved
    console.log(`[editor] 已从「${oneLine(sheet)}」删掉 ${out.removed} 行并压紧（${out.moved} 行上移）`)
  }
  for (const [sheet, { drop }] of moves)
    if (drop.size) services.changes.remap(sheet, Object.fromEntries([...drop].map(r => [r, 0])))
  for (const [sheet, map] of Object.entries(shiftRows)) services.changes.remap(sheet, map)
  return { locks: nextLocks, removed, moved, shiftRows }
}

export const compactClearedRows = async (sheet, rows) => {
  const wanted = (Array.isArray(rows) ? rows : []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  if (!wanted.length) return { compacted: null }
  const bindStore = await services.store()
  let plan = null
  return services.table().mutate(
    async ctx => {
      const model = ctx.model(sheet)
      const live = new Set(model.rows.map(r => r.row))
      const first = Math.min(...live)
      const last = Math.max(...live)
      const empties = []
      for (let row = Math.max(first, model.dataStart); row < last; row++) if (!live.has(row)) empties.push(row)
      if (!empties.length) return { compacted: null }
      const state = await services.ownershipIn(ctx, bindStore)
      const binds = state.binds
      const migrated = await dropRowsAndMigrate(ctx, new Map([[sheet, empties]]), binds, state.locks)
      plan = { binds, locks: migrated.locks }
      return { compacted: { removed: migrated.removed, moved: migrated.moved }, shift: migrated.shiftRows?.[sheet] ?? {} }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )
}
