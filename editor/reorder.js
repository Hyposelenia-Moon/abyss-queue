/** 四张表的统一重排序规则（纯函数，不读写文件）。 */
import {
  ATTACK_ALL_MODES,
  ATTACK_TARGET_NAMES,
  attackStatusParts,
  attackVersionOfMode,
  parseAttackGoal,
} from "../components/attack.js"

const QUEUED_STATUS = "排队中"
const WAITING_STATUS = "等待开启"
const SELF_DONE = "本人已完成"

const norm = value =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s\u200b-\u200d\ufeff]/g, "")
    .toLowerCase()
const statusTokens = status =>
  String(status ?? "")
    .split(/[,，]/)
    .map(value => value.trim())
    .filter(Boolean)
const GOAL_ORDERS = {
  幻想真境剧诗: [
    "困难模式满原石",
    "困难模式满星章",
    "卓越模式满原石",
    "卓越模式满星章",
    "月谕模式满原石",
    "月谕模式满星章",
  ],
  幽境危战: ["险恶(N4)", "无畏(N5)", "绝境(N6)", "绝境(N6)180s"],
  深境螺旋: ["第11层满星", "第12层满星"],
}

const TARGET_ORDER = new Map(ATTACK_TARGET_NAMES.map((name, index) => [name, index]))
const MODE_ORDER = new Map(ATTACK_ALL_MODES.map((name, index) => [name, index]))

const clean = value => String(value ?? "").trim()

export function groupRankOf(status) {
  const value = clean(status)
  if (value === WAITING_STATUS) return 1
  if (!value || value === QUEUED_STATUS) return 2
  return 0
}

export function attackGroupRank(status) {
  const value = clean(status)
  if (!value) return 3
  if (value === WAITING_STATUS) return 2
  if (value === QUEUED_STATUS) return 3
  const parts = attackStatusParts(value)
  if (!parts) return 1
  if (parts.some(part => part.kind === "queued")) return 3
  if (parts.some(part => part.kind === "waiting")) return 2
  return 1
}

export function goalRankOf(sheet, goal) {
  const value = clean(goal)
  if (!value) return { difficulty: Infinity, target: Infinity }
  if (sheet === "绝境攻炼") {
    const parsed = parseAttackGoal(value)
    if (!parsed) return { difficulty: Infinity, target: Infinity }
    const indexes = parsed.modes.map(mode => MODE_ORDER.get(mode)).filter(Number.isInteger)
    if (!indexes.length) return { difficulty: Infinity, target: Infinity }
    const target = TARGET_ORDER.get(parsed.target)
    return {
      difficulty: Math.max(...indexes),
      target: Number.isInteger(target) ? target : Infinity,
    }
  }
  const ladder = GOAL_ORDERS[sheet]
  const index = ladder ? ladder.indexOf(value) : -1
  return index >= 0 ? { difficulty: index, target: 0 } : { difficulty: Infinity, target: Infinity }
}

export function completionRankOf(row, { anchors = [], tempNames = [] } = {}) {
  if (groupRankOf(row?.status) !== 0) return 4
  const status = clean(row?.status)
  const nickname = clean(row?.nickname)
  const tokens = statusTokens(status)
  const self = Boolean(nickname) && (status === nickname || tokens.some(token => token === nickname))
  if (self || status === SELF_DONE || tokens.includes(SELF_DONE)) return 0
  const anchorSet = new Set(anchors.map(norm).filter(Boolean))
  if (tokens.some(token => anchorSet.has(norm(token)))) return 1
  const tempSet = new Set(tempNames.map(norm).filter(Boolean))
  if (tokens.some(token => tempSet.has(norm(token)))) return 2
  return 3
}

const attackTargetRankOf = goal => {
  const parsed = parseAttackGoal(clean(goal))
  const target = parsed ? TARGET_ORDER.get(parsed.target) : undefined
  return Number.isInteger(target) ? target : Infinity
}

const attackModeCountOf = goal => {
  const parsed = parseAttackGoal(clean(goal), { expand: false })
  if (!parsed) return Infinity
  return [...new Set(parsed.modes.map(mode => attackVersionOfMode(mode) || mode))].length
}

function compareAttackRows(a, b) {
  const group = attackGroupRank(a?.status) - attackGroupRank(b?.status)
  if (group) return group
  const modes = attackModeCountOf(a?.goal) - attackModeCountOf(b?.goal)
  if (modes) return modes
  const target = attackTargetRankOf(a?.goal) - attackTargetRankOf(b?.goal)
  if (target) return target
  return Number(a?.row) - Number(b?.row)
}

export function compareReorderRows(sheet, a, b, { anchors = [], tempNames = [] } = {}) {
  if (sheet === "绝境攻炼") return compareAttackRows(a, b)
  const group = groupRankOf(a?.status) - groupRankOf(b?.status)
  if (group) return group
  const ga = goalRankOf(sheet, a?.goal)
  const gb = goalRankOf(sheet, b?.goal)
  if (ga.difficulty !== gb.difficulty) return ga.difficulty - gb.difficulty
  if (ga.target !== gb.target) return ga.target - gb.target
  const completion =
    completionRankOf(a, { anchors, tempNames }) - completionRankOf(b, { anchors, tempNames })
  if (completion) return completion
  return Number(a?.row) - Number(b?.row)
}

export function tidyOrder(model, { tempNames = [], frontNames = [] } = {}) {
  const records = (model?.rows ?? [])
    .filter(row => clean(row?.nickname))
    .sort((a, b) => Number(a.row) - Number(b.row))
  if (records.length < 2) return null
  const anchors = (model?.anchors ?? []).map(anchor => (typeof anchor === "string" ? anchor : anchor?.name))
  const slots = records.map(row => Number(row.row))
  const frontRank = new Map(
    frontNames.map(name => clean(name)).filter(Boolean).map((name, index) => [name, index]),
  )
  const rankOf = row => {
    if (!frontRank.size) return Infinity
    const queued =
      model.name === "绝境攻炼"
        ? attackGroupRank(row?.status) === 3
        : clean(row?.status) === QUEUED_STATUS
    return queued ? (frontRank.get(clean(row?.nickname)) ?? Infinity) : Infinity
  }
  const out = records.slice().sort((a, b) => {
    const fa = rankOf(a)
    const fb = rankOf(b)
    if (fa !== fb) return fa - fb
    return compareReorderRows(model.name, a, b, { anchors, tempNames })
  })
  const order = out.map(row => Number(row.row))
  if (order.every((row, index) => row === slots[index])) return null
  return {
    slots,
    order,
    groups: new Set(records.map(row => groupRankOf(row.status))).size,
  }
}
