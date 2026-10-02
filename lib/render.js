/**
 * 文本渲染（纯函数）
 */
import { listQueue, locateSelf } from "./queue.js"
import { canonicalAnchor } from "./aliases.js"
import { splitItems } from "./text.js"

const clean = s => String(s ?? "").trim()

const line = item => {
  const head = `${item.seq || item.row}. ${item.nickname}（${item.gameName || "未填游戏名"}）`
  const body = [item.anchor, item.goal, item.strength].filter(Boolean).join(" ｜ ")
  const extra = []
  if (item.status) extra.push(`状态：${item.status}`)
  if (item.note) extra.push(`备注：${item.note}`)
  return [`${head}`, `   ${body}`, extra.length ? `   ${extra.join("　")}` : ""].filter(Boolean).join("\n")
}

export function renderQueue(model, { limit = 20, myRow = 0 } = {}) {
  const all = listQueue(model)
  if (!all.length) return `【${model.name}】还没有人排队`

  const shown = limit > 0 ? all.slice(0, limit) : all
  const lines = shown.map(item => (item.row === myRow ? `${line(item)}   ⬅️ 你` : line(item)))

  const more = all.length > shown.length ? `\n…… 还有 ${all.length - shown.length} 人，发送 #${model.name} 全部 查看` : ""
  const mine = all.find(i => i.row === myRow)
  const mineText = mine ? `\n你的位置：第 ${mine.seq || mine.row} 位` : ""

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

/** 把主播的 entry（数组，或历史字符串）拍平成字符串数组；链接不会被斜杠拆碎 */
function entryList(anchor) {
  return splitItems(anchor?.entry).flatMap(e => String(e).split("\n")).map(s => s.trim()).filter(Boolean)
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
      entry: entryList(a),
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
 * 同一个主播在三个榜的主播区里各有一行（强项/入口可能不同），这里按名字合并成一位：
 *   - duty   专职：手填的 D 列优先，否则按他出现过的榜；渲染时一行一个榜（最多三行）
 *   - skills 核心强项：**只取幽境危战那一行**（没有则退回落到的第一个榜），其余榜的强项不展示
 *   - entry  直播入口：多个入口换行显示
 */
export function anchorsAllView(models) {
  const PRIMARY = "幽境危战"
  const byName = new Map()
  for (const model of models) {
    for (const a of model.anchors) {
      const key = clean(a.name)
      if (!key) continue
      let hit = byName.get(key)
      if (!hit) {
        hit = { name: key, recommend: "", duties: [], sheets: [], sheetSkills: new Map(), entries: [] }
        byName.set(key, hit)
      }
      if (!hit.sheets.includes(model.name)) hit.sheets.push(model.name)
      /** 推荐度取更靠前的那个（强烈推荐 > 提分推荐 > 可选） */
      const rank = r => (/强烈/.test(r) ? 0 : /提分/.test(r) ? 1 : /可选/.test(r) ? 2 : 3)
      if (!hit.recommend || rank(a.recommend) < rank(hit.recommend)) hit.recommend = clean(a.recommend)
      const duty = clean(a.duty)
      if (duty && !hit.duties.includes(duty)) hit.duties.push(duty)
      const skills = clean(a.skills)
      if (skills && !hit.sheetSkills.has(model.name)) hit.sheetSkills.set(model.name, skills)
      for (const entry of entryList(a)) if (!hit.entries.includes(entry)) hit.entries.push(entry)
    }
  }

  const anchors = [...byName.values()].map(a => {
    const duties = a.duties.length ? a.duties : a.sheets
    /** 最多三行；顺带把「/」分隔的多榜写法也拆开 */
    const duty = duties
      .flatMap(d => String(d).split(/[\/、,，]/))
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3)
    const skills = a.sheetSkills.get(PRIMARY) ?? a.sheetSkills.values().next().value ?? ""
    return {
      name: a.name,
      recommend: a.recommend,
      duty,
      skills,
      /** 入口：一项一行（G/H 两列与格内的「/」都算两项），不做深渊分组 */
      entry: a.entries,
      sheets: a.sheets,
    }
  })

  /** 排序：先按推荐度，再按名字（中文按拼音） */
  const rank = r => (/强烈/.test(r) ? 0 : /提分/.test(r) ? 1 : /可选/.test(r) ? 2 : 3)
  anchors.sort((x, y) => rank(x.recommend) - rank(y.recommend) || x.name.localeCompare(y.name, "zh"))

  return { total: anchors.length, anchors, names: [...models].map(m => m.name) }
}

/** 合并主播视图的文本回退 */
export function renderAnchorsAll(view) {
  if (!view.anchors.length) return "表里没有识别到主播信息"
  const lines = view.anchors.map(a => {
    const duty = Array.isArray(a.duty) ? a.duty.join(" / ") : a.duty
    const entry = Array.isArray(a.entry) ? a.entry.join(" / ") : String(a.entry ?? "").replace(/\n/g, " / ")
    return [
      `· ${a.name}${a.recommend ? `【${a.recommend}】` : ""}${duty ? `　专职：${duty}` : ""}`,
      a.skills ? `  强项：${a.skills}` : "",
      entry ? `  入口：${entry}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  })
  return [`帮帮主播（${view.anchors.length} 位 · ${view.names.join(" / ")}）`, "————————————", lines.join("\n")].join("\n")
}

/**
 * 单个主播的详情
 *
 * 跨三个榜找他（同名视为同一位主播）：
 *   - duty   专职（手填 D 列优先，否则他出现的榜）
 *   - skills 各榜的强项分别列出（详情里给全，不像合并表只留幽境危战）
 *   - 入口   跨榜去重后的平台列表，不按榜分组
 */
export function anchorDetailView(models, name) {
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

  const rank = r => (/强烈/.test(r) ? 0 : /提分/.test(r) ? 1 : /可选/.test(r) ? 2 : 3)
  const recommend = found
    .map(f => clean(f.anchor.recommend))
    .filter(Boolean)
    .sort((x, y) => rank(x) - rank(y))[0] ?? ""

  /** 入口不区分深渊：跨榜去重后就是一个平台列表 */
  const entries = []
  for (const f of found) for (const e of entryList(f.anchor)) if (!entries.includes(e)) entries.push(e)

  return {
    name: want,
    recommend,
    duties,
    sheets: found.map(f => f.sheet),
    /** 各榜强项（详情里全部列出） */
    skills: found.map(f => ({ sheet: f.sheet, skills: clean(f.anchor.skills) })).filter(s => s.skills),
    entries,
  }
}

export function renderAnchorDetail(view) {
  if (!view) return "没找到这位主播"
  const lines = [`【${view.name}】${view.recommend ? `【${view.recommend}】` : ""}`.trim(), "————————————"]
  lines.push(`专职：${view.duties.length ? view.duties.join(" / ") : "未标注"}`)
  for (const s of view.skills) lines.push(`${s.sheet} 强项：${s.skills}`)
  if (view.entries.length) {
    lines.push("")
    lines.push("直播入口：")
    for (const e of view.entries) lines.push(e)
  } else {
    lines.push("")
    lines.push("直播入口：表里还没填")
  }
  return lines.join("\n")
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

export function renderAnchors(model) {
  if (!model.anchors.length) return `【${model.name}】表里没有识别到主播信息`
  const lines = model.anchors.map(a => {
    const entry = Array.isArray(a.entry) ? a.entry.join(" / ") : String(a.entry ?? "").replace(/\n/g, " / ")
    return [`· ${a.name}${a.recommend ? `【${a.recommend}】` : ""}`, a.skills ? `  强项：${a.skills}` : "", entry ? `  入口：${entry}` : ""]
      .filter(Boolean)
      .join("\n")
  })
  return [`【${model.name}】帮帮主播（${model.anchors.length} 位）`, "————————————", lines.join("\n")].join("\n")
}

/**
 * 「我的排队信息」的视图数据
 *
 * 按 QQ 定位（见 lib/queue.js 的 locateSelf）：有绑定就认绑定，没有则按群昵称兜底。
 * 除了命中的行，还会带出三类待办，交给调用方落实：
 *   binds  首次按昵称认出来的人 → 记下 QQ 绑定
 *   drops  失效绑定（那一行没了，或已经是别人的了）→ 删掉
 *   renames 本人改了群名片 → 把表里的群昵称同步成新名片
 */
export function mineView(models, store, qq, nickname = "", { aliases = [] } = {}) {
  const active = []
  const binds = []
  const drops = []
  const renames = []
  for (const model of models.values()) {
    const hit = locateSelf(model, store, model.name, qq, nickname)
    if (hit.stale) drops.push({ sheet: model.name, row: 0 })
    if (hit.bind && !hit.stale) binds.push({ sheet: model.name, ...hit.bind })
    if (hit.renamedFrom !== undefined) {
      renames.push({ sheet: model.name, row: hit.row, from: hit.renamedFrom, to: hit.nick })
      /** 绑定里记的昵称也跟着刷新，下次直接对得上 */
      binds.push({ sheet: model.name, row: hit.row, nickname: hit.nick })
    }
    if (!hit.row) continue
    const item = model.rows.find(i => i.row === hit.row)
    if (!item) continue
    /** 表里写的是别名（例如「璃月第一深情」）时也要认出是哪位主播，才带得出他的直播入口 */
    const anchor = model.anchors.find(a => a.name === canonicalAnchor(item.anchor, aliases))
    active.push({
      sheet: model.name,
      seq: item.seq || String(item.row),
      row: item.row,
      nickname: clean(item.nickname),
      gameName: clean(item.gameName),
      anchor: clean(item.anchor),
      anchorEntry: entryList(anchor).join(" "),
      goal: clean(item.goal),
      strength: clean(item.strength),
      status: clean(item.status),
      note: clean(item.note),
    })
  }
  return { total: active.length, active, binds, drops, renames }
}

/** 「我的排队信息」文本回退 */
export function renderMine(view) {
  if (!view.total) return "还没有你的排队信息。报名 / 改表请用在线编辑器。"
  const lines = view.active.map(
    e => `· ${e.sheet}：第 ${e.seq} 位｜${[e.anchor, e.goal, e.strength].filter(Boolean).join(" ｜ ")}`,
  )
  return ["你的排队信息：", ...lines].join("\n")
}

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
    "总览 + 我的排队信息：#排队",
    "单个榜单：#排队 <榜>（榜名可写 危战 / 剧诗 / 深渊 或序号）",
    "主播列表：#主播（合并三榜）/#主播 <榜>/#主播 <名字> 看单人详情",
    "报名 / 退队 / 改备注：在在线编辑器里改表（群里发 #排队 取带口令的链接）",
  ].join("\n")
}


