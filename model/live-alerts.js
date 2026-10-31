/**
 * 开播提醒的订阅名单
 *
 * 口径（2026-10-25 维护者）：**@ 是可选功能**——只有群员自己发过 `#排队开播提醒` 订阅，
 * 且当前还在排队、选的又是那位主播时才会被 @；没人订阅的开播**整条提醒都不发**。
 *
 * 2026-10-31 扩展：订阅可只针对某几位主播。
 *   - `anchors: null`：全部主播（旧文件没有 anchors 也按全部处理）
 *   - `anchors: ["阿修Axiu"]`：只提醒这些主播
 *   - 没有记录 / `anchors: []`：未订阅
 *
 * 落点 `<插件根>/data/live-alerts.json`（常量，没有配置项；套件用
 * `ABYSS_QUEUE_LIVE_ALERTS_FILE` 重定向）。不记群号/榜名——"选谁"以表里那一行为准，
 * 退队/改选后自然不再命中。
 */
import { config } from "../components/config.js"
import { readJson, writeJson } from "./queue-state.js"

const VERSION = 2
const clean = value => String(value ?? "").trim()
const norm = value =>
  clean(value)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase()

const emptyState = () => ({ version: VERSION, uids: {} })

/** 读订阅名单（读不出来当空；旧版记录原样保留，由 liveAlertOf 兼容） */
export function readLiveAlerts(file = config.liveAlertsPath) {
  const raw = readJson(file)
  return raw && typeof raw === "object" && raw.uids && typeof raw.uids === "object" ? raw : emptyState()
}

/**
 * 某个 QQ 的订阅状态。
 * @returns {{on:boolean, all:boolean, anchors:string[]}}
 */
export function liveAlertOf(qq, file = config.liveAlertsPath) {
  const id = clean(qq)
  if (!id) return { on: false, all: false, anchors: [] }
  const record = readLiveAlerts(file).uids?.[id]
  if (!record || typeof record !== "object") return { on: false, all: false, anchors: [] }
  /** 没有 anchors 字段 = 旧版订阅，按“全部主播”处理 */
  if (record.anchors === null || record.anchors === undefined) return { on: true, all: true, anchors: [] }
  if (!Array.isArray(record.anchors)) return { on: true, all: true, anchors: [] }
  const anchors = [...new Set(record.anchors.map(clean).filter(Boolean))]
  return { on: anchors.length > 0, all: false, anchors }
}

/**
 * 某个人有没有订阅；传了 anchor 时只回答“这位主播是否会提醒我”。
 * 不传 anchor 时只回答“有没有任何订阅”（兼容旧调用）。
 */
export const isLiveAlertOn = (qq, anchor = "", file = config.liveAlertsPath) => {
  const state = liveAlertOf(qq, file)
  if (!state.on) return false
  if (!clean(anchor)) return true
  if (state.all) return true
  const want = norm(anchor)
  return state.anchors.some(name => norm(name) === want)
}

/** 订阅全部主播（旧 API；测试与旧的“只开一个总开关”调用仍可用） */
export function setLiveAlert(qq, on, file = config.liveAlertsPath) {
  return setLiveAlertAnchors(qq, on ? null : [], file)
}

/**
 * 设置订阅主播。
 * @param {string|number} qq
 * @param {string[]|null} anchors null = 全部主播；[] = 关闭全部订阅
 * @param {string} [file]
 * @returns {boolean} 设置后是否仍有订阅
 */
export function setLiveAlertAnchors(qq, anchors, file = config.liveAlertsPath) {
  const id = clean(qq)
  if (!id) return false
  const state = readLiveAlerts(file)
  if (anchors === null) {
    state.uids[id] = { at: Date.now(), anchors: null }
  } else {
    const list = [...new Set((Array.isArray(anchors) ? anchors : []).map(clean).filter(Boolean))]
    if (list.length) state.uids[id] = { at: Date.now(), anchors: list }
    else delete state.uids[id]
  }
  state.version = VERSION
  writeJson(file, state)
  return Boolean(state.uids[id])
}
