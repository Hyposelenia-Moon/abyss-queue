/**
 * 排队进度的判定与变化检测（纯函数，可独立测试）
 *
 * 「帮帮完成情况」这一列里出现的东西分三类：
 *   等待开启  —— 这个榜还没开（深境螺旋没开时整榜都是它），既不算排队也不算完成
 *   排队中    —— 还在等主播（还没轮到他）
 *   其它任何值 —— 主播名、本人已完成……都表示这一位已经处理过了
 * 项目的三个功能都建立在这个约定上：月度催办只找「排队中」的人，
 * 上一位完成后要 @ 的下一位也是「排队中」的人。
 */
import { phaseOf as cyclePhaseOf } from "../components/cycle.js"

const clean = s => String(s ?? "").trim()

/** 整榜还没开 */
export const WAITING = "等待开启"
/** 还在排队 */
export const QUEUED = "排队中"/** 填表的人给自己选的「我完成了」：编辑器会把它落成该行的群昵称，表里也可能直接手选到这个字面值 */
export const SELF_DONE = "本人已完成"

/**
 * 「帮帮完成情况」显示成什么
 *
 * 「本人已完成」看不出是谁完成的，所以显示时按这一行自己的群昵称显示
 * （编辑器落表时也会写成昵称；这里兜的是表里还留着字面值的老数据）。
 * 多选（"阿修Axiu,本人已完成"）逐个值都换。
 */
export const statusLabel = (status, nickname) => {
  const parts = clean(status)
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
  if (!parts.includes(SELF_DONE)) return parts.join(",")
  const nick = clean(nickname)
  if (!nick) return parts.join(",")
  return [...new Set(parts.map(p => (p === SELF_DONE ? nick : p)))].join(",")
}

/** 这一位是否已经处理过（非空、且不是「等待开启」「排队中」） */
export const isDone = status => {
  const s = clean(status)
  return Boolean(s) && s !== WAITING && s !== QUEUED
}

/** 这一位是否还在排队（含状态为空的老数据） */
export const isPending = status => !isDone(status) && clean(status) !== WAITING

/**
 * 展示层只留两档：`未完成` / `已完成`。
 * 表里的原始状态、编辑器里的选择、通知判定都不变，只影响菜单/队列图上的文字。
 */
export const completionState = status => {
  const s = clean(status)
  if (!s || s === WAITING || s === QUEUED || /^(未开始|进行中|待开始)$/.test(s)) return "未完成"
  return "已完成"
}

/** 这一行是否在排队 */
const rowPending = row => isPending(row?.status)
const rowDone = row => isDone(row?.status)

/**
 * 「帮帮完成情况」这一格的精确分类
 *
 * 与 isPending / isDone 的区别：那两位把空状态算作「排队中」（老数据里的空格子确实是在排队），
 * 这里的 null 专门表示"这一格没写值，说不好"。榜开启判定要用它把「整榜空着」与
 * 「整榜写着等待开启」分开——前者不该被当成"已经有人排队"而触发开榜提醒。
 * @returns {"waiting"|"queued"|"done"|null}
 */
export const statusOf = status => {
  const s = clean(status)
  if (!s) return null
  if (s === WAITING) return "waiting"
  if (s === QUEUED) return "queued"
  return "done"
}

/** 行标识：状态变化检测与去重都用它 */
export const rowKey = (sheet, row) => `${sheet}#${row}`

/* ------------------------- 开榜口径（与编辑器同一套） ------------------------- */

/**
 * 各榜的开榜时间
 *
 *   幻想真境剧诗：每月 1 号 4 点开，**不设「等待开启」**，默认就是「排队中」
 *   深境螺旋：每月 16 号 4 点开，到点前默认「等待开启」，到点后默认「排队中」
 *   幽境危战：42 天周期内，清榜后到下一版开始前为「等待开启」，开放期为「排队中」
 *
 * **这份表与 `editor/editor.mjs` 的 defaultStatusOf 必须一致**：编辑器拿它算新行的默认值，
 * 插件拿它判「这个榜开没开」（开榜提醒）。两处口径分叉的后果是"编辑器说开了、提醒没发"。
 */
/**
 * 某个榜"按日历"该是什么状态（编辑器给新行下发的默认值口径）
 *
 * @param {string} sheetName 榜名（按关键字识别，不认具体写法）
 * @param {Date} [now] 判定时刻
 * @returns {"等待开启"|"排队中"}
 */
export const defaultStatusOf = (sheetName, now = new Date()) => {
  const name = String(sheetName ?? "")
  /** 绝境攻炼：榜单长期开放；单行状态由所选模式决定，不再用整榜等待挡开榜 */
  if (/攻炼|绝境/.test(name)) return QUEUED
  return cyclePhaseOf(name, now) === "queued" ? QUEUED : WAITING
}

/* ------------------------- 时间判断（唯一 tick 用） ------------------------- */

/**
 * "HH:MM" → 当天的第几分钟
 *
 * 解析不出来时给 fallback（配置写错不该让定时任务整个不跑），并**不**在这里记日志：
 * 这个函数是纯函数，调用方（modules/notify.js）负责把回落说出来。
 * @returns {number} 0..1439；`fallback` 也解析不出来时返回它（默认 0）
 */
export const minuteOfDay = (hhmm, fallback = 0) => {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(hhmm ?? ""))
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return h * 60 + min
}

/**
 * 今天到点了没有（现在是 >= 设定的那个时刻）
 *
 * 用"到点之后一整天都算数"的语义而不是"只在那一分钟算数"：机器人半夜关着、
 * 早上 9 点才起来时，05:00 的名单同步当天仍然要补做一次；重复 tick 由当天的去重标记挡。
 */
export const atOrAfter = (date, hhmm) => date.getHours() * 60 + date.getMinutes() >= minuteOfDay(hhmm)

/** 本地日期的 `YYYY-MM-DD`：当天去重标记的键（用本地时区，与"每天几点"这个口径一致） */
export const localDayKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

/**
 * 取一张表的进度快照
 * @returns {Object<string, {sheet, row, seq, nickname, status, done}>}
 */
export function snapshot(models) {
  const state = {}
  for (const model of models) {
    for (const r of model.rows ?? []) {
      if (!clean(r.nickname)) continue
      state[rowKey(model.name, r.row)] = {
        sheet: model.name,
        row: r.row,
        seq: clean(r.seq) || String(r.row),
        nickname: clean(r.nickname),
        status: clean(r.status),
        done: rowDone(r),
      }
    }
  }
  return state
}

/**
 * 各榜的**结构指纹**：按行序排的「行号:群昵称」
 *
 * 只干一件事：把"行位移"和"状态变化"分开。`snapshot()` 是按 `榜#行号` 存的，而下面这些动作会让
 * **同一个人换个行号**：新增主播插一行（成员行整体下移）、每日整理（已完成的往前挪）、`#插队`
 * （交换两行内容）、删行压紧、整表替换。行号一换，同一个键上的"上一个人"与"这个人"就对不上，
 * `detectCompletions` 于是把**早就在那儿完成过的人**再报一次"刚刚完成"（2026-10-18 审核 P2：
 * 主播插行之后群里会莫名其妙冒一条"某某已完成 → 下一位…"）。
 *
 * **行号也是结构的一部分**（2026-10-23 复审 P2）：新增主播是在**表头上方**插一行——成员整体下移
 * 一格，昵称序列一个都不差（`[甲,乙,丙]` 还是 `[甲,乙,丙]`），只比昵称就看不出位移，旧行号上的
 * "人"照样被换掉。把 `行号:昵称` 一起比，"只挪位置、不换人"的位移才会算结构变了。
 *
 * 所以 `tickTasks` 每次先比这份指纹：**结构变了就这一轮不判完成**，只把新基线记下来。
 * 代价是"结构变化与真完成撞在同一轮"时那条通知会丢——宁可少发一条，也不能乱 @ 人。
 * 指纹格式换了（老状态文件里只有昵称）同样按"结构变了"处理：升级后首跑只记基线。
 */
export function snapshotShape(models) {
  const shape = {}
  for (const model of models) {
    shape[model.name] = (model.rows ?? [])
      .filter(r => clean(r.nickname))
      .map(r => `${r.row}:${clean(r.nickname)}`)
  }
  return shape
}

/** 两份结构指纹是不是同一份（**行号与行序都算**：插行、只换顺序同样是位移，仍会错位） */
export const sameShape = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * 对比前后两份快照，找出「刚刚完成」的行
 *
 * 只认「上一次还没完成 → 这一次完成了」的转变：
 *   - 快照里原本没有的行（新加的、且一加上就是已完成）不通知
 *   - 状态一直没变的不通知
 * @returns {Array<{sheet, row, seq, nickname, status}>}
 */
export function detectCompletions(prev = {}, next = {}) {
  const out = []
  for (const [key, now] of Object.entries(next)) {
    const before = prev[key]
    if (!before) continue
    if (before.done || !now.done) continue
    if (before.status === now.status) continue
    out.push({ sheet: now.sheet, row: now.row, seq: now.seq, nickname: now.nickname, status: now.status })
  }
  return out.sort((a, b) => a.sheet.localeCompare(b.sheet, "zh") || a.row - b.row)
}

/**
 * 对比前后两份快照，找出「**被改回排队中**」的行（完成的 → 又变回排队）
 *
 * 维护者口径（2026-10-18）："若已完成状态（包含本人或主播完成）变为排队中，则补充播报：
 * xxx完成情况由已完成变为排队中，请主播@xxx注意"。
 * 与 `detectCompletions` 正好相反，同样**只认真的变过**、快照里原本没有的行不报；
 * 只认落到 `排队中`（`等待开启` 不算——那不是"重新排队找他打"）。
 * @returns {Array<{sheet, row, seq, nickname, status}>}
 */
export function detectReverts(prev = {}, next = {}) {
  const out = []
  for (const [key, now] of Object.entries(next)) {
    const before = prev[key]
    if (!before) continue
    if (!before.done || now.done) continue
    if (before.status === now.status) continue
    /** 只认「排队中」：改回「等待开启」是"榜还没开"，不该催主播 */
    if (statusOf(now.status) !== "queued") continue
    out.push({ sheet: now.sheet, row: now.row, seq: now.seq, nickname: now.nickname, status: now.status })
  }
  return out.sort((a, b) => a.sheet.localeCompare(b.sheet, "zh") || a.row - b.row)
}

/**
 * 同一张表里、这一行之后下一个还在排队的人
 * @param {object} model 榜模型
 * @param {number} row 已完成的那个人的行号
 * @returns {object|null} `model.rows` 里的那一行
 */
export function nextPending(model, row) {
  const rows = (model.rows ?? []).filter(r => clean(r.nickname)).sort((a, b) => a.row - b.row)
  const i = rows.findIndex(r => r.row === row)
  if (i < 0) return null
  for (let j = i + 1; j < rows.length; j++) if (rowPending(rows[j])) return rows[j]
  return null
}

/**
 * 各榜还在排队的人（月度催办用）
 * @returns {Array<{sheet, name, rows: Array<{row, seq, nickname}>}>} 没有人在排的榜不返回
 */
export function pendingBySheet(models) {
  const out = []
  for (const model of models) {
    const rows = (model.rows ?? [])
      .filter(r => clean(r.nickname) && rowPending(r))
      .sort((a, b) => a.row - b.row)
      .map(r => ({ row: r.row, seq: clean(r.seq) || String(r.row), nickname: clean(r.nickname) }))
    if (rows.length) out.push({ sheet: model.name, name: model.name, rows })
  }
  return out
}

/**
 * 当月最后一天（本地时区）
 *
 * 传进来的时刻解析不出来时返回 false（宁可"今天不催办"，也不要因为一个坏日期炸掉定时任务）。
 */
export function isLastDayOfMonth(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return false
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return next.getDate() === 1
}
