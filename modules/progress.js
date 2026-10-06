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
const clean = s => String(s ?? "").trim()

/** 整榜还没开 */
export const WAITING = "等待开启"
/** 还在排队 */
export const QUEUED = "排队中"
/** 填表的人给自己选的「我完成了」：编辑器会把它落成该行的群昵称，表里也可能直接手选到这个字面值 */
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
 *   幽境危战：按版本开放、没有固定日子，默认「等待开启」，要排队请手动改成「排队中」
 *
 * **这份表与 `editor/editor.mjs` 的同名表必须一致**：编辑器拿它算新行的默认值，
 * 插件拿它判「这个榜开没开」（开榜提醒）。两处口径分叉的后果是"编辑器说开了、提醒没发"，
 * 所以 `test/notify.test.mjs` 对着日子把两边都钉了一遍。
 */
const OPEN_RULES = [
  { test: /剧诗/, day: 1 },
  { test: /螺旋/, day: 16 },
]

/**
 * 某个榜"按日历"该是什么状态（编辑器给新行下发的默认值口径）
 *
 * @param {string} sheetName 榜名（按关键字识别，不认具体写法）
 * @param {Date} [now] 判定时刻
 * @returns {"等待开启"|"排队中"}
 */
export const defaultStatusOf = (sheetName, now = new Date()) => {
  const rule = OPEN_RULES.find(r => r.test.test(String(sheetName ?? "")))
  if (!rule) return WAITING
  /** 1 号开的榜不用「等待开启」 */
  if (rule.day <= 1) return QUEUED
  const openAt = new Date(now.getFullYear(), now.getMonth(), rule.day, 4, 0, 0, 0)
  return now.getTime() >= openAt.getTime() ? QUEUED : WAITING
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
