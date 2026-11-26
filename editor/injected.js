/** 编辑器配置的**注入缝**：给"把编辑器挂到 bot 进程里"那一路用 */
import { makeBoolFlag, makeFlag } from "./cli.js"

const baseFlag = makeFlag()
const baseBoolFlag = makeBoolFlag()

const injected = {}
let hostMode = false

export function injectEditorConfig(values = {}) {
  hostMode = true
  for (const [key, value] of Object.entries(values)) if (value !== undefined) injected[key] = value
}

export const isHostMode = () => hostMode

export const injectedFlag = (name, fallback = "") =>
  injected[name] !== undefined ? String(injected[name]) : baseFlag(name, fallback)
export function injectedBoolFlag(name, envValue = "") {
  const value = injected[name]
  if (value === undefined) return baseBoolFlag(name, envValue)
  if (typeof value === "boolean") return value
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim())
}

let injectedLogFn = null

export function injectEditorLog(fn) {
  injectedLogFn = typeof fn === "function" ? fn : null
}

export const injectedLog = () => injectedLogFn

let injectedAlertFn = null

export function injectOwnerAlert(fn) {
  injectedAlertFn = typeof fn === "function" ? fn : null
}

export const injectedOwnerAlert = () => injectedAlertFn

let injectedGroupCallFn = null

export function injectGroupCall(fn) {
  injectedGroupCallFn = typeof fn === "function" ? fn : null
}

export const injectedGroupCall = () => injectedGroupCallFn
