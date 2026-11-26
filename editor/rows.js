/** 行的校验、差异与冲突判定 */
import crypto from "node:crypto"

import { APPEND_ROWS_MAX, EXCLUSIVE_VALUES, FIELDS, PENDING_STATUS, blank } from "./defs.js"
import { attackStatusParts, parseAttackGoal } from "../components/attack.js"
import { matchOption } from "../modules/queue.js"
import { statusTokens } from "./status.js"
import { effectiveOptions } from "./anchors.js"

export const sameNick = (a, b) => {
  const x = String(a ?? "").trim()
  const y = String(b ?? "").trim()
  return Boolean(x) && Boolean(y) && x.toLowerCase() === y.toLowerCase()
}

export const validateRows = (model, rows) => {
  const problems = []
  const seen = new Map()
  const options = effectiveOptions(model)
  const nicknames = new Set(model.rows.map(r => String(r.nickname ?? "").trim()).filter(Boolean))
  const touched = new Set(rows.map(r => Number(r?.row)).filter(Boolean))
  for (const r of model.rows) {
    if (touched.has(r.row)) continue
    if (!blank(r.nickname)) seen.set(String(r.nickname).trim(), r.row)
  }
  for (const r of rows) {
    const v = r?.values ?? {}
    const who = blank(v.nickname) ? `第 ${r.row} 行` : `「${String(v.nickname).trim()}」`
    if (FIELDS.every(f => blank(v[f.key]))) continue
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
      if (/攻炼|绝境/.test(String(model.name ?? "")) && f.key === "status" && attackStatusParts(val)) continue
      if (/攻炼|绝境/.test(String(model.name ?? "")) && f.key === "goal") {
        if (!parseAttackGoal(val)) problems.push(`${who}：${f.label}格式不对（模式用、分隔，目标用｜）`)
        continue
      }
      if (/攻炼|绝境/.test(String(model.name ?? "")) && f.key === "status") {
        const compound = attackStatusParts(val)
        if (compound) {
          const allowed = new Set([...(options.status ?? []), ...nicknames, nick, before?.nickname])
          for (const part of compound) {
            if (part.kind !== "done" || allowed.has(part.label)) continue
            const people = part.label.split("/").map(s => s.trim()).filter(Boolean)
            if (!people.length || people.some(person => !allowed.has(person)))
              problems.push(`${who}：帮帮完成情况「${part.label}」不在下拉选项里`)
          }
          continue
        }
      }
      const opts = options[f.option] ?? []
      if (!opts.length) continue
      if (f.key === "status" && (nicknames.has(val) || sameNick(val, before?.nickname))) continue
      const parts = f.multi ? val.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [val]
      for (const part of parts) {
        if (opts.includes(part) || matchOption(part, opts)) continue
        if (f.key === "anchor" && opts.includes(canonicalAnchor(part, compileAliases(config.anchor_aliases)))) continue
        if (f.key === "status" && (nicknames.has(part) || sameNick(part, before?.nickname))) continue
        if (f.key === "status" && statusTokens(before?.status).includes(part)) continue
        problems.push(`${who}：${f.label}「${part}」不在下拉选项里`)
      }
      if (parts.length > 1) {
        const exclusive = parts.filter(p => EXCLUSIVE_VALUES.includes(p))
        if (exclusive.length)
          problems.push(`${who}：${f.label}「${exclusive[0]}」不能和别的选项一起选（它是独占的，single choice）`)
      }
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

export const rowNumbersOf = rows =>
  rows.map((r, i) => {
    const raw = r?.row
    const row = typeof raw === "number" ? raw : Number(String(raw ?? "").trim())
    if (!Number.isSafeInteger(row)) throw new Error(`第 ${i + 1} 项的行号不是整数：${JSON.stringify(raw ?? null)}`)
    return row
  })
export const assertMemberRows = (model, rowNums) => {
  if (!rowNums.length) return
  const { dataStart, dataEnd, headerRow } = model
  const min = Math.min(dataStart, dataEnd + 1)
  const max = Math.max(dataEnd, min - 1) + APPEND_ROWS_MAX
  for (const row of rowNums) {
    if (row < min || row > max)
      throw new Error(
        `第 ${row} 行不是成员数据行：表头在第 ${headerRow} 行、成员数据从第 ${min} 行起（空行可以直接在末尾追加新行，` +
          `但最多到第 ${max} 行）。表头上方的主播区与表头都只能用对应的接口改`,
      )
  }
}

export const redLine = (text, ownerNote) => {
  const err = new Error(`这条改动被拒绝了：${text}。${ownerNote}这次一个字都没写进表里。`)
  err.refused = true
  return err
}

export const changeAuthor = caller => ({
  qq: String(caller?.identity?.qq ?? "") || (caller?.adminTokenOk ? "(管理口令)" : ""),
  nick: String(caller?.identity?.nick ?? ""),
})

export const diffRows = (model, normalized) => {
  const out = []
  for (const r of normalized) {
    if (!r.row) continue
    const before = model.rows.find(x => x.row === r.row)
    const edited = {}
    for (const f of FIELDS) {
      const from = String(before?.[f.key] ?? "").trim()
      const to = String(r.values[f.key] ?? "").trim()
      if (from !== to) edited[f.key] = [from, to]
    }
    if (Object.keys(edited).length) out.push({ row: Number(r.row), changes: edited })
  }
  return out
}

export const editRecord = (caller, sheet, row, changed, { via = "", version = "", snapshot = "", at = Date.now() } = {}) => ({
  kind: "edit",
  at,
  sheet,
  row,
  via,
  changes: changed,
  version,
  snapshot,
  ...changeAuthor(caller),
})

export const rowFingerprint = row =>
  crypto
    .createHash("sha1")
    .update(FIELDS.map(f => String(row?.[f.key] ?? "").trim()).join("\u0001"))
    .digest("hex")
    .slice(0, 16)
export const rowConflict = rows => {
  const err = new Error(
    `第 ${rows.join("、")} 行在你编辑期间被别人改过：你这次的改动一个字都没写进去。` +
      `草稿还在，请点「读取最新并对比」核对后再改。`,
  )
  err.conflict = true
  err.conflictRows = rows
  return err
}

export const composeRowMap = (first, second) => {
  const out = {}
  const keys = new Set([...Object.keys(first ?? {}), ...Object.keys(second ?? {})].map(Number))
  for (const row of keys) {
    const mid = Number(first?.[row] ?? row)
    const to = Number(second?.[mid] ?? mid)
    if (to !== row) out[row] = to
  }
  return out
}
