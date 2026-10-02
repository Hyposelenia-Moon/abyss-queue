/**
 * 文本渲染（纯函数）
 */
import { listQueue } from "./queue.js"

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

/** 总菜单 */
export function renderMenu(models, { defaultSheet = "" } = {}) {
  const brief = models.map(m => `· ${m.name}：${listQueue(m).length} 人在排`).join("\n")
  return [
    "三路深渊排队",
    "————————————",
    brief,
    "",
    "查看队列：#" + (defaultSheet || models[0]?.name || "幽境危战"),
    "报名（引导）：#深渊报名",
    "报名（一行）：#深渊报名 <榜> <游戏名> <主播> <难度> <强度> [备注]",
    "退队：#深渊退队",
    "改备注：#深渊改备注 <内容>",
    "主播列表：#深渊主播 <榜>",
  ].join("\n")
}

/** 报名确认摘要 */
export function renderJoinSummary(sheetName, data, row) {
  return [
    `请确认报名信息（${sheetName}）`,
    "————————————",
    `群昵称：${clean(data.nickname)}`,
    `游戏名：${clean(data.gameName)}`,
    `主播：${clean(data.anchor)}`,
    `难度：${clean(data.goal)}`,
    `强度：${clean(data.strength)}`,
    `备注：${clean(data.note) || "无"}`,
    `写入位置：表格第 ${row} 行`,
    "",
    "回复 1 确认提交，回复 0 取消",
  ].join("\n")
}
