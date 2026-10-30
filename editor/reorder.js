/**
 * 四张表的统一重排序规则（纯函数，不读写文件）。
 *
 * 分组：已完成 → 等待开启 → 排队中
 * 组内：难度 → 目标 → 账号强度（低配 → 中配 → 高配 → 待定）
 *       → 完成类型（本人 → 主播 → 本月临时名 → 未知）→ 原始行号
 *
 * `goal` 是各榜自己的组合文字，这里只负责把文字换成可比较的排名；
 * 四张表共用同一个 `compareReorderRows`，差异只在 `GOAL_ORDERS` / 攻炼的解析器。
 */
import { ATTACK_ALL_MODES, ATTACK_MODES, ATTACK_TARGET_NAMES, parseAttackGoal } from "../components/attack.js"

const QUEUED_STATUS = "排队中"
const WAITING_STATUS = "等待开启"
const SELF_DONE = "本人已完成"

export const REORDER_SHEETS = ["幻想真境剧诗", "幽境危战", "深境螺旋", "绝境攻炼"]

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

/**
 * 剧诗 / 危战 / 深渊的目标阶梯。
 * 数组顺序就是“难度从小到大、同难度目标从小到大”。
 */
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

/** 分组：0 已完成，1 等待开启，2 排队中（空值/未知状态也归最后一组） */
export function groupRankOf(status) {
  const value = clean(status)
  if (value === WAITING_STATUS) return 1
  if (!value || value === QUEUED_STATUS) return 2
  return 0
}

/**
 * 难度/目标排名。
 * 非攻炼榜用配置阶梯的序号；攻炼拆成「最高难度模式 + 目标」两段。
 */
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

/** 账号强度：低配 0 → 中配 1 → 高配 2 → 待定 3；无法识别最后 */
export function strengthRankOf(strength) {
  const value = clean(strength)
  if (value.startsWith("低配")) return 0
  if (value.startsWith("中配")) return 1
  if (value.startsWith("高配")) return 2
  if (value.startsWith("待定")) return 3
  return 4
}

/**
 * 完成类型：0 本人，1 主播，2 本月临时名，3 未知；未完成行不参与（4）。
 *
 * 多值完成情况按最高优先级归类：本人 > 主播 > 临时名 > 未知。
 * 本人昵称可能含逗号：先按完整值比对，再按逗号拆成 token 比对。
 */
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

/** 四张表共用：分组 → 难度 → 目标 → 强度 → 完成类型 → 原始行号 */
export function compareReorderRows(sheet, a, b, { anchors = [], tempNames = [] } = {}) {
  const group = groupRankOf(a?.status) - groupRankOf(b?.status)
  if (group) return group

  const ga = goalRankOf(sheet, a?.goal)
  const gb = goalRankOf(sheet, b?.goal)
  if (ga.difficulty !== gb.difficulty) return ga.difficulty - gb.difficulty
  if (ga.target !== gb.target) return ga.target - gb.target

  const strength = strengthRankOf(a?.strength) - strengthRankOf(b?.strength)
  if (strength) return strength

  const completion =
    completionRankOf(a, { anchors, tempNames }) - completionRankOf(b, { anchors, tempNames })
  if (completion) return completion

  return Number(a?.row) - Number(b?.row)
}

/**
 * 每日整理的纯排序计划。
 *
 * 只排有群昵称的行；空行作为固定格子，不参与也不移动。
 * `slots` 是固定行号（升序），`order` 是这些格子应当放入的行内容。
 * 顺序没变返回 null，调用方据此一个字都不写。
 */
export function tidyOrder(model, { tempNames = [] } = {}) {
  const records = (model?.rows ?? [])
    .filter(row => clean(row?.nickname))
    .sort((a, b) => Number(a.row) - Number(b.row))
  if (records.length < 2) return null

  const anchors = (model?.anchors ?? []).map(anchor => (typeof anchor === "string" ? anchor : anchor?.name))
  const slots = records.map(row => Number(row.row))
  const out = records
    .slice()
    .sort((a, b) => compareReorderRows(model.name, a, b, { anchors, tempNames }))
  const order = out.map(row => Number(row.row))
  if (order.every((row, index) => row === slots[index])) return null

  return {
    slots,
    order,
    groups: new Set(records.map(row => groupRankOf(row.status))).size,
  }
}

/** 攻炼排序用到的模式表（测试/排障可读） */
export const ATTACK_MODE_ORDER = ATTACK_MODES
