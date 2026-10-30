/**
 * 清榜前完成核查（清榜时间前 1 小时内）
 *
 * 路线 A：不 OCR，直接调用米游社原始查询接口取当前周期的成绩。
 * 对每个排队中的人先发一条 `@他 #剧诗/#危战/#深渊`（保留群内可见的查询动作），
 * 再用该 QQ 绑定的 UID/Cookie 直接查原始数据判定：
 *   - 剧诗：困难 8/8、卓越 10/10、月谕 12/12
 *   - 危战：单人 N6 且总用时 ≤180 秒
 *   - 深渊：12 层 9/9（或等价的 36/36）
 *
 * 未绑定 UID、未绑定 Cookie、数据未公开、查询报错等，一律自动忽略该用户，
 * 不写状态、不阻断其他人。枪战不参与。
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { config } from "../components/config.js"
import { SHEET_ABYSS, SHEET_DRAMA, SHEET_STYGIAN, fmt, precheckEvents } from "../components/cycle.js"
import { log } from "../components/logger.js"
import {
  at,
  memberDirectory,
  notifyGroups,
  qqOfAnchor,
} from "../components/notify-send.js"
import { queuedInSheet } from "./notify.js"
import { readJson, statePath, writeJson } from "../model/queue-state.js"
import { markChecked, tableVersion } from "../model/check-write.js"

const CYCLE_STATE = () => path.join(path.dirname(statePath()), "cycle.json")
const CHECK_STATE = () => path.join(path.dirname(statePath()), "cycle-check.json")

const CHECK_TYPES = {
  [SHEET_DRAMA]: { type: 1, command: "剧诗", short: "剧诗" },
  [SHEET_STYGIAN]: { type: 2, command: "危战", short: "危战" },
  [SHEET_ABYSS]: { type: 0, command: "深渊", short: "深渊" },
}

/** 剧诗各难度：满星章数 / 通关全部幕数（满原石） */
const DRAMA_MODES = {
  简单: { id: 1, star: 3, acts: 3 },
  普通: { id: 2, star: 6, acts: 6 },
  困难: { id: 3, star: 8, acts: 8 },
  卓越: { id: 4, star: 10, acts: 10 },
  月谕: { id: 5, star: 12, acts: 10 },
}
const STYGIAN_NAMES = { 险恶: 4, 无畏: 5, 绝境: 6 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const DRAMA_LABELS = Object.fromEntries(Object.entries(DRAMA_MODES).map(([name, m]) => [m.id, name]))
const STYGIAN_LABELS = { 4: "险恶(N4)", 5: "无畏(N5)", 6: "绝境(N6)" }

/**
 * 按这一行实际选的「难度及目标」评估。
 * 返回 `{ status: "achieved"|"partial"|"unknown", detail }`：
 *   - achieved：完整达成，才允许写状态；
 *   - partial：有数据但没达到目标，仅播报，不写状态；
 *   - unknown：目标格式不认识，仅播报“无法判定”，不写状态。
 */
export function evaluateGoal(sheet, goal, extra = {}) {
  const text = String(goal ?? "").replace(/\s+/g, "")

  if (sheet === SHEET_DRAMA) {
    const modeName = Object.keys(DRAMA_MODES).find(name => text.includes(name))
    const mode = modeName ? DRAMA_MODES[modeName] : null
    if (!mode || !text.includes(`${modeName}模式`)) {
      return { status: "unknown", detail: `无法识别目标「${goal || "空"}」` }
    }
    const actualMode = Number(extra.mode_id)
    if (actualMode < mode.id) {
      return {
        status: "partial",
        detail: `目标 ${modeName}模式，当前 ${DRAMA_LABELS[actualMode] ?? "无数据"}模式`,
      }
    }
    if (text.includes("满原石")) {
      const acts = Number(extra.round_count)
      if (acts < mode.acts) return { status: "partial", detail: `${modeName}模式通关 ${acts}/${mode.acts} 幕` }
      return { status: "achieved", detail: "" }
    }
    if (text.includes("满星章")) {
      const stars = Number(extra.star_medal)
      if (stars < mode.star) return { status: "partial", detail: `${modeName}模式星章 ${stars}/${mode.star}` }
      return { status: "achieved", detail: "" }
    }
    return { status: "unknown", detail: `无法识别目标「${goal || "空"}」` }
  }

  if (sheet === SHEET_STYGIAN) {
    const byName = Object.entries(STYGIAN_NAMES).find(([name]) => text.includes(name))
    const nMatch = /N\s*(\d+)/i.exec(text)
    const need = nMatch ? Number(nMatch[1]) : byName?.[1]
    if (!need) return { status: "unknown", detail: `无法识别目标「${goal || "空"}」` }
    const difficulty = Number(extra.difficulty)
    const time = Number(extra.time_second)
    if (difficulty < need) {
      return {
        status: "partial",
        detail: `目标 ${STYGIAN_LABELS[need] ?? `N${need}`}，当前 ${STYGIAN_LABELS[difficulty] ?? `N${difficulty}`}`,
      }
    }
    if (/180(?:s|秒)/i.test(text) && time > 180) {
      return {
        status: "partial",
        detail: `难度 N${difficulty} 已达成，当前总用时 ${time} 秒，超过 180 秒`,
      }
    }
    return { status: "achieved", detail: "" }
  }

  if (sheet === SHEET_ABYSS) {
    const floorMatch = /第(\d+)层满星/.exec(text)
    if (!floorMatch) return { status: "unknown", detail: `无法识别目标「${goal || "空"}」` }
    const need = Number(floorMatch[1])
    const floor = Number.parseInt(String(extra.max_floor ?? "").split("-")[0], 10)
    const star = Number(extra.max_floor_star)
    const total = Number(extra.total_star)
    const targetStar = extra.floor_stars?.[need]
    if (targetStar !== undefined ? targetStar >= 9 : total >= 36 || (floor === need && star >= 9))
      return { status: "achieved", detail: "" }
    return {
      status: "partial",
      detail: targetStar !== undefined
        ? `目标 第${need}层满星，当前第${need}层 ${targetStar}/9 星`
        : `目标 第${need}层满星，当前 ${floor ? `第${floor}层` : "无数据"} ${total}星`,
    }
  }

  return { status: "unknown", detail: `无法识别目标「${goal || "空"}」` }
}

/** 兼容旧调用：只回答是否完整达成（partial/unknown 一律 false） */
export function judgeForGoal(sheet, goal, extra = {}) {
  return evaluateGoal(sheet, goal, extra).status === "achieved"
}

/** 原始接口字段 → judgeForGoal 需要的字段 */
export function extraOf(type, data = {}) {
  if (type === 1) {
    const stat = data?.stat || {}
    const detail = data?.detail || {}
    return {
      mode_id: Number(stat.difficulty_id) || 0,
      star_medal: (stat.get_medal_round_list || []).filter(v => v === 1).length,
      round_count: (detail.rounds_data || []).length,
    }
  }
  if (type === 2) {
    const md = data?.single || {}
    const best = md.best || md
    return {
      difficulty: Number(best.difficulty) || 0,
      time_second: Number(best.second) || 0,
    }
  }
  if (type === 0) {
    const floors = data?.floors || []
    let maxFloor = 0
    let maxStar = 0
    const floorStars = {}
    for (const floor of floors) {
      const idx = Number.parseInt(floor?.index, 10) || 0
      const star = Number(floor?.star) || 0
      floorStars[idx] = star
      if (idx > maxFloor) {
        maxFloor = idx
        maxStar = star
      }
    }
    return {
      max_floor: String(data?.max_floor ?? maxFloor),
      max_floor_star: maxStar,
      floor_stars: floorStars,
      total_star: Number(data?.total_star) || 0,
    }
  }
  return {}
}

/** 动态取 genshin 的绑定与 API 模块；插件不在 Yunzai 插件目录时返回 null */
let genshinModules = null
async function loadGenshin() {
  if (genshinModules) return genshinModules
  const dirs = [
    path.join(process.cwd(), "plugins", "genshin", "model", "mys"),
    path.resolve(import.meta.dirname, "..", "..", "genshin", "model", "mys"),
  ]
  for (const dir of dirs) {
    try {
      const load = name => import(pathToFileURL(path.join(dir, name)).href)
      const [NoteUser, MysInfo, GenshinMysApi] = await Promise.all([
        load("NoteUser.js"),
        load("mysInfo.js"),
        load("mysApi.js"),
      ])
      genshinModules = {
        NoteUser: NoteUser.default,
        MysInfo: MysInfo.default,
        GenshinMysApi: GenshinMysApi.default,
      }
      return genshinModules
    } catch {
      /* 试下一个候选目录 */
    }
  }
  genshinModules = null
  return null
}

async function getAuth(qq) {
  const gi = await loadGenshin()
  if (!gi) return { ok: false, kind: "unavailable", reason: "genshin 模块不可用" }
  try {
    const user = await gi.NoteUser.create(String(qq))
    const uid = user?.getUid?.("gs") || ""
    if (!uid) return { ok: false, kind: "unavailable", reason: "未绑定 UID" }
    const bind = await gi.MysInfo.checkUidBing(uid, "gs")
    const ck = bind?.ck || ""
    if (!ck) return { ok: false, kind: "unavailable", reason: "未绑定 Cookie" }
    return { ok: true, gi, uid, ck }
  } catch (err) {
    return { ok: false, kind: "unavailable", reason: `读取绑定失败：${err?.message ?? err}` }
  }
}

const noDataText = text => /未找到|没有|暂无|不存在|无数据|未参与|not\s*found|empty/i.test(String(text ?? ""))

function hasModuleData(type, data, extra) {
  if (type === 1) return Boolean(data?.stat) && Number(extra.mode_id) > 0
  if (type === 2) {
    const single = data?.single
    const mp = data?.mp
    return Boolean((single && single.has_data !== false) || (mp && mp.has_data !== false)) && Number(extra.difficulty) > 0
  }
  if (type === 0) {
    const floor = Number.parseInt(String(extra.max_floor ?? "").split("-")[0], 10)
    return floor > 0 || Number(extra.total_star) > 0 || (data?.floors?.length ?? 0) > 0
  }
  return false
}

async function fetchRaw(auth, type) {
  try {
    const mys = new auth.gi.GenshinMysApi(auth.uid, auth.ck, { game: "gs", log: false })
    const res =
      type === 1
        ? await mys.getData("role_combat", { need_detail: true })
        : type === 2
          ? await mys.getData("hard_challenge", {})
          : await mys.getData("spiralAbyss", { schedule_type: "1" })
    if (!res || Number(res.retcode) !== 0 || !res.data) {
      const reason = res?.message || `接口 retcode=${res?.retcode ?? "无"}`
      return { ok: false, kind: noDataText(reason) ? "nodata" : "unavailable", reason }
    }
    const raw = res.data
    const data = type === 0 ? raw : Array.isArray(raw?.data) ? raw.data[0] : Array.isArray(raw) ? raw[0] : raw
    const extra = extraOf(type, data)
    if (!hasModuleData(type, data, extra))
      return { ok: false, kind: "nodata", reason: "模块内无数据" }
    return { ok: true, extra }
  } catch (err) {
    return { ok: false, kind: "unavailable", reason: `查询失败：${err?.message ?? err}` }
  }
}

const normNick = value => String(value ?? "").normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]/g, "").toLowerCase()

/**
 * 遍历「绑定 → 群名单」找出这一行真正的玩家 QQ。
 * 不把主播当玩家：主播 QQ 先剔除；找不到时返回 missing/left/ambiguous，不瞎 @。
 */
export function resolvePlayer({ model, store, dir, sheet, row, nickname }) {
  const nick = String(nickname ?? "").trim()
  const want = normNick(nick)
  const entries = dir.playerEntries ?? [...dir.entries()]
  const dirQqs = new Set(entries.map(([, qq]) => String(qq)))
  const anchors = model?.anchors ?? []
  const anchorQqs = new Set(
    anchors.map(a => String(qqOfAnchor(dir, a.name) ?? "")).filter(Boolean),
  )
  const anchorNames = new Set(anchors.map(a => normNick(a.name)).filter(Boolean))
  const binds = (store?.qqsOf?.(sheet, row) ?? [])
    .map(qq => ({ qq: String(qq), bind: store.get(sheet, qq) }))
    .filter(x => x.qq && !anchorQqs.has(x.qq))

  /** 绑定优先：同一行有多个有效绑定就是归属不明，不猜 */
  const exact = binds.filter(x => normNick(x.bind?.nickname) === want)
  if (exact.length > 1) return { ok: false, kind: "ambiguous", detail: "同一行有多个有效绑定" }
  if (exact.length === 1) {
    if (dirQqs.size && !dirQqs.has(exact[0].qq))
      return { ok: false, kind: "left", detail: "已不在本群（原绑定仍在）" }
    return { ok: true, qq: exact[0].qq, source: "bind" }
  }

  if (binds.length > 1) return { ok: false, kind: "ambiguous", detail: "同一行有多个绑定" }

  /** 没有绑定：按群昵称精确/全半角归一后匹配；主播同名的行不拿主播兜底 */
  if (want && !anchorNames.has(want)) {
    const hits = entries.filter(
      ([name, qq]) => normNick(name) === want && !anchorQqs.has(String(qq)),
    )
    const qqs = [...new Set(hits.map(([, qq]) => String(qq)))]
    if (qqs.length === 1) return { ok: true, qq: qqs[0], source: "nickname" }
    if (qqs.length > 1) return { ok: false, kind: "ambiguous", detail: "存在多个同名成员" }
  }

  if (anchorNames.has(want))
    return { ok: false, kind: "missing", detail: "该昵称与主播同名，未自动 @ 主播" }
  return { ok: false, kind: "missing", detail: "群名单中找不到该成员" }
}

async function queryOne({ group, qq, command, type, silent = false }) {
  /** 没绑定 UID/Cookie 的按“自动忽略”处理，不 @、不写状态 */
  const auth = await getAuth(qq)
  if (!auth.ok) return auth
  /** 静默清榜核查不发群命令；仍走同一份原始成绩 */
  if (!silent) {
    try {
      await Bot.pickGroup(group).sendMsg([at(qq), ` #${command}`])
    } catch (err) {
      log("warn", `[abyss-queue] 发送 ${command} 查询失败：${err?.message ?? err}`)
    }
    await sleep(400)
  }
  return fetchRaw(auth, type)
}

/**
 * 核查结果拼成播报块；不单独发送，交给原有完成播报合并。
 * 只 @ 有问题的人；完整达成的人由完成播报负责。
 */
function checkIssueBlocks(event, issues) {
  if (!issues.length) return []
  const meta = CHECK_TYPES[event.sheet]
  const blocks = [[`【${event.sheet}】清榜前核查`]]
  for (const issue of issues) {
    if (blocks.length > 1) blocks.push([])
    const who = issue.qq ? at(issue.qq) : String(issue.nickname || "（无名）")
    const text =
      issue.kind === "nodata"
        ? ` 未参与本期${meta.short}`
        : issue.kind === "partial"
          ? ` 未达成目标：${issue.detail}`
          : issue.kind === "unknown"
            ? ` 无法判定目标：${issue.detail}`
            : issue.kind === "left"
              ? ` 已不在本群（原绑定仍在），无法查询`
              : issue.kind === "missing"
                ? ` 群名单中找不到该成员（无法 @）`
                : issue.kind === "ambiguous"
                  ? ` 存在多个同名成员，无法确认（未 @）`
                  : ` 无法查询数据：${/未绑定/.test(issue.detail) ? `${issue.detail}，请先绑定后再试` : issue.detail}`
    blocks.push([who, text])
  }
  return blocks
}

/**
 * 处理本轮所有清榜前核查事件。
 * @param {{models:Array<object>, now?:Date, store?:object}} opts
 */
async function runPrecheckInner({
  models,
  now = new Date(),
  store,
  events: explicitEvents = null,
  phase = "verify",
  silent = false,
  group: explicitGroup = null,
} = {}) {
  const events = explicitEvents ?? precheckEvents(now)
  if (!events.length) return { updated: 0, checked: 0, skipped: 0, events: [], issueBlocks: [] }
  /** 没有 genshin 模块时（非 Yunzai 环境/缺插件）不假装查过，提醒保持原样 */
  if (!(await loadGenshin())) return { updated: 0, checked: 0, skipped: 0, events: [], issueBlocks: [] }

  const cycle = readJson(CYCLE_STATE()) ?? { done: {} }
  const state = readJson(CHECK_STATE()) ?? { done: {} }
  if (!state.done || typeof state.done !== "object") state.done = {}
  const groups = notifyGroups()
  const group = explicitGroup ?? groups[0] ?? (Number(config.roster?.group) || null)
  if (!silent && !group) return { updated: 0, checked: 0, skipped: 0, events: [], issueBlocks: [] }

  let updated = 0
  let checked = 0
  let skipped = 0
  const handled = []
  const issueBlocks = []

  for (const event of events) {
    const key = `${event.sheet}:${phase}:${event.round}`
    if (state.done[key]) continue
    /** 由 sendReminder 显式调用时提醒尚未落盘；定时 tick 路径仍要求提醒先成功 */
    if (!explicitEvents && !cycle.done?.[`${event.sheet}:reminder:${event.round}`]) continue

    const model = models.find(m => m.name === event.sheet)
    const queue = model ? queuedInSheet(model) : []
    const goalOf = row => String(model?.rows?.find(r => r.row === row.row)?.goal ?? "")
    const dir = group ? await memberDirectory(group) : new Map()
    const updates = []
    const issues = []
    for (const row of queue) {
      const nickname = String(row.nickname ?? "").trim()
      const player = resolvePlayer({ model, store, dir, sheet: event.sheet, row: row.row, nickname })
      if (!player.ok) {
        skipped++
        issues.push({ qq: "", nickname, kind: player.kind, detail: player.detail })
        continue
      }
      const qq = player.qq
      const meta = CHECK_TYPES[event.sheet]
      const goal = goalOf(row)
      const got = await queryOne({ group, qq, command: meta.command, type: meta.type, silent })
      checked++
      if (!got.ok) {
        skipped++
        issues.push({ qq, nickname, kind: got.kind ?? "unavailable", detail: got.reason })
        log("info", `[abyss-queue] ${event.sheet}「${nickname}」核查跳过：${got.reason}`)
        continue
      }
      const verdict = evaluateGoal(event.sheet, goal, got.extra)
      if (verdict.status !== "achieved") {
        skipped++
        issues.push({ qq, nickname, kind: verdict.status, detail: verdict.detail })
        continue
      }
      updates.push({ row: row.row, nickname, goal })
    }

    if (updates.length) {
      try {
        const version = await tableVersion()
        const out = await markChecked({ sheet: event.sheet, version, rows: updates })
        updated += Number(out.updated) || 0
        log("info", `[abyss-queue] ${event.sheet} 清榜前核查：确认完成 ${out.updated ?? 0} 人`)
      } catch (err) {
        /** 版本冲突或写状态失败：本次忽略，不阻断清榜 */
        log("warn", `[abyss-queue] ${event.sheet} 清榜前核查写状态失败：${err?.message ?? err}`)
      }
    }

    if (!silent && issues.length) issueBlocks.push(...checkIssueBlocks(event, issues))

    state.done[key] = new Date().toISOString()
    writeJson(CHECK_STATE(), state)
    handled.push(key)
    log("info", `[abyss-queue] ${event.sheet} 清榜前核查完成（${fmt(event.at)} - ${fmt(event.targetAt)}）`)
  }

  return { updated, checked, skipped, events: handled, issueBlocks }
}

/** tick 可能重叠：同一进程内只允许一轮核查，避免重复 @ 和重复查询 */
let PRECHECK_RUNNING = false
export async function runPrecheck(opts = {}) {
  if (PRECHECK_RUNNING) return { updated: 0, checked: 0, skipped: 0, events: [], busy: true }
  PRECHECK_RUNNING = true
  try {
    return await runPrecheckInner(opts)
  } finally {
    PRECHECK_RUNNING = false
  }
}
