/** 群名单对账：改群名片 → 同步表里的群昵称；退群 / 被移出 → 删行并压紧；缺人提醒 */
import { oneLine } from "./audit.js"
import { ctx as services } from "./ctx.js"
import { AUTOSAVE_SNAPSHOT_MS } from "./versions.js"
import { bindSet, bindView, renameLock } from "./ownership.js"
import { statusRenamePlan } from "./status.js"

const rosterTrusted = () => services.roster.trusted()

export const reconcileRoster = async (members, { drop = true, sheet = "" } = {}) => {
  const only = String(sheet ?? "").trim()
  const byQq = new Map()
  for (const m of members) {
    const qq = String(m?.qq ?? "").trim()
    if (qq) byQq.set(qq, String(m?.nick ?? "").trim())
  }
  const bindStore = await services.store()
  const renamed = []
  const absent = []
  for (const [sheetName, list] of Object.entries(bindStore.data.binds ?? {})) {
    if (only && sheetName !== only) continue
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      if (!row) continue
      if (!byQq.has(String(qq))) {
        absent.push({ sheet: sheetName, row, qq })
        continue
      }
      const nick = byQq.get(String(qq))
      const old = String(info?.nickname ?? "").trim()
      if (nick && nick !== old) renamed.push({ sheet: sheetName, row, qq, from: old, nick })
    }
  }
  const gone = drop ? absent : []
  if (!renamed.length && !gone.length) return { renamed: 0, removed: 0, renamedRows: renamed, missing: drop ? [] : absent }
  let removedRows = 0
  const rosterRecords = []
  let shiftRows = null
  if (gone.length) {
    let plan = null
    await services.table().mutate(
      async ctx => {
        const snapshot = await services.snapshotBeforeWrite()
        const state = await services.ownershipIn(ctx, bindStore)
        const binds = state.binds
        const bySheet = new Map()
        for (const g of gone) {
          if (!bySheet.has(g.sheet)) bySheet.set(g.sheet, [])
          bySheet.get(g.sheet).push(g.row)
          g.nick = String(ctx.model(g.sheet).rows.find(r => r.row === Number(g.row))?.nickname ?? "").trim()
        }
        const migrated = await services.dropRowsAndMigrate(ctx, bySheet, binds, state.locks)
        removedRows += migrated.removed
        shiftRows = migrated.shiftRows
        for (const g of gone) {
          rosterRecords.push({
            kind: "remove",
            at: Date.now(),
            qq: String(g.qq ?? ""),
            nick: String(g.nick ?? ""),
            sheet: g.sheet,
            row: Number(g.row),
            via: "群名单同步",
            reason: "退群 / 被移出群",
            snapshot,
          })
        }
        plan = { binds, locks: migrated.locks }
        return { removed: removedRows }
      },
      {
        afterCommit: async info => {
          await services.persistState(info, plan)
          services.recordChanges(rosterRecords.map(r => ({ ...r, version: info.fp })))
        },
      },
    )
  }
  const renamedNow = []
  for (const r of renamed) {
    const dropped = gone.some(g => g.sheet === r.sheet && Number(g.row) === Number(r.row))
    if (dropped) continue
    const to = Number(shiftRows?.[r.sheet]?.[r.row] ?? r.row)
    renamedNow.push({ ...r, row: to })
  }
  if (renamedNow.length) {
    let plan = null
    await services.table().mutate(
      async ctx => {
        const snapshot = await services.snapshotBeforeWrite(gone.length ? { throttleMs: AUTOSAVE_SNAPSHOT_MS } : {})
        const state = await services.ownershipIn(ctx, bindStore)
        const binds = state.binds
        const lockRows = state.locks
        const statusWritten = new Map()
        for (const r of renamedNow) {
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
          if (plan.skipped) console.log(`[editor] 群名单同步改名：${oneLine(plan.skipped)}`)
          if (model.col?.nickname) ctx.setCell(r.sheet, r.row, "nickname", r.nick)
          rosterRecords.push({
            kind: "edit",
            at: Date.now(),
            qq: String(r.qq ?? ""),
            nick: String(r.nick ?? ""),
            sheet: r.sheet,
            row: Number(r.row),
            via: "群名单同步",
            changes: { nickname: [String(r.from ?? "").trim(), String(r.nick ?? "").trim()] },
            snapshot,
          })
          bindSet(binds, r.sheet, r.qq, { row: r.row, nickname: r.nick })
          renameLock(lockRows, r.sheet, r.row, r.nick)
        }
        plan = { binds, locks: lockRows }
        return { renamed: renamedNow.length }
      },
      {
        afterCommit: async info => {
          await services.persistState(info, plan)
          services.recordChanges(rosterRecords.map(r => ({ ...r, version: info.fp })))
        },
      },
    )
  }
  if (renamedNow.length)
    console.log(
      `[editor] 按群名单同步群昵称：` +
        oneLine(renamedNow.map(r => `${r.sheet} 第 ${r.row} 行「${r.from}」→「${r.nick}」`).join("；")),
    )
  return { renamed: renamedNow.length, removed: removedRows, renamedRows: renamedNow, missing: drop ? [] : absent }
}

export const missingCandidates = async () => {
  const roster = services.roster.loadRoster()
  if (!rosterTrusted())
    return {
      supported: false,
      reason:
        (roster.updatedAt ? "群名单超过 48 小时没更新" : "群名单还没同步过") +
        "：按昵称判断「退群」不可靠，先发一次「#排队同步名单」再来看",
      rows: [],
    }
  const memberNicks = new Set((roster.members ?? []).map(m => String(m?.nick ?? "").trim()).filter(Boolean))
  const bindStore = await services.store()
  const binds = bindStore.data.binds ?? {}
  const rows = await services.table().read(({ models }) => {
    const out = []
    for (const model of models.values()) {
      const bound = new Set()
      for (const info of Object.values(binds[model.name] ?? {})) {
        const at = Number(info?.row) || 0
        const row = model.rows.find(r => r.row === at)
        if (at && row && String(info?.nickname ?? "").trim() === String(row.nickname ?? "").trim()) bound.add(at)
      }
      for (const r of model.rows) {
        const nick = String(r.nickname ?? "").trim()
        if (!nick || bound.has(r.row) || memberNicks.has(nick)) continue
        const seqText = String(r.seq ?? "").trim()
        out.push({
          sheet: model.name,
          row: r.row,
          seq: seqText ? Number(seqText) || 0 : r.row - model.dataStart + 1,
          nickname: nick,
          gameName: String(r.gameName ?? "").trim(),
          status: String(r.status ?? "").trim(),
        })
      }
    }
    return out
  })
  return { supported: true, reason: "", rows }
}

export const nicknameCheckNow = async sheet => {
  const roster = services.roster.loadRoster()
  if (!rosterTrusted())
    return { skipped: (roster.updatedAt ? "群名单超过 48 小时没更新" : "群名单还没同步过") + "（昵称检测跳过）", renamed: [], missing: [] }
  const synced = await reconcileRoster(roster.members ?? [], { drop: false, sheet })
  const candidates = await missingCandidates()
  const nicks = await services.table().read(({ models }) => {
    const model = models.get(sheet)
    return Object.fromEntries(
      (model?.rows ?? []).map(r => {
        const seqText = String(r.seq ?? "").trim()
        return [
          r.row,
          {
            nickname: String(r.nickname ?? "").trim(),
            seq: seqText ? Number(seqText) || 0 : r.row - Number(model.dataStart ?? 0) + 1,
          },
        ]
      }),
    )
  })
  const found = new Map()
  for (const r of synced.missing ?? [])
    if (!found.has(r.row))
      found.set(r.row, { sheet, row: r.row, seq: nicks[r.row]?.seq ?? 0, nickname: nicks[r.row]?.nickname ?? "", why: "名单里没有这个 QQ" })
  for (const r of candidates.rows)
    if (r.sheet === sheet && !found.has(r.row))
      found.set(r.row, { sheet, row: r.row, seq: r.seq ?? 0, nickname: r.nickname, why: "按群昵称在名单里找不到人" })
  return { skipped: "", renamed: synced.renamedRows ?? [], missing: [...found.values()] }
}

let lastMissingSig = ""

export const afterSaveFollowUp = async (caller, sheet, statusChanged, sortChanged = false) => {
  if (!statusChanged && !sortChanged) return null
  const nick = statusChanged
    ? await nicknameCheckNow(sheet)
    : { skipped: "", renamed: [], missing: [] }
  if (nick.skipped) console.log(`[editor] 改完成情况后的昵称检测跳过：${oneLine(nick.skipped)}`)
  if (nick.missing.length) {
    const sig = nick.missing.map(r => `${r.sheet}#${r.row}#${r.nickname}`).sort().join("|")
    if (sig !== lastMissingSig) {
      lastMissingSig = sig
      services.alertOwner(caller, {
        kind: "missing",
        text:
          `「${sheet}」有 ${nick.missing.length} 行在群名单里找不到人（可能退群了）：` +
          nick.missing.map(r => `序号 ${r.seq}「${r.nickname}」`).join("、") +
          "。**这一次没有自动删**——有绑定的那几行等每天那一趟按名单处理，没绑定的请在页面「归属」面板的「退群候选行」里确认后手动删。",
      })
    }
  }
  const tidy = await services.tidySheetsCore(sheet, { snapshotThrottleMs: AUTOSAVE_SNAPSHOT_MS })
  return {
    nickSync: {
      skipped: nick.skipped,
      renamed: nick.renamed.map(r => ({ row: r.row, from: r.from, nick: r.nick })),
      missing: nick.missing.map(r => ({ row: r.row, nickname: r.nickname })),
    },
    ...(tidy.moved ? { tidied: tidy.moved } : {}),
    shift: tidy.shiftRows?.[sheet] ?? {},
  }
}

export const pruneMissingRows = async keys => {
  const drops = new Map()
  for (const item of Array.isArray(keys) ? keys : []) {
    const sheet = String(item?.sheet ?? "").trim()
    const row = Number(item?.row) || 0
    if (!sheet || !row) continue
    if (!drops.has(sheet)) drops.set(sheet, [])
    drops.get(sheet).push(row)
  }
  if (!drops.size) return { removed: 0, rows: [] }
  const bindStore = await services.store()
  let plan = null
  const records = []
  const out = await services.table().mutate(
    async ctx => {
      const snapshot = await services.snapshotBeforeWrite()
      const state = await services.ownershipIn(ctx, bindStore)
      const binds = state.binds
      for (const [sheet, wanted] of [...drops]) {
        const model = ctx.model(sheet)
        const keep = wanted.map(Number).filter(row => model.rows.some(r => r.row === row))
        if (keep.length) drops.set(sheet, keep)
        else drops.delete(sheet)
      }
      for (const [sheet, rows] of drops) {
        const model = ctx.model(sheet)
        for (const row of rows) {
          const item = model.rows.find(r => r.row === row)
          records.push({
            kind: "remove",
            at: Date.now(),
            qq: "",
            nick: String(item?.nickname ?? "").trim(),
            sheet,
            row,
            via: "主人确认",
            reason: "退群候选行（表里既无有效绑定、群名单里也找不到这个人）",
            snapshot,
          })
        }
      }
      const migrated = await services.dropRowsAndMigrate(ctx, drops, binds, state.locks)
      plan = { binds, locks: migrated.locks }
      return { removed: migrated.removed }
    },
    {
      afterCommit: async info => {
        await services.persistState(info, plan)
        services.recordChanges(records.map(r => ({ ...r, version: info.fp })))
      },
    },
  )
  return { removed: out.removed, rows: records.map(r => ({ sheet: r.sheet, row: r.row, nickname: r.nick })) }
}
