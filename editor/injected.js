/**
 * 编辑器配置的**注入缝**：给"把编辑器挂到 bot 进程里"那一路用
 *
 * 独立进程（`node editor/editor.mjs`）走 argv / 环境变量，不需要这个模块。
 * 宿主（bot）在 **import `editor/editor.mjs` 之前**调用 `injectEditorConfig()` 把值放进来，
 * 编辑器那边就**注入优先、argv / 环境变量兜底**。
 *
 * 为什么要它：`editor/config.js` 的取值口径是"参数 → 环境变量 → 默认值"，而宿主手里只有
 * `config.remote`（口令 / 签名密钥 / 管理口令 / 表路径 / 挂载前缀）。注入让两边共用**同一份值**：
 * 同一件事只有一个来源，口令对不上、配置被写坏这类事故才不会从缝里钻出来。
 *
 * 键名就用**参数名**（`"--token"` / `"--file"` / `"--owner-only"` …）：不再维护一张
 * "参数名 ↔ 键名"的映射表（映射表必然漂移）。没注入的键一律回落 argv / 环境变量，
 * 所以"注一半"也是安全的。
 */
import { makeBoolFlag, makeFlag } from "./cli.js"

/** 进程启动时的参数表快照（`cli.js` 也是这么抓的，口径一致） */
const baseFlag = makeFlag()
const baseBoolFlag = makeBoolFlag()

const injected = {}
let hostMode = false

/**
 * 宿主在 import 编辑器之前调它
 *
 * @param {object} [values] 键 = 参数名（如 `{ "--token": "abc", "--owner-only": true }`）；
 *   值为 `undefined` 的键会被忽略（"没配"就交给兜底，而不是把兜底值写成空）
 */
export function injectEditorConfig(values = {}) {
  hostMode = true
  for (const [key, value] of Object.entries(values)) if (value !== undefined) injected[key] = value
}

/**
 * 是不是**宿主模式**（编辑器跑在别的进程里，靠注入拿配置）
 *
 * 两处行为按它分叉，都是"别把宿主带走"：
 *   1. 配置不合法时**抛错**而不是 `process.exit(1)`（见 `config.js` 的 `failClosed`）；
 *   2. 不接管宿主的 stdout / 退出与信号处理（见 `editor.mjs` 顶部的进程钩子）。
 */
export const isHostMode = () => hostMode

/** 注入优先、argv / 环境变量兜底（签名与 `cli.js` 的 `flag` 一致） */
export const injectedFlag = (name, fallback = "") =>
  injected[name] !== undefined ? String(injected[name]) : baseFlag(name, fallback)

/** 注入优先、argv / 环境变量兜底（签名与 `cli.js` 的 `boolFlag` 一致；布尔直接采信） */
export function injectedBoolFlag(name, envValue = "") {
  const value = injected[name]
  if (value === undefined) return baseBoolFlag(name, envValue)
  if (typeof value === "boolean") return value
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim())
}
