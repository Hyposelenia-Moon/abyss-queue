/**
 * 绝境攻炼：模式 / 目标 / 版更的固定口径
 *
 * 数据仍落在 A–H 八列里：E 列「模式及目标」存一个组合值，
 * 形如 `焰羽追绞、囚笼冰城｜满星`。模式多选、目标单选；
 * 超过 2 个模式时显示按版本简写为 `7.0模式` / `7.1模式` / `7.0/7.1模式`。
 *
 * 版更：2026-11-04 10:00 第 1 期，之后每 42 天一期。
 */

export const ATTACK_SHEET = "绝境攻炼"

export const ATTACK_MODES = ["焰羽追绞", "囚笼冰城", "线列破袭", "至寒风暴", "狭域死战"]

/** 模式所属版本：前三个 7.0，后两个 7.1 */
export const ATTACK_MODE_VERSIONS = {
  焰羽追绞: "7.0",
  囚笼冰城: "7.0",
  线列破袭: "7.0",
  至寒风暴: "7.1",
  狭域死战: "7.1",
}

/** 目标：不设难度，只三选一 */
export const ATTACK_TARGETS = [
  { name: "满原石", color: "green" },
  { name: "满星", color: "red" },
  { name: "顶分", color: "dark" },
]

export const ATTACK_TARGET_NAMES = ATTACK_TARGETS.map(t => t.name)

export const ATTACK_STRENGTHS = ["高配｜满配满体", "中配｜半配半体", "低配｜裸配无体"]

const DAY_MS = 24 * 60 * 60 * 1000

/** 第 1 期开始：2026-11-04 10:00（本地时区） */
export const ATTACK_VERSION_START = new Date(2026, 10, 4, 10, 0, 0, 0)
export const ATTACK_VERSION_INTERVAL_DAYS = 42
export const ATTACK_VERSION_INTERVAL_MS = ATTACK_VERSION_INTERVAL_DAYS * DAY_MS
/** 版更播报正文（@全体成员 由发送侧拼） */
export const ATTACK_VERSION_MESSAGE = "【绝境攻炼】新模式已开启，如需帮帮可前往排队。"

const clean = value => String(value ?? "").trim()

/** 某个时刻属于第几期；第 1 期之前返回 0 */
export function attackVersionIndex(now = new Date()) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(at) || at < ATTACK_VERSION_START.getTime()) return 0
  return Math.floor((at - ATTACK_VERSION_START.getTime()) / ATTACK_VERSION_INTERVAL_MS) + 1
}

/** 第 index 期（从 1 开始）的开始时刻 */
export function attackVersionStart(index) {
  const n = Number(index)
  if (!Number.isFinite(n) || n < 1) return null
  return new Date(ATTACK_VERSION_START.getTime() + (n - 1) * ATTACK_VERSION_INTERVAL_MS)
}

/** 绝境攻炼是否已经开榜（第 1 期开始后一直开） */
export const attackIsOpen = (now = new Date()) =>
  new Date(now).getTime() >= ATTACK_VERSION_START.getTime()

const localDay = date => {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 版更播报：只在版更当天 10:00 之后触发一次，且同一期不重复。
 *
 * `prev` 是进度状态文件（首跑没有状态文件时返回 null，避免刚部署就 @全体）。
 * @param {object|null} prev
 * @param {Date} [now]
 * @returns {{index:number, at:Date}|null}
 */
export function attackVersionNotice(prev, now = new Date()) {
  if (!prev) return null
  const index = attackVersionIndex(now)
  if (!index) return null
  const last = Number(prev?.attackVersion?.index ?? prev?.attackVersion ?? 0)
  if (last >= index) return null
  const start = attackVersionStart(index)
  if (!start) return null
  const at = now instanceof Date ? now : new Date(now)
  if (at.getTime() < start.getTime()) return null
  /** 只认版更当天；停机跨过一整天不补发，避免上线时突然 @全体 */
  if (localDay(at) !== localDay(start)) return null
  return { index, at: start }
}

/** 由模式数组 + 目标拼成表里的规范值 */
export function attackGoalValue(modes, target) {
  const list = [...new Set((Array.isArray(modes) ? modes : String(modes ?? "").split(/[、,，]/))
    .map(clean)
    .filter(m => ATTACK_MODES.includes(m)))]
  const t = clean(target)
  if (!list.length || !ATTACK_TARGET_NAMES.includes(t)) return ""
  return `${list.join("、")}｜${t}`
}

/**
 * 解析 E 列组合值；格式不对、模式/目标认不出时返回 null。
 * @returns {{modes:string[], target:string}|null}
 */
export function parseAttackGoal(value) {
  const raw = clean(value)
  const at = raw.indexOf("｜")
  if (at <= 0) return null
  const left = raw.slice(0, at)
  const target = raw.slice(at + 1).trim()
  const modes = [...new Set(left.split(/[、,，]/).map(clean).filter(Boolean))]
  if (!modes.length || !ATTACK_TARGET_NAMES.includes(target)) return null
  if (modes.some(m => !ATTACK_MODES.includes(m))) return null
  return { modes, target }
}

/**
 * 模式显示：某个版本的模式**全部选中**时才用版本简写（7.0模式 / 7.1模式 / 7.0/7.1模式）；
 * 否则仍逐个列名字。例：只选 7.0 的三个 → `7.0模式`；选 7.0 全部 + 至寒风暴 → `7.0模式、至寒风暴`。
 */
export function attackModeShort(modes) {
  const list = (Array.isArray(modes) ? modes : []).map(clean).filter(m => ATTACK_MODES.includes(m))
  const picked = new Set(list)
  const groups = ["7.0", "7.1"]
  const complete = groups.filter(v => {
    const members = ATTACK_MODES.filter(m => ATTACK_MODE_VERSIONS[m] === v)
    return members.length > 0 && members.every(m => picked.has(m))
  })
  if (complete.length === groups.length) return "7.0/7.1模式"
  const rest = list.filter(m => !complete.includes(ATTACK_MODE_VERSIONS[m]))
  if (complete.length) return [...complete.map(v => `${v}模式`), ...rest].join("、")
  return list.join("、")
}

/**
 * 表格/菜单显示用：模式短名 + 目标 + 目标颜色。
 * @returns {{prefix:string,target:string,color:string,full:string}|null}
 */
export function attackGoalView(value) {
  const parsed = parseAttackGoal(value)
  if (!parsed) return null
  const target = ATTACK_TARGETS.find(t => t.name === parsed.target)
  return {
    prefix: attackModeShort(parsed.modes),
    target: parsed.target,
    color: target?.color ?? "",
    full: parsed.modes.join("、"),
  }
}

/** 目标对应的颜色；旧三榜的目标段也复用这一档 */
export function attackTargetColor(target) {
  return ATTACK_TARGETS.find(t => t.name === clean(target))?.color ?? ""
}

/** 旧三榜前缀的颜色（难度/层数） */
export function goalPrefixTone(prefix) {
  if (/困难模式|第11层|险恶/.test(prefix)) return "green"
  if (/卓越模式|无畏/.test(prefix)) return "orange"
  if (/月谕模式|第12层|绝境/.test(prefix)) return "red"
  return "neutral"
}

const OLD_TARGET_RE = /(满原石|满星章|满星|顶分|180s)$/

/**
 * 显示层拆「难度/模式前缀 + 目标段」；表里的原值不变。
 * 攻击组合值走 attackGoalView，前缀按版本简写；旧三榜按后缀拆。
 */
export function goalParts(value) {
  const atk = attackGoalView(value)
  if (atk) return { ...atk, prefixTone: "neutral" }
  const v = clean(value)
  const m = OLD_TARGET_RE.exec(v)
  if (!m) return { prefix: v, target: "", prefixTone: goalPrefixTone(v), color: goalPrefixTone(v) }
  const prefix = v.slice(0, -m[1].length)
  return {
    prefix,
    target: m[1],
    prefixTone: goalPrefixTone(prefix),
    color: m[1] === "180s" ? "dark" : goalPrefixTone(prefix),
  }
}

/** 兼容旧调用：E 列组合值按目标上色 */
export function attackGoalColor(value) {
  const view = attackGoalView(value)
  return view?.color ?? ""
}
