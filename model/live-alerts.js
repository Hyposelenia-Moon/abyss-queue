/**
 * 开播提醒的订阅名单
 *
 * 口径（2026-10-25 维护者）：**@ 是可选功能**——只有群员自己发过 `#排队开播提醒` 订阅，
 * 且当前还在排队、选的又是那位主播时才会被 @；没人订阅的开播**整条提醒都不发**。
 *
 * 落点 `<插件根>/data/live-alerts.json`（常量，没有配置项；套件用
 * `ABYSS_QUEUE_LIVE_ALERTS_FILE` 重定向）。只记 QQ 与订阅时间，不记群号/榜名——"选谁"以表里
 * 那一行为准，退队/改选后自然不再命中。
 */
import { config } from "../components/config.js"
import { readJson, writeJson } from "./queue-state.js"

const VERSION = 1

const emptyState = () => ({ version: VERSION, uids: {} })

/** 读订阅名单（读不出来当空） */
export function readLiveAlerts(file = config.liveAlertsPath) {
  const raw = readJson(file)
  return raw && typeof raw === "object" && raw.uids && typeof raw.uids === "object" ? raw : emptyState()
}

/** 某个人有没有订阅 */
export const isLiveAlertOn = (qq, file = config.liveAlertsPath) => {
  const id = String(qq ?? "").trim()
  if (!id) return false
  return Boolean(readLiveAlerts(file).uids?.[id])
}

/**
 * 开 / 关订阅
 * @param {string|number} qq
 * @param {boolean} on
 * @param {string} [file]
 * @returns {boolean} 设置后的状态
 */
export function setLiveAlert(qq, on, file = config.liveAlertsPath) {
  const id = String(qq ?? "").trim()
  if (!id) return false
  const state = readLiveAlerts(file)
  if (on) state.uids[id] = { at: Date.now() }
  else delete state.uids[id]
  writeJson(file, state)
  return Boolean(on)
}
