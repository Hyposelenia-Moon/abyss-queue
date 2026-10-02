/**
 * 文本渲染（纯函数）
 */
import { listQueue, myRowOf } from "./queue.js"

const clean = s => String(s ?? "").trim()

const line = item => {
  const head = `${item.seq || item.row}. ${item.nickname}（${item.gameName || "未填游戏名"}）`
  const body = [item.anchor, item.goal, item.strength].filter(Boolean).join(" ｜ ")
  const extra = []
  if (item.status) extra.push(`状态：${item.status}`)
  if (item.note) extra.push(`备注：${item.note}`)
  return [`${head}`, `   ${body}`, extra.length ? `   ${extra.join("　")}` : ""].filter(Boolean).join("\n")
}

/** 单个榜的队列 */
export function renderQueue(model, { limit = 20, myRow = 0 } = {}) {
  const all = listQueue(model)
  if (!all.length) return `【${model.name}】还没有人排队`

  const shown = limit > 0 ? all.slice(0, limit) : all
  const lines = shown.map(item => (item.row === myRow ? `${line(item)}   ⬅️ 你` : line(item)))

  const more = all.length > shown.length ? `\n…… 还有 ${all.length - shown.length} 人，发送 #${model.name} 全部 查看` : ""
  const mine = all.find(i => i.row === myRow)
  const mineText = mine ? `\n你的位置：第 ${mine.seq || mine.row} 位（表格第 ${mine.row} 行）` : ""

  return [
    `【${model.name}】共 ${all.length} 人在排`,
    model.title ? `表：${model.title}` : "",
    "————————————",
    lines.join("\n"),
    more,
    mineText,
  ]
    .filter(i => i !== "")
    .join("\n")
}

/** 按显示宽度截断（CJK 记 2，避免长昵称/备注撑爆表格列） */
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
 * 单行的显示视图（队列列表用）
 *
 * 名单只保留三列：序号 / 成员（群昵称）/ 完成情况。
 * 其余信息（游戏名、主播、难度、强度、备注）只在「本人」区块里完整给出。
 */
export function queueItemView(item, { myRow = 0, nameMax = 0, statusMax = 0 } = {}) {
  const cut = (text, width) => (width > 0 ? truncateWidth(text, width) : clean(text))
  return {
    seq: item.seq || String(item.row),
    nickname: cut(item.nickname, nameMax),
    status: cut(item.status, statusMax),
    mine: item.row === myRow,
  }
}

/** 本人的完整信息（列表里查不到，单独展示） */
export function ownRowView(item, { row = 0 } = {}) {
  if (!item) return null
  return {
    seq: item.seq || String(item.row),
    row: item.row || row,
    nickname: clean(item.nickname),
    gameName: clean(item.gameName) || "未填游戏名",
    anchor: clean(item.anchor),
    goal: clean(item.goal),
    strength: clean(item.strength),
    status: clean(item.status),
    note: clean(item.note),
  }
}

/** 队列模板数据（供 HTML 渲染使用） */
export function queueView(model, { limit = 20, myRow = 0, nameMax = 0, statusMax = 0 } = {}) {
  const all = listQueue(model)
  const shown = limit > 0 ? all.slice(0, limit) : all
  const mine = all.find(i => i.row === myRow)
  return {
    name: model.name,
    title: model.title || "",
    total: all.length,
    rows: shown.map(item => queueItemView(item, { myRow, nameMax, statusMax })),
    more: all.length > shown.length ? all.length - shown.length : 0,
    own: ownRowView(mine),
  }
}

/** 主播模板数据（单榜，保留兼容） */
export function anchorsView(model) {
  return {
    name: model.name,
    total: model.anchors.length,
    anchors: model.anchors.map(a => ({
      name: a.name,
      recommend: a.recommend || "",
      skills: a.skills || "",
      duty: dutyText(a, model),
      entry: a.entry || "",
    })),
  }
}

/**
 * 专职文字
 *
 * 优先用主播区 D 列手填的「专职」；没填就按他出现在哪些榜里推断——
 * 同一个主播会同时出现在多个榜的主播区，那本身就是他的服务范围。
 */
function dutyText(anchor, model) {
  if (clean(anchor.duty)) return clean(anchor.duty)
  return clean(model?.name)
}

/**
 * 全部榜的主播合并视图
 *
 * 同一个主播在三个榜的主播区里各有一行（强项/入口可能不同），这里按名字合并成一位，
 * 「专职」列汇总他在哪些榜服务：手填的专职优先，其次用出现过的榜名。
 */
export function anchorsAllView(models) {
  const byName = new Map()
  for (const model of models) {
    for (const a of model.anchors) {
      const key = clean(a.name)
      if (!key) continue
      let hit = byName.get(key)
      if (!hit) {
        hit = { name: key, recommend: "", duties: [], skills: [], entry: "", sheets: [] }
        byName.set(key, hit)
      }
      if (!hit.sheets.includes(model.name)) hit.sheets.push(model.name)
      /** 推荐度取更靠前的那个（强烈推荐 > 提分推荐 > 可选） */
      const rank = r => (/强烈/.test(r) ? 0 : /提分/.test(r) ? 1 : /可选/.test(r) ? 2 : 3)
      if (!hit.recommend || rank(a.recommend) < rank(hit.recommend)) hit.recommend = clean(a.recommend)
      const duty = clean(a.duty)
      if (duty && !hit.duties.includes(duty)) hit.duties.push(duty)
      const skills = clean(a.skills)
      if (skills && !hit.skills.includes(skills)) hit.skills.push(skills)
      /** 入口取第一个非空的（多数是本榜的主入口） */
      if (!hit.entry && clean(a.entry)) hit.entry = clean(a.entry)
    }
  }

  const anchors = [...byName.values()].map(a => ({
    name: a.name,
    recommend: a.recommend,
    /** 手填专职优先；否则用出现过的榜名 */
    duty: a.duties.length ? a.duties.join(" / ") : a.sheets.join(" / "),
    skills: a.skills.join("；"),
    entry: a.entry,
    sheets: a.sheets,
  }))

  /** 排序：先按推荐度，再按原表出现顺序（sheet 顺序即表的顺序） */
  const rank = r => (/强烈/.test(r) ? 0 : /提分/.test(r) ? 1 : /可选/.test(r) ? 2 : 3)
  anchors.sort((x, y) => rank(x.recommend) - rank(y.recommend) || x.name.localeCompare(y.name, "zh"))

  return { total: anchors.length, anchors, names: [...models].map(m => m.name) }
}

/** 合并主播视图的文本回退 */
export function renderAnchorsAll(view) {
  if (!view.anchors.length) return "表里没有识别到主播信息"
  const lines = view.anchors.map(a =>
    [
      `· ${a.name}${a.recommend ? `【${a.recommend}】` : ""}${a.duty ? `　专职：${a.duty}` : ""}`,
      a.skills ? `  强项：${a.skills}` : "",
      a.entry ? `  入口：${a.entry}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  )
  return [`帮帮主播（${view.anchors.length} 位 · ${view.names.join(" / ")}）`, "————————————", lines.join("\n")].join("\n")
}

/**
 * 榜单的整体状态
 *
 * 有些榜整榜是同一个状态而不是"有人在排"，例如深境螺旋还没开时每行都写着「等待开启」。
 * 这时菜单应该同步显示这个状态，而不是把它当成"已有人排队"。只有在**整榜状态一致**时
 * 才返回该状态，否则返回空串（正常的混合状态由每行的徽章去表达）。
 */
export function sheetStatus(model) {
  const rows = listQueue(model)
  if (!rows.length) return ""
  const set = new Set(rows.map(r => clean(r.status)).filter(Boolean))
  return set.size === 1 ? [...set][0] : ""
}

/** 菜单模板数据 */
export function menuView(models, { defaultSheet = "", version = "", editorUrl = "" } = {}) {
  const brief = models.map(m => {
    const rows = listQueue(m)
    const status = sheetStatus(m)
    return { name: m.name, count: rows.length, status, queued: status ? 0 : rows.length }
  })
  return {
    sheets: brief,
    total: brief.reduce((n, s) => n + s.queued, 0),
    defaultSheet: defaultSheet || models[0]?.name || "幽境危战",
    version,
    editorUrl,
  }
}

/** 主播区 */
export function renderAnchors(model) {
  if (!model.anchors.length) return `【${model.name}】表里没有识别到主播信息`
  const lines = model.anchors.map(a =>
    [`· ${a.name}${a.recommend ? `【${a.recommend}】` : ""}`, a.skills ? `  强项：${a.skills}` : "", a.entry ? `  入口：${a.entry}` : ""]
      .filter(Boolean)
      .join("\n"),
  )
  return [`【${model.name}】帮帮主播（${model.anchors.length} 位）`, "————————————", lines.join("\n")].join("\n")
}

/**
 * 「我的排队记录」的视图数据
 *
 * 遍历**所有榜**（不再只看绑定过的榜）：绑定优先，其次按群昵称兜底匹配——
 * 填表已经移到本地编辑器，表里不会为每个人留下绑定记录。
 * 每个命中的榜一条：位置、表格行、主播/难度/强度，以及该主播的直播入口。
 */
export function mineView(models, store, qq, nickname = "") {
  const active = []
  for (const model of models.values()) {
    const row = myRowOf(model, store, model.name, qq, nickname)
    if (!row) continue
    const item = model.rows.find(i => i.row === row)
    if (!item) continue
    const hit = model.anchors.find(a => a.name === item.anchor)
    active.push({
      sheet: model.name,
      seq: item.seq || String(item.row),
      row: item.row,
      nickname: clean(item.nickname),
      gameName: clean(item.gameName),
      anchor: clean(item.anchor),
      anchorEntry: clean(hit?.entry),
      goal: clean(item.goal),
      strength: clean(item.strength),
      status: clean(item.status),
      note: clean(item.note),
    })
  }
  return { total: active.length, active }
}

/** 「我的排队记录」文本回退 */
export function renderMine(view) {
  if (!view.total) return "还没有你的排队记录。报名请用桌面「排队表编辑器」填表。"
  const lines = view.active.map(
    e =>
      `· ${e.sheet}：第 ${e.seq} 位（表格第 ${e.row} 行）｜${[e.anchor, e.goal, e.strength].filter(Boolean).join(" ｜ ")}`,
  )
  return ["你的排队记录：", ...lines].join("\n")
}

/** 总菜单 */
export function renderMenu(models, { defaultSheet = "" } = {}) {
  const brief = models
    .map(m => {
      /* 整榜状态（如「等待开启」）优先于人数显示，与图片菜单保持一致 */
      const status = sheetStatus(m)
      return status ? `· ${m.name}：${status}` : `· ${m.name}：${listQueue(m).length} 人在排`
    })
    .join("\n")
  return [
    "三路深渊排队",
    "————————————",
    brief,
    "",
    "查看总览：#排队",
    "查看榜单：#排队 <榜>（榜名可写 危战 / 剧诗 / 深渊 或序号）",
    "我的记录：#我的",
    "主播列表：#主播 [榜]",
    "报名 / 退队 / 改备注：在本地编辑器里改表（桌面「排队表编辑器」）",
    "更新插件：#更新 abyss",
  ].join("\n")
}


