/** 开播提醒的订阅名单 */
import { config } from "../components/config.js"
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { readJson, writeJson } from "./queue-state.js"

const VERSION = 2
const clean = value => String(value ?? "").trim()
const norm = value =>
  clean(value)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase()
const aliases = () => compileAliases(config.anchor_aliases)

const emptyState = () => ({ version: VERSION, uids: {} })

export function readLiveAlerts(file = config.liveAlertsPath) {
  const raw = readJson(file)
  return raw && typeof raw === "object" && raw.uids && typeof raw.uids === "object" ? raw : emptyState()
}

export function liveAlertOf(qq, file = config.liveAlertsPath) {
  const id = clean(qq)
  if (!id) return { on: false, all: false, anchors: [] }
  const record = readLiveAlerts(file).uids?.[id]
  if (!record || typeof record !== "object") return { on: false, all: false, anchors: [] }
  if (record.anchors === null || record.anchors === undefined) return { on: true, all: true, anchors: [] }
  if (!Array.isArray(record.anchors)) return { on: true, all: true, anchors: [] }
  const list = aliases()
  const anchors = [
    ...new Map(
      record.anchors
        .map(name => canonicalAnchor(name, list))
        .filter(Boolean)
        .map(name => [norm(name), name]),
    ).values(),
  ]
  return { on: anchors.length > 0, all: false, anchors }
}

export const isLiveAlertOn = (qq, anchor = "", file = config.liveAlertsPath) => {
  const state = liveAlertOf(qq, file)
  if (!state.on) return false
  if (!clean(anchor)) return true
  if (state.all) return true
  const want = norm(canonicalAnchor(anchor, aliases()))
  return state.anchors.some(name => norm(name) === want)
}

export function setLiveAlert(qq, on, file = config.liveAlertsPath) {
  return setLiveAlertAnchors(qq, on ? null : [], file)
}

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
