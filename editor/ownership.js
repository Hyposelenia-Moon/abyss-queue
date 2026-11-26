/** 归属状态：QQ → 行 的绑定，以及"这份绑定是哪一版表的" */
import { lockKey, lockRowOf, lockSheetOf } from "./acl.js"

export const bindSet = (binds, sheet, qq, { row, nickname }) => {
  binds[sheet] ??= {}
  binds[sheet][String(qq)] = { row: Number(row), nickname: String(nickname ?? "").trim(), at: Date.now() }
}

export const bindDel = (binds, sheet, qq) => {
  const list = binds[sheet]
  if (!list || !(String(qq) in list)) return false
  delete list[String(qq)]
  if (!Object.keys(list).length) delete binds[sheet]
  return true
}

export const cloneBinds = binds => {
  const out = {}
  for (const [sheet, list] of Object.entries(binds ?? {})) out[sheet] = { ...(list ?? {}) }
  return out
}
export const cloneLocks = rows => ({ ...(rows ?? {}) })

export const bindView = binds => ({
  get: (sheet, qq) => binds?.[sheet]?.[String(qq)] ?? null,
  qqsOf: (sheet, row) =>
    Object.entries(binds?.[sheet] ?? {})
      .filter(([, info]) => Number(info?.row) === Number(row))
      .map(([qq]) => qq),
})

export const gatedBinds = (bindStore, fp) => bindView(bindStore.tableVersion === fp ? bindStore.data.binds : {})

export const dropBindsAt = (binds, sheet, row, { keepNickname = "", keepQq = "" } = {}) => {
  const list = binds[sheet] ?? {}
  const want = String(keepNickname ?? "").trim()
  let dropped = 0
  for (const qq of Object.keys(list)) {
    if (Number(list[qq]?.row) !== Number(row)) continue
    if (String(qq) === String(keepQq)) continue
    if (String(list[qq]?.nickname ?? "").trim() === want) continue
    delete list[qq]
    dropped++
  }
  if (list && !Object.keys(list).length) delete binds[sheet]
  return dropped
}

export const renameLock = (locks, sheet, row, nickname) => {
  const key = lockKey(sheet, row)
  if (locks[key]) locks[key] = { ...locks[key], nickname: String(nickname ?? "").trim() }
}

export const rebuildOwnership = (models, binds, locks = {}, before = null) => {
  const nickAt = (modelsOf, sheet, row) => String(modelsOf?.get(sheet)?.rows.find(r => r.row === Number(row))?.nickname ?? "").trim()
  const rowConfirmed = (model, info) => {
    const row = Number(info?.row)
    const want = String(info?.nickname ?? "").trim()
    if (!model || !row || !want) return 0
    return String(model.rows.find(r => r.row === row)?.nickname ?? "").trim() === want ? row : 0
  }
  const uniqueRow = (model, nick) => {
    const want = String(nick ?? "").trim()
    if (!want || !model) return 0
    const rows = model.rows.filter(r => String(r.nickname ?? "").trim() === want)
    return rows.length === 1 ? rows[0].row : 0
  }
  const nextBinds = {}
  let bindKept = 0
  let bindMoved = 0
  let bindDropped = 0
  let bindMissing = 0
  let bindUnconfirmed = 0
  for (const [sheet, list] of Object.entries(binds ?? {})) {
    for (const [qq, info] of Object.entries(list ?? {})) {
      const model = models.get(sheet)
      const row = rowConfirmed(model, info) || uniqueRow(model, info?.nickname)
      if (!row) {
        bindDropped++
        const want = String(info?.nickname ?? "").trim()
        const sameNick = want ? (model?.rows.filter(r => String(r.nickname ?? "").trim() === want).length ?? 0) : 0
        if (sameNick > 1) bindUnconfirmed++
        else bindMissing++
        continue
      }
      nextBinds[sheet] ??= {}
      nextBinds[sheet][qq] = { ...info, row }
      bindKept++
      if (Number(info?.row) !== row) bindMoved++
    }
  }
  for (const [sheet, list] of Object.entries(nextBinds)) {
    const owners = new Map()
    for (const [qq, info] of Object.entries(list)) {
      const key = Number(info?.row)
      if (!owners.has(key)) owners.set(key, [])
      owners.get(key).push(qq)
    }
    const doomed = [...owners.values()].filter(qqs => qqs.length > 1).flat()
    for (const qq of doomed) {
      delete nextBinds[sheet][qq]
      bindKept--
      bindDropped++
      bindUnconfirmed++
    }
    if (!Object.keys(nextBinds[sheet]).length) delete nextBinds[sheet]
  }
  const nextLocks = {}
  let lockKept = 0
  let lockDropped = 0
  for (const [key, lock] of Object.entries(locks ?? {})) {
    const sheet = lockSheetOf(key)
    const row = lockRowOf(key)
    const nick = String(lock?.nickname ?? "").trim() || nickAt(before, sheet, row)
    if (!nick) {
      lockDropped++
      continue
    }
    const target = uniqueRow(models.get(sheet), nick)
    if (!target) {
      lockDropped++
      continue
    }
    const to = lockKey(sheet, target)
    if (nextLocks[to]) {
      lockDropped++
      continue
    }
    nextLocks[to] = { ...lock, nickname: nick }
    lockKept++
  }
  return { binds: nextBinds, locks: nextLocks, bindKept, bindMoved, bindDropped, bindMissing, bindUnconfirmed, lockKept, lockDropped }
}

export function createOwnership({ store, table, loadLocks, saveLocks, loadRoster, locateSelf }) {
  const ownershipIn = async (ctx, bindStore) => {
    const locks = loadLocks()
    if (bindStore.tableVersion === ctx.version && locks.table === ctx.version)
      return { binds: cloneBinds(bindStore.data.binds), locks: cloneLocks(locks.rows), realigned: false }
    const rebuilt = rebuildOwnership(ctx.models, bindStore.data.binds ?? {}, locks.rows ?? {})
    return { binds: rebuilt.binds, locks: rebuilt.locks, realigned: true }
  }
  const persistState = async ({ fp }, plan) => {
    if (!plan) return
    const bindStore = await store()
    if (plan.binds) bindStore.data.binds = plan.binds
    bindStore.tableVersion = fp
    await bindStore.save()
    saveLocks({ table: fp, rows: plan.locks ?? loadLocks().rows })
  }
  const alignOwnership = async () => {
    const bindStore = await store()
    let plan = null
    let rebuilt = null
    const out = await table().mutate(
      async ctx => {
        const locks = loadLocks()
        if (bindStore.tableVersion === ctx.version && locks.table === ctx.version) return { realigned: false }
        rebuilt = rebuildOwnership(ctx.models, bindStore.data.binds ?? {}, locks.rows ?? {})
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return { realigned: true }
      },
      { afterCommit: info => persistState(info, plan) },
    )
    if (out.realigned)
      console.log(
        `[editor] 表版本变了，归属已重新对账：绑定保留 ${rebuilt.bindKept} 条（其中 ${rebuilt.bindMoved} 条纠正了行号）、作废 ${rebuilt.bindDropped} 条；` +
          `锁保留 ${rebuilt.lockKept} 条、作废 ${rebuilt.lockDropped} 条`,
      )
    return out
  }
  const ownershipAudit = async () => {
    const bindStore = await store()
    const locks = loadLocks()
    return table().read(({ models, fp }) => {
      const binds = bindStore.data.binds ?? {}
      const nickAt = (model, row) => String(model?.rows.find(r => r.row === Number(row))?.nickname ?? "").trim()
      const seqAt = (model, row) => {
        if (!model || !row) return 0
        const item = model.rows.find(r => r.row === Number(row))
        const seq = String(item?.seq ?? "").trim()
        if (seq) return Number(seq) || 0
        return Number(row) - Number(model.dataStart ?? 0) + 1
      }
      const entryOf = (model, qq, info) => {
        const row = Number(info?.row) || 0
        const nickname = String(info?.nickname ?? "").trim()
        const current = row ? nickAt(model, row) : ""
        const rowExists = Boolean(row) && Boolean(model?.rows.some(r => r.row === row))
        return {
          qq: String(qq),
          row,
          seq: seqAt(model, row),
          nickname,
          current,
          rowExists,
          stale: !rowExists || current !== nickname,
          conflict: false,
          conflictWith: [],
        }
      }
      const sheets = []
      for (const model of models.values()) {
        const entries = Object.entries(binds[model.name] ?? {})
          .map(([qq, info]) => entryOf(model, qq, info))
          .sort((a, b) => a.row - b.row || a.qq.localeCompare(b.qq))
        const byRow = new Map()
        for (const e of entries) {
          if (e.stale) continue
          if (!byRow.has(e.row)) byRow.set(e.row, [])
          byRow.get(e.row).push(e)
        }
        for (const group of byRow.values()) {
          if (group.length < 2) continue
          for (const e of group) {
            e.conflict = true
            e.conflictWith = group.filter(x => x !== e).map(x => x.qq)
          }
        }
        sheets.push({ name: model.name, bound: entries.length, entries })
      }
      for (const [name, list] of Object.entries(binds)) {
        if (models.has(name)) continue
        const entries = Object.entries(list ?? {}).map(([qq, info]) => entryOf(null, qq, info))
        sheets.push({ name, missingSheet: true, bound: entries.length, entries })
      }
      const lockRows = Object.entries(locks.rows ?? {})
        .map(([key, lock]) => {
          const sheet = lockSheetOf(key)
          const row = lockRowOf(key)
          const model = models.get(sheet)
          const current = nickAt(model, row)
          const nickname = String(lock?.nickname ?? "").trim()
          return { sheet, row, seq: seqAt(model, row), nickname, by: String(lock?.by ?? ""), at: Number(lock?.at) || 0, current, stale: !current || current !== nickname }
        })
        .sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row)
      const roster = loadRoster()
      const count = Object.values(binds).reduce((n, list) => n + Object.keys(list ?? {}).length, 0)
      return {
        version: fp,
        bindings: { table: String(bindStore.tableVersion ?? ""), stale: String(bindStore.tableVersion ?? "") !== fp, count },
        locks: { table: String(locks.table ?? ""), stale: String(locks.table ?? "") !== fp, count: lockRows.length, rows: lockRows },
        roster: { group: roster.group, updatedAt: roster.updatedAt, count: (roster.members ?? []).length },
        sheets,
      }
    })
  }
  const rebuildOwnershipNow = async () => {
    const bindStore = await store()
    let plan = null
    let rebuilt = null
    const out = await table().mutate(
      async ctx => {
        rebuilt = rebuildOwnership(ctx.models, bindStore.data.binds ?? {}, loadLocks().rows ?? {})
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return { version: ctx.version }
      },
      { afterCommit: info => persistState(info, plan) },
    )
    console.log(
      `[editor] 归属已按当前表重建：绑定保留 ${rebuilt.bindKept} 条（纠正行号 ${rebuilt.bindMoved} 条）、` +
        `作废 ${rebuilt.bindDropped} 条（其中重名无法确认 ${rebuilt.bindUnconfirmed} 条、人已不在 ${rebuilt.bindMissing} 条）；` +
        `锁保留 ${rebuilt.lockKept} 条、作废 ${rebuilt.lockDropped} 条`,
    )
    return {
      version: out.version,
      kept: rebuilt.bindKept,
      moved: rebuilt.bindMoved,
      dropped: rebuilt.bindDropped,
      unconfirmed: rebuilt.bindUnconfirmed,
      missing: rebuilt.bindMissing,
      locks: { kept: rebuilt.lockKept, dropped: rebuilt.lockDropped },
    }
  }
  const mineRows = async caller => {
    const bindStore = await store()
    const qq = caller.identity?.qq
    const nick = caller.identity?.nick
    const out = new Map()
    await table().read(({ models, fp }) => {
      const view = gatedBinds(bindStore, fp)
      for (const model of models.values()) {
        const hit = locateSelf(model, view, model.name, qq, nick)
        out.set(model.name, new Set(hit.row ? [hit.row] : []))
      }
    })
    return out
  }
  return { ownershipIn, persistState, alignOwnership, ownershipAudit, rebuildOwnershipNow, mineRows }
}
