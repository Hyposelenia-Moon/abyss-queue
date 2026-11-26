/** 主播区（下拉候选）的口径 */
import { oneLine } from "./audit.js"
import { lockKey, lockRowOf, lockSheetOf } from "./acl.js"
import { compileAliases, canonicalAnchor } from "../components/aliases.js"
import { ATTACK_TARGET_NAMES, attackModeNames, attackVersions } from "../components/attack.js"
import { mergeStatusOptions } from "./cycle-ledger.js"
import { ctx as services } from "./ctx.js"
import { ANCHOR_FIELDS, ANY_ANCHOR } from "./defs.js"

export const effectiveOptions = model => {
  const known = compileAliases(services.config?.anchor_aliases)
  const anchors = [...new Set(model.anchors.map(a => a.name).map(s => s.trim()).filter(Boolean))]
  const used = []
  for (const r of model.rows) {
    for (const part of String(r.anchor ?? "")
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean)) {
      const canonical = canonicalAnchor(part, known)
      if (canonical !== part && anchors.includes(canonical)) continue
      if (!anchors.includes(part) && !used.includes(part)) used.push(part)
    }
  }
  const fallback = [...new Set(model.options?.anchor ?? [])]
  const list = [...new Set([...anchors, ...used])]
  const anchor = list.length
    ? (list.includes(ANY_ANCHOR) ? list : [...list, ANY_ANCHOR])
    : [...new Set([...fallback, ANY_ANCHOR])]
  const status = model.col?.status ? mergeStatusOptions(model, anchors) : model.options?.status
  const isAttack = /攻炼|绝境/.test(String(model.name ?? ""))
  const goal = isAttack ? undefined : model.options?.goal
  const mode = isAttack ? attackModeNames() : undefined
  const target = isAttack ? [...ATTACK_TARGET_NAMES] : undefined
  const versionRows = isAttack
    ? attackVersions().map(v => ({
        version: v.version,
        preset: v.preset,
        open_at: v.open_at,
        modes: [...v.modes],
      }))
    : undefined
  return {
    ...(model.options ?? {}),
    anchor,
    ...(status ? { status } : {}),
    ...(goal ? { goal } : {}),
    ...(versionRows ? { attackVersions: versionRows } : {}),
    ...(mode ? { mode } : {}),
    ...(target ? { target } : {}),
  }
}

export const anchorValuesOf = (values, base = null) =>
  Object.fromEntries(
    ANCHOR_FIELDS.map(f => {
      const provided = values && Object.prototype.hasOwnProperty.call(values, f.key)
      const v = provided ? values[f.key] : base?.[f.key]
      return [f.key, String(v ?? "").trim()]
    }),
  )
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
export const anchorNameOf = values => (values.recommend ? `${values.name}【${values.recommend}】` : values.name)

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

export const aliasCanonicalNames = () => {
  const out = new Set()
  for (const name of Object.keys(services.config?.anchor_aliases ?? {})) {
    const text = String(name ?? "").trim()
    if (text) out.add(text)
  }
  for (const a of compileAliases(services.config?.anchor_aliases)) out.add(a.name)
  return out
}

export const applyAnchors = async (caller, { sheet, rows, added, version }) => {
  if (caller.role !== "admin") throw new Error("只有白名单管理员可以改主播列表")
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  const fresh = Array.isArray(added) ? added : []
  if (rows.length + fresh.length > 100) throw new Error("一次提交的主播行数过多（>100）")
  let plan = null
  let insertShift = null
  const out = await services.table().mutate(
    async ctx => {
      const model = ctx.model(sheet)
      const known = new Map(model.anchors.map(a => [a.row, a]))
      const normalized = []
      const aliasNames = aliasCanonicalNames()
      for (const r of rows) {
        const row = Number(r?.row) || 0
        const before = known.get(row)
        if (!before) throw new Error(`第 ${row} 行不是主播列表里的行，不能改`)
        const values = anchorValuesOf(r?.values, anchorBaseOf(before))
        if (!values.name) throw new Error(`第 ${row} 行：主播名不能为空（要删掉这位主播请在表格里删行）`)
        if (before.name !== values.name && aliasNames.has(String(before.name ?? "").trim()))
          throw new Error(
            `第 ${row} 行：「${before.name}」是 config/services.config.yaml 里 anchor_aliases 的正名（别名都挂在它下面），` +
              `只改表会让别名失效。请先把 anchor_aliases 的键「${before.name}」改成「${values.name}」，再回来改名`,
          )
        normalized.push({ row, values })
      }
      const addedValues = fresh.map((r, i) => {
        const values = anchorValuesOf(r?.values)
        if (!values.name) throw new Error(`新增的第 ${i + 1} 位主播：主播名不能为空`)
        return values
      })
      const insertedAt = model.anchors.length ? Math.max(...model.anchors.map(a => a.row)) + 1 : ANCHOR_FIRST_ROW
      if (addedValues.length && insertedAt >= model.headerRow)
        throw new Error(
          `不能新增主播：算出来的插入行是第 ${insertedAt} 行，而表头在第 ${model.headerRow} 行 —— ` +
            `主播区（表头之上）与排队区（表头之下）不能混，请先在表格里把表头位置理清楚`,
        )
      if (addedValues.length) {
        insertShift = Object.fromEntries(
          model.rows.filter(r => r.row >= insertedAt).map(r => [r.row, r.row + addedValues.length]),
        )
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
      const names = model.anchors.map(a => ({ row: a.row, name: a.name }))
      for (const n of normalized) {
        const hit = names.find(x => x.row === n.row)
        if (hit) hit.name = n.values.name
      }
      for (const values of addedValues) names.push({ row: 0, name: values.name })
      const listPlan = validationPlan(model, names.map(n => n.name))
      const options = listPlan.anchor
      await services.snapshotBeforeWrite()
      for (const { row, values } of normalized) {
        for (const f of ANCHOR_FIELDS) {
          if (!f.col) continue
          ctx.setRef(sheet, `${f.col}${row}`, f.key === "name" ? anchorNameOf(values) : values[f.key])
        }
      }
      writeValidationPlan(ctx, sheet, listPlan, { single: false })
      const state = await services.ownershipIn(ctx, await services.store())
      const moved = shiftRowsOf(state, sheet, insertedAt, addedValues.length)
      plan = { binds: moved.binds, locks: moved.locks }
      return { written: normalized.length + addedValues.length, inserted: addedValues.length, options: options.length }
    },
    { expect: version, afterCommit: info => services.persistState(info, plan) },
  )
  if (out?.inserted && insertShift) services.changes.remap(sheet, insertShift)
  return out
}

export const validationPlan = (model, anchorsOverride = null) => {
  const names = (anchorsOverride ?? model.anchors.map(a => a.name)).map(s => String(s ?? "").trim()).filter(Boolean)
  const anchors = [...new Set(names)]
  const anchorCol = model.col?.anchor
  const statusCol = model.col?.status
  const anchor = anchorCol ? effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) }).anchor : []
  const status = statusCol ? mergeStatusOptions(model, anchors, { withExtra: false }) : []
  const goalCol = model.col?.goal
  const opts = effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) })
  const goal = goalCol && !/攻炼|绝境/.test(String(model.name ?? "")) ? (opts.goal ?? []) : []
  return { anchorCol, statusCol, anchor, status, goalCol, goal }
}

export const writeValidationPlan = (ctx, sheet, plan, { single = true } = {}) => {
  if (plan.anchorCol && plan.anchor.length) ctx.setValidationList(sheet, plan.anchorCol, plan.anchor, { errorStyle: "warning" })
  if (plan.statusCol && plan.status.length) ctx.setValidationList(sheet, plan.statusCol, plan.status, { errorStyle: "warning" })
  if (!single) return
  if (plan.goalCol && plan.goal.length) ctx.setValidationList(sheet, plan.goalCol, plan.goal, { errorStyle: "stop" })
}

export const archiveOptions = async caller => {
  if (caller.role !== "admin") return 0
  let work = []
  let plan = null
  await services.table().mutate(
    async ctx => {
      work = [...ctx.models.values()]
        .map(model => {
          const listPlan = validationPlan(model)
          const known = new Set([...(model.options?.anchor ?? []), ...(model.options?.status ?? [])])
          const fresh = [...listPlan.anchor, ...listPlan.status].filter(v => v && !known.has(v))
          return { name: model.name, plan: listPlan, fresh: [...new Set(fresh)] }
        })
        .filter(x => x.fresh.length)
      if (!work.length) return { archived: 0 }
      await services.snapshotBeforeWrite()
      for (const { name, plan: p } of work) writeValidationPlan(ctx, name, p, { single: false })
      const state = await services.ownershipIn(ctx, await services.store())
      plan = { binds: state.binds, locks: state.locks }
      return { archived: work.reduce((n, x) => n + x.fresh.length, 0) }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )
  if (!work.length) return 0
  const total = work.reduce((n, x) => n + x.fresh.length, 0)
  console.log(
    `[editor] 已把手填的 ${total} 个名字归档进下拉选项：` +
      oneLine(work.map(x => `${x.name}（${x.fresh.join("、")}）`).join("；")),
  )
  return total
}
