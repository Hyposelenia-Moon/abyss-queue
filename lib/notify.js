/**
 * 唯一的定时任务：一条 tick 里按**内部时间判断**做四件事
 *
 * 以前是四条按频率注册的 cron（队列推送 / 完成轮询 / 月末催办 / 名单同步），
 * 各自的周期与去重标记都不一样，排查"到底哪条跑没跑"要先认四份配置。
 * 现在只注册一条 `notify.cron`（默认每 3 分钟），四件事都在这一个函数里按需触发：
 *
 *   1. **完成情况轮询**：状态「未完成 → 已完成」时 @ 该榜下一个还在排队的人（每轮都查）
 *   2. **榜开启提醒**：某个榜从「未开启」翻到「已开启」时 @ 该榜所有排队中的人（每榜每次开启一次）
 *   3. **月末催办**：每月最后一天、到 `notify.monthly_at` 之后，当天只发一次
 *   4. **群成员名单同步**：每天到 `roster.at` 之后，当天只发一次（另有启动后 20 秒的那一次 kick）
 *
 * 去重状态全放在**同一个状态文件**（`data/progress.json`，落点固定、不可配置）里：
 *
 *   rows   进度快照，用于识别「刚刚完成」（沿用原来的口径，一行一个键）
 *   open   { 榜名: 上一次观察到的「已开启」 } —— 只有 false→true 才提醒
 *   daily  { monthly: 日期, roster: 日期 } —— 当天已做过的标记，按**本地日期**
 *
 * 为什么四件事的标记合成一个文件：它们都是"同一次 tick 的一次状态转换"，分开放就会出现
 * "提醒发出去了、开启标记没落盘"的窗口（重启一次就会重复 @ 整榜的人）。一次性算好、写一次，
 * 是这个模块唯一的状态写入点。
 *
 * 时机语义统一是"到点之后一整天都算数"（见 `atOrAfter`）：机器人半夜关着、早上才起来时，
 * 当天的名单同步与月末催办仍会补做一次；重复 tick 由当天的标记挡住。
 */
import {
  atOrAfter,
  defaultStatusOf,
  detectCompletions,
  isLastDayOfMonth,
  localDayKey,
  QUEUED,
  snapshot,
  statusOf,
} from "./progress.js"

/** 注册到框架的那条任务的显示名（测试也按它断言，两边共用一个常量） */
export const TICK_NAME = "队列定时检查"

/**
 * 一个榜"开没开"
 *
 * 判定取**两者之或**（用户口径）：
 *   - 日历口径：`defaultStatusOf`——剧诗每月 1 号 4 点开、螺旋 16 号 4 点开、
 *     危战没有固定日子（默认「等待开启」）
 *   - 表内容口径：榜里已经有行写着「排队中」——危战这种靠手改的榜只能这样认开没开
 *
 * 为什么是"或"：日历到点了但还没人报名，也算开了（该提醒"榜开了，还有 0 人"没意义，
 * 所以那种情况不会 @ 到人）；反过来，日历还没到点但表里已经有人排队（手动提前开了），
 * 更应该提醒。
 *
 * @param {object} model 榜模型
 * @param {Date} now 判定时刻
 */
export const sheetOpenOf = (model, now = new Date()) =>
  defaultStatusOf(model.name, now) === QUEUED || (model.rows ?? []).some(r => statusOf(r.status) === "queued")

/**
 * 某个榜"排队中"的人（开榜提醒要 @ 的正是他们，按行号排序）
 *
 * 已完成的人不再 @、整榜还写着「等待开启」的人也不 @——那两类人轮到不轮到与"榜开没开"无关。
 */
export const queuedInSheet = model =>
  (model.rows ?? [])
    .filter(r => statusOf(r.status) === "queued")
    .sort((a, b) => a.row - b.row)
    .map(r => ({ row: r.row, seq: String(r.seq ?? "").trim() || String(r.row), nickname: String(r.nickname ?? "").trim() }))
    .filter(r => r.nickname)

/**
 * 算下一份状态 + 这一轮该做哪些通知（**纯函数**，不碰文件、不发消息）
 *
 * 状态与"要做什么"必须一起算出来：只有这样才能在发消息之前一次写盘，
 * 让"标记"与"已通知"永远同步（见文件头）。
 *
 * @param {object} opts
 * @param {object} [opts.prev] 上一次的状态（整个状态文件的解析结果；损坏时传 null）
 * @param {Array<object>} opts.models 当前各榜模型
 * @param {Date} opts.now 当前时刻
 * @param {object} opts.cfg 判定用到的配置（notify.monthly_at / roster.at / monthly_enable）
 * @returns {{state: object, ready: boolean, openNow: string[], completions: Array<{sheet,row,seq,nickname}>, monthly: object|null, roster: boolean}}
 *          state 是要落盘的新状态；openNow = 这一轮刚开启的榜；completions = 这一轮刚完成的人；
 *          monthly 是要发的内容（null = 不发）；roster = "这次要不要真正推名单"
 *          （推不推得成由调用方定，推成功后再让调用方把标记写进去）
 */
export function tickTasks({ prev, models, now, cfg = {} }) {
  const done = prev?.rows && typeof prev.rows === "object" ? prev.rows : {}
  const beforeOpen = prev?.open && typeof prev.open === "object" ? prev.open : {}
  const beforeDaily = prev?.daily && typeof prev.daily === "object" ? prev.daily : {}
  /**
   * 首次运行（没有任何状态文件）：**只记基线**，一件事都不做。
   *
   * 这条对开榜提醒尤其重要：刚部署时库里所有榜都是"已开启"，若把它们当成
   * false→true 就会在群里 @ 上百个人。
   */
  const first = !prev

  const next = snapshot(models)
  const open = {}
  const openNow = []
  for (const model of models) {
    const isOpen = sheetOpenOf(model, now)
    open[model.name] = isOpen
    /** 只有"上一次明确记着未开启"才算一次开启；没见过（首轮/新榜）不算 */
    if (isOpen && beforeOpen[model.name] === false) openNow.push(model.name)
  }

  const day = localDayKey(now)
  const daily = { ...beforeDaily }
  const monthly = monthlyTask({ models, now, cfg, daily, day })
  /** 名单同步到点就做；做没做成由调用方在成功后写标记（推失败下次 tick 还能补） */
  const roster = atOrAfter(now, cfg.rosterAt || "05:00")

  return {
    state: { rows: next, open, daily, at: now.getTime() },
    ready: !first,
    openNow,
    completions: first ? [] : detectCompletions(done, next),
    monthly,
    roster,
  }
}

/**
 * 月末催办：是不是"今天该催、而且今天还没催过"
 *
 * 返回要发的内容（而不是直接发）是为了让调用方在**落盘之后**再发——发送失败也不重复发。
 * 还排队的人一个都没有时返回 null：没必要为"没人排队"发一条空催办，也不该白占掉当天的标记。
 */
function monthlyTask({ models, now, cfg, daily, day }) {
  if (cfg.monthlyEnable === false) return null
  if (!isLastDayOfMonth(now)) return null
  if (!atOrAfter(now, cfg.monthlyAt || "12:00")) return null
  if (daily.monthly === day) return null

  const sheets = pendingSheets(models)
  if (!sheets.length) return null
  daily.monthly = day
  return { sheets, day }
}

/** 各榜还在排队的人（按榜分组，空榜不返回），给月末催办 @ 人用 */
function pendingSheets(models) {
  const out = []
  for (const model of models) {
    const rows = queuedInSheet(model)
    if (rows.length) out.push({ sheet: model.name, rows })
  }
  return out
}

/* --------------------------- 状态文件的读写 --------------------------- */

/**
 * 读整个状态文件
 *
 * `readJson` 是调用方给的同步读取实现（apps/queue.js 传它自己的 `readJson`）——
 * 放在参数里而不是 import：这样这一层完全不知道文件系统，套件也能直接喂一份对象进来。
 *
 * 读不出来（首次运行没有这个文件、内容损坏、写了一半）一律返回 null = **当作首次运行**：
 * 首轮只记基线不发消息，所以损坏的状态文件最坏结果是"这一轮该发的提醒没发"，
 * 而不会把整榜的人重新 @ 一遍。
 */
export function readState(readJson) {
  const raw = readJson()
  return raw && typeof raw === "object" ? raw : null
}
