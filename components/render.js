/** 文本渲染（纯函数） */
import { listQueue, locateSelf } from "../modules/queue.js"
import { canonicalAnchor } from "./aliases.js"
import { splitItems } from "./text.js"
import { parseEntries } from "./live-entry.js"
import { displayStatus, isDone, isPending, statusOf } from "../modules/progress.js"
import { goalParts } from "./attack.js"

const clean = s => String(s ?? "").trim()

const line = (item, seq = "") => {
  const head = `${seq || item.seq || item.row}. ${item.nickname}`
  const body = [item.anchor, item.goal].filter(Boolean).join(" ｜ ")
  const extra = []
  if (item.status) extra.push(`状态：${displayStatus(item.status)}`)
  if (item.note) extra.push(`备注：${item.note}`)
  return [`${head}`, `   ${body}`, extra.length ? `   ${extra.join("　")}` : ""].filter(Boolean).join("\n")
}

export function renderQueue(model, { limit = 20, myRow = 0, moreHint = "" } = {}) {
  const all = listQueue(model)
  if (!all.length) return `【${model.name}】还没有人排队`
  const shown = limit > 0 ? all.slice(0, limit) : all
  const lines = shown.map((item, i) => {
    const text = line(item, String(i + 1))
    return item.row === myRow ? `${text}   ⬅️ 你` : text
  })
  const cmd = clean(moreHint)
  const more =
    all.length > shown.length ? `\n…… 还有 ${all.length - shown.length} 人${cmd ? `，发送 ${cmd} 查看` : ""}` : ""
  const mine = all.find(i => i.row === myRow)
  const mineText = mine ? `\n你的位置：第 ${all.findIndex(i => i.row === mine.row) + 1} 位` : ""
  return [
    (() => {
      const queuing = queuingCount(model)
      const status = queuing ? "" : sheetStatus(model)
      return status ? `【${model.name}】${status}` : `【${model.name}】共 ${queuing} 人排队中`
    })(),
    model.title ? `表：${model.title}` : "",
    "————————————",
    lines.join("\n"),
    more,
    mineText,
  ]
    .filter(i => i !== "")
    .join("\n")
}

export function truncateWidth(text, max) {
  const str = clean(text)
  if (!max || max <= 0) return str
  let width = 0
  let out = ""
  for (const ch of str) {
    const w = /[\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
    if (width + w > max - 1) return `${out}…`
    width += w
    out += ch
  }
  return out
}

/**
 * 完成情况 → 色档，与编辑器 `statusClass()` 同一套词：
 * 已完成绿、等待开启琥珀、排队中蓝、未完成红，其余中性灰。
 * 只看**显示出来的文字**，因为图上写什么就该是什么色。
 */
export function statusTone(status) {
  const s = clean(status)
  if (!s) return "neutral"
  if (s.includes("已完成")) return "green"
  if (s.includes("等待")) return "amber"
  if (s.includes("排队")) return "blue"
  if (s.includes("未完成")) return "red"
  return isDone(s) ? "green" : "blue"
}

export function queueItemView(item, { myRow = 0, nameMax = 0, statusMax = 0, seq = "" } = {}) {
  const cut = (text, width) => (width > 0 ? truncateWidth(text, width) : clean(text))
  const gp = goalParts(item.goal)
  return {
    seq: seq || item.seq || String(item.row),
    nickname: cut(item.nickname, nameMax),
    gameName: clean(item.gameName),
    anchor: clean(item.anchor),
    goal: clean(item.goal),
    goalPrefix: gp.prefix,
    goalTarget: gp.target,
    goalPrefixTone: gp.prefixTone,
    goalTargetTone: gp.color,
    goalTone: gp.color,
    status: cut(displayStatus(item.status), statusMax),
    statusTone: statusTone(displayStatus(item.status)),
    mine: item.row === myRow,
  }
}

export function ownRowView(item, { row = 0, sheet = "", seq = "" } = {}) {
  if (!item) return null
  const goal = goalParts(item.goal)
  return {
    sheet,
    seq: seq || item.seq || String(item.row),
    row: item.row || row,
    nickname: clean(item.nickname),
    gameName: clean(item.gameName),
    anchor: clean(item.anchor),
    goal: clean(item.goal),
    goalPrefix: goal.prefix,
    goalTarget: goal.target,
    goalPrefixTone: goal.prefixTone,
    goalTargetTone: goal.color,
    goalTone: goal.color,
    status: displayStatus(item.status),
    statusTone: statusTone(displayStatus(item.status)),
    note: clean(item.note),
  }
}

export function queueView(model, { limit = 20, myRow = 0, nameMax = 0, statusMax = 0 } = {}) {
  const all = listQueue(model)
  const shown = limit > 0 ? all.slice(0, limit) : all
  const mine = all.find(i => i.row === myRow)
  const mineSeq = mine ? all.findIndex(i => i.row === mine.row) + 1 : 0
  const queuing = queuingCount(model)
  const waiting = (model.rows ?? []).filter(row => statusOf(row.status) === "waiting").length
  return {
    name: model.name,
    title: model.title || "",
    total: queuing,
    listed: all.length,
    waiting,
    status: queuing ? "" : sheetStatus(model),
    rows: shown.map((item, i) => queueItemView(item, { myRow, nameMax, statusMax, seq: String(i + 1) })),
    more: all.length > shown.length ? all.length - shown.length : 0,
    own: ownRowView(mine, { row: myRow, sheet: model.name, seq: mineSeq ? String(mineSeq) : "" }),
  }
}

function entryList(anchor) {
  return splitItems(anchor?.entry).flatMap(e => String(e).split("\n")).map(s => s.trim()).filter(Boolean)
}

function entryViews(anchor, liveLookup) {
  return entryList(anchor).flatMap(text => {
    const parsed = parseEntries([text])[0] ?? { text, platform: "", kind: "other", url: "", roomId: "", uid: "" }
    if (parsed.platform !== "B站" && !/b站|bilibili|哔哩/i.test(text)) return []
    const isBiliUrl = parsed.kind.startsWith("bili")
    const shown = isBiliUrl ? `B站${parsed.url}` : "B站"
    const live = liveLookup && isBiliUrl ? liveLookup(parsed) : null
    return [
      {
        text: shown,
        platform: "B站",
        kind: parsed.kind,
        url: isBiliUrl ? parsed.url : "",
        live: live ? { ...live, anchorName: clean(anchor?.name) } : null,
      },
    ]
  })
}

/**
 * 推荐度五档（数字越小越强），与编辑器主播区同序；编辑器经 `/api/data` 拿这份，不另存字面量。
 * 旧口径按名次一一归档（强烈推荐→夯、推荐→顶级、提分推荐→人上人、可选→NPC、不可选→拉完了），
 * 归档只用于排序与取最高档：表里原文不改写，显示仍是原文（旧值灰显）。
 */
export const REC_TIERS = Object.freeze(["夯", "顶级", "人上人", "NPC", "拉完了"])
const REC_LEGACY = [
  [/强烈/, 1],
  [/^推荐$/, 2],
  [/提分/, 3],
  [/不可选/, 5],
  [/可选/, 4],
]
/** 五档原值 → 1..5；旧口径与其他写法 → 0（只决定颜色：0 走中性灰） */
export const recTierOf = r => REC_TIERS.indexOf(clean(r)) + 1
/** 排序权重：五档原值 = 档位；旧口径 = 归到的档 + 0.5（同档排在五档原值之后）；未填与认不出的 = 6 */
export const recRank = r => {
  const tier = recTierOf(r)
  if (tier) return tier
  const v = clean(r)
  const hit = v && REC_LEGACY.find(([re]) => re.test(v))
  return hit ? hit[1] + 0.5 : 6
}

const entryText = (e, { withLink = false } = {}) => {
  if (!e) return ""
  if (e.live) {
    const label = clean(e.live.label)
    return withLink && e.url ? `${label} · ${e.url}` : label
  }
  return e.text
}

export function anchorQueueCounts(model) {
  const out = new Map()
  for (const row of model?.rows ?? []) {
    const kind = statusOf(row.status)
    if (kind !== "queued" && kind !== "waiting") continue
    const names = new Set(
      String(row.anchor ?? "")
        .split(/[,，、]/)
        .map(clean)
        .filter(Boolean),
    )
    for (const name of names) {
      const c = out.get(name) ?? { queued: 0, waiting: 0 }
      c[kind] += 1
      out.set(name, c)
    }
  }
  return out
}

const SHEET_SHORT = {
  幻想真境剧诗: "剧诗",
  幽境危战: "危战",
  深境螺旋: "深渊",
  绝境攻炼: "攻炼",
}
const sheetShortOf = name => SHEET_SHORT[clean(name)] || clean(name)

const queueTextOf = c => {
  const bits = []
  if (c?.queued) bits.push(`排队中 ${c.queued} 人`)
  if (c?.waiting) bits.push(`等待开启 ${c.waiting} 人`)
  return bits.join(" · ") || "排队中 0 人"
}

const queueChipsOf = queues =>
  (queues ?? [])
    .filter(q => q.queued || q.waiting)
    .map(q => ({ short: sheetShortOf(q.sheet), queued: q.queued, waiting: q.waiting }))
const liveLabelsOf = views => (views ?? []).filter(e => e.live).map(e => ({ ...e.live }))

export function anchorsView(model, { liveLookup = null } = {}) {
  const counts = anchorQueueCounts(model)
  return {
    name: model.name,
    total: model.anchors.length,
    anchors: model.anchors.map(a => {
      const c = counts.get(clean(a.name)) ?? { queued: 0, waiting: 0 }
      const views = entryViews(a, liveLookup)
      return {
        name: a.name,
        recommend: a.recommend || "",
        skills: a.skills || "",
        duty: dutyText(a, model),
        queued: c.queued,
        waiting: c.waiting,
        queueText: queueTextOf(c),
        queueChips: queueChipsOf([{ sheet: model.name, queued: c.queued, waiting: c.waiting }]),
        entry: entryList(a),
        entryViews: views,
        liveLabels: liveLabelsOf(views),
      }
    }),
  }
}

function dutyText(anchor, model) {
  if (clean(anchor.duty)) return clean(anchor.duty)
  return clean(model?.name)
}

export function anchorsAllView(
  models,
  { liveLookup = null, useTotalSkills = models.length > 1 } = {},
) {
  const PRIMARY = "幽境危战"
  const byName = new Map()
  const countsBySheet = new Map(models.map(model => [model.name, anchorQueueCounts(model)]))
  for (const model of models) {
    for (const a of model.anchors) {
      const key = clean(a.name)
      if (!key) continue
      let hit = byName.get(key)
      if (!hit) {
        hit = {
          name: key,
          recommend: "",
          duties: [],
          sheets: [],
          sheetSkills: new Map(),
          entries: [],
          totalSkills: "",
          queues: [],
        }
        byName.set(key, hit)
      }
      if (!hit.sheets.includes(model.name)) hit.sheets.push(model.name)
      const c = countsBySheet.get(model.name)?.get(key) ?? { queued: 0, waiting: 0 }
      hit.queues.push({ sheet: model.name, queued: c.queued, waiting: c.waiting })
      if (!hit.recommend || recRank(a.recommend) < recRank(hit.recommend)) hit.recommend = clean(a.recommend)
      const duty = clean(a.duty)
      if (duty && !hit.duties.includes(duty)) hit.duties.push(duty)
      const skills = clean(a.skills)
      if (skills && !hit.sheetSkills.has(model.name)) hit.sheetSkills.set(model.name, skills)
      if (clean(a.totalSkills) && !hit.totalSkills) hit.totalSkills = clean(a.totalSkills)
      for (const entry of entryList(a)) if (!hit.entries.includes(entry)) hit.entries.push(entry)
    }
  }
  const anchors = [...byName.values()].map(a => {
    const duties = a.duties.length ? a.duties : a.sheets
    const duty = duties
      .flatMap(d => String(d).split(/[\/、,，]/))
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3)
    const ownSkills = models.length === 1 ? a.sheetSkills.get(models[0].name) : ""
    const skills =
      (useTotalSkills ? clean(a.totalSkills) : ownSkills) ||
      a.sheetSkills.get(PRIMARY) ||
      a.sheetSkills.values().next().value ||
      clean(a.totalSkills) ||
      ""
    const queues = a.queues
    const queueText = (() => {
      if (models.length === 1) return queueTextOf(queues[0])
      const active = queues.filter(q => q.queued || q.waiting)
      if (!active.length) return "排队中 0 人"
      return active.map(q => `${q.sheet}：${queueTextOf(q)}`).join(" / ")
    })()
    const views = entryViews({ entry: a.entries, name: a.name }, liveLookup)
    return {
      name: a.name,
      recommend: a.recommend,
      recTier: recTierOf(a.recommend),
      duty,
      skills,
      queued: queues.reduce((n, q) => n + q.queued, 0),
      waiting: queues.reduce((n, q) => n + q.waiting, 0),
      queues,
      queueText,
      queueChips: queueChipsOf(queues),
      entry: a.entries,
      entryViews: views,
      liveLabels: liveLabelsOf(views),
      sheets: a.sheets,
    }
  })
  anchors.sort((x, y) => recRank(x.recommend) - recRank(y.recommend) || x.name.localeCompare(y.name, "zh"))
  return { total: anchors.length, anchors, names: [...models].map(m => m.name) }
}

export function renderAnchorsAll(view) {
  if (!view.anchors.length) return "表里没有识别到主播信息"
  const lines = view.anchors.map(a => {
    const duty = Array.isArray(a.duty) ? a.duty.join(" / ") : a.duty
    const entries = Array.isArray(a.entryViews) ? a.entryViews : []
    const entry = Array.isArray(a.entryViews)
      ? entries.map(entryText).join(" / ")
      : Array.isArray(a.entry)
        ? a.entry.join(" / ")
        : String(a.entry ?? "").replace(/\n/g, " / ")
    return [
      `· ${a.name}${a.recommend ? `【${a.recommend}】` : ""}${duty ? `　专职：${duty}` : ""}`,
      a.queueText ? `  排队：${a.queueText}` : "",
      a.skills ? `  强项：${a.skills}` : "",
      entry ? `  开播状态：${entry}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  })
  return [`帮帮主播（${view.anchors.length} 位 · ${view.names.join(" / ")}）`, "————————————", lines.join("\n")].join("\n")
}

export function anchorDetailView(models, name, { liveLookup = null } = {}) {
  const want = clean(name)
  if (!want) return null
  const found = []
  for (const model of models) {
    for (const a of model.anchors) {
      if (clean(a.name) !== want) continue
      found.push({ sheet: model.name, anchor: a })
    }
  }
  if (!found.length) return null
  const duties = []
  for (const f of found) {
    const d = clean(f.anchor.duty) || clean(f.sheet)
    for (const piece of String(d).split(/[\/、,，]/).map(s => s.trim()).filter(Boolean))
      if (!duties.includes(piece)) duties.push(piece)
  }
  const recommend = found
    .map(f => clean(f.anchor.recommend))
    .filter(Boolean)
    .sort((x, y) => recRank(x) - recRank(y))[0] ?? ""
  const texts = []
  for (const f of found) for (const e of entryList(f.anchor)) if (!texts.includes(e)) texts.push(e)
  const entries = texts.flatMap(text => entryViews({ entry: [text], name: want }, liveLookup))
  return {
    name: want,
    recommend,
    duties,
    sheets: found.map(f => f.sheet),
    skills: found.map(f => ({ sheet: f.sheet, skills: clean(f.anchor.skills) })).filter(s => s.skills),
    entry: texts,
    entries: texts,
    entryViews: entries,
  }
}

export function renderAnchorDetail(view) {
  if (!view) return "没找到这位主播"
  const lines = [`【${view.name}】${view.recommend ? `【${view.recommend}】` : ""}`.trim(), "————————————"]
  lines.push(`专职：${view.duties.length ? view.duties.join(" / ") : "未标注"}`)
  for (const s of view.skills) lines.push(`${s.sheet} 强项：${s.skills}`)
  const entries = Array.isArray(view.entryViews) ? view.entryViews : []
  if (entries.length) {
    lines.push("")
    lines.push("开播状态：")
    for (const e of entries) lines.push(entryText(e, { withLink: true }))
  } else {
    lines.push("")
    lines.push("开播状态：表里还没填 B 站")
  }
  return lines.join("\n")
}

export function queuingCount(model) {
  return listQueue(model).filter(r => isPending(r.status)).length
}

export function sheetStatus(model) {
  const rows = listQueue(model)
  if (!rows.length) return ""
  const set = new Set(rows.map(r => clean(r.status)).filter(Boolean))
  return set.size === 1 ? [...set][0] : ""
}

export function menuView(models, { defaultSheet = "", version = "" } = {}) {
  const brief = models.map(m => {
    const queuing = queuingCount(m)
    return { name: m.name, count: queuing, status: queuing ? "" : sheetStatus(m), queued: queuing }
  })
  return {
    sheets: brief,
    total: brief.reduce((n, s) => n + s.queued, 0),
    defaultSheet: defaultSheet || models[0]?.name || "幽境危战",
    version,
  }
}

export function renderAnchors(model) {
  if (!model.anchors.length) return `【${model.name}】表里没有识别到主播信息`
  const counts = anchorQueueCounts(model)
  const lines = model.anchors.map(a => {
    const entries = Array.isArray(a.entryViews) ? a.entryViews : []
    const entry = Array.isArray(a.entryViews)
      ? entries.map(entryText).join(" / ")
      : Array.isArray(a.entry)
        ? a.entry.join(" / ")
        : String(a.entry ?? "").replace(/\n/g, " / ")
    const queue = queueTextOf(counts.get(clean(a.name)) ?? { queued: 0, waiting: 0 })
    return [
      `· ${a.name}${a.recommend ? `【${a.recommend}】` : ""}`,
      `  排队：${queue}`,
      a.skills ? `  强项：${a.skills}` : "",
      entry ? `  开播状态：${entry}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  })
  return [`【${model.name}】帮帮主播（${model.anchors.length} 位）`, "————————————", lines.join("\n")].join("\n")
}

function anchorsOf(model, value, aliases = []) {
  const out = []
  for (const token of String(value ?? "")
    .split(/[,，、]/)
    .map(clean)
    .filter(Boolean)) {
    const hit = (model.anchors ?? []).find(a => a.name === canonicalAnchor(token, aliases))
    if (hit && !out.includes(hit)) out.push(hit)
  }
  return out
}

export function mineView(models, store, qq, nickname = "", { aliases = [], moreNames = [], liveLookup = null } = {}) {
  const active = []
  const binds = []
  const drops = []
  const renames = []
  const missed = []
  const names = [nickname, ...moreNames].map(clean).filter(Boolean).filter((n, i, a) => a.indexOf(n) === i)
  for (const model of models.values()) {
    let hit = null
    let fallback = null
    for (const name of names) {
      const one = locateSelf(model, store, model.name, qq, name)
      const rowNick = one.row ? clean(model.rows.find(row => row.row === one.row)?.nickname) : ""
      if (one.row && one.renamedFrom !== undefined && !names.includes(rowNick)) {
        if (!fallback) fallback = one
        continue
      }
      if (one.row) {
        hit = one
        break
      }
      if (!fallback) fallback = one
    }
    if (!hit && fallback?.row) {
      for (const name of names) {
        const byName = locateSelf(model, store, model.name, qq, name, { ignoreBind: true })
        if (byName.row) {
          hit = byName
          break
        }
      }
    }
    if (!hit) hit = fallback ?? { row: 0, source: "none", nick: "" }
    if (hit.stale) {
      drops.push({ sheet: model.name, row: 0 })
      if (!hit.row && names.length) missed.push(missedOf(model, store, qq, names))
    }
    if (hit.bind && !hit.stale) binds.push({ sheet: model.name, ...hit.bind })
    if (hit.renamedFrom !== undefined) {
      renames.push({ sheet: model.name, row: hit.row, from: hit.renamedFrom, to: hit.nick })
      binds.push({ sheet: model.name, row: hit.row, nickname: hit.nick })
    }
    if (!hit.row) continue
    const item = model.rows.find(i => i.row === hit.row)
    if (!item) continue
    const pos = listQueue(model).findIndex(i => i.row === item.row) + 1
    const anchors = anchorsOf(model, item.anchor, aliases)
    const anchorEntries = []
    const seenEntries = new Set()
    for (const a of anchors) {
      for (const e of entryViews(a, liveLookup)) {
        if (seenEntries.has(e.text)) continue
        seenEntries.add(e.text)
        anchorEntries.push(e)
      }
    }
    active.push({
      sheet: model.name,
      seq: pos ? String(pos) : item.seq || String(item.row),
      row: item.row,
      nickname: clean(item.nickname),
      gameName: clean(item.gameName),
      anchor: clean(item.anchor),
      anchorEntry: anchorEntries.map(e => e.text).join(" "),
      anchorEntries,
      anchorMultiple: anchors.length > 1,
      anchorLive: anchorEntries.find(e => e.live)?.live ?? null,
      goal: clean(item.goal),
      ...(() => {
        const gp = goalParts(item.goal)
        return {
          goalPrefix: gp.prefix,
          goalTarget: gp.target,
          goalPrefixTone: gp.prefixTone,
          goalTargetTone: gp.color,
          goalTone: gp.color,
        }
      })(),
      rawStatus: clean(item.status),
      status: displayStatus(item.status),
    statusTone: statusTone(displayStatus(item.status)),
      note: clean(item.note),
    })
  }
  return { total: active.length, active, binds, drops, renames, missed }
}

export function exactSelfView(view, names = []) {
  const wanted = new Set(names.map(clean).filter(Boolean))
  if (!view?.active?.length || !wanted.size) return view
  const exact = view.active.filter(item => wanted.has(clean(item.nickname)))
  if (!exact.length || exact.length === view.active.length) return view
  const keep = new Set(exact)
  const dropped = view.active
    .filter(item => !keep.has(item))
    .map(item => ({ sheet: item.sheet, row: 0 }))
  return {
    ...view,
    active: exact,
    total: exact.length,
    drops: [...(view.drops ?? []), ...dropped],
  }
}

function missedOf(model, store, qq, names = []) {
  const bind = store?.get?.(model.name, qq)
  const bindRow = Number(bind?.row ?? 0)
  const bindNick = clean(model.rows.find(r => r.row === bindRow)?.nickname)
  const rows = model.rows.filter(r => names.some(n => clean(r.nickname) === n))
  const why = rows.length === 0 ? "none" : rows.length > 1 ? "dup" : "claimed"
  return { sheet: model.name, bindRow, bindNick, nick: names[0] ?? "", names: [...names], why }
}

function liveTextOf(e) {
  const parts = []
  const seen = new Set()
  for (const en of e.anchorEntries ?? []) {
    if (!en.live) continue
    const key = `${en.live.anchorName}|${en.live.roomId}|${en.live.label}`
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(e.anchorMultiple ? `${en.live.anchorName} ${en.live.label}` : en.live.label)
  }
  return parts.join(" / ")
}

export function renderMine(view) {
  if (!view.total) return "还没有你的排队信息。报名 / 改表请用在线编辑器。"
  const lines = view.active.map(e => {
    const live = liveTextOf(e)
    return `· ${e.sheet}：第 ${e.seq} 位｜${[e.anchor, e.goal].filter(Boolean).join(" ｜ ")}${
      live ? `（${live}）` : ""
    }`
  })
  return ["你的排队信息：", ...lines].join("\n")
}

export function renderMenu(models, { defaultSheet = "" } = {}) {
  const brief = models
    .map(m => {
      const queuing = queuingCount(m)
      const status = queuing ? "" : sheetStatus(m)
      return status ? `· ${m.name}：${status}` : `· ${m.name}：${queuing} 人排队中`
    })
    .join("\n")
  return [
    "三路深渊排队",
    "————————————",
    brief,
    "",
    "总览 + 我的排队信息：#排队",
    "单个榜单：#排队 <榜>（榜名可写 危战 / 剧诗 / 深渊 或序号）",
    "主播列表：#主播（合并三榜）/#主播 <榜>/#主播 <名字> 看单人详情",
    "开播提醒：#排队开播提醒（开 / 关，只 @ 订阅过的人）",
    "全部指令：#排队帮助",
    "报名 / 退队 / 改备注：在在线编辑器里改表（群里发 #排队 取带口令的链接）",
  ].join("\n")
}
