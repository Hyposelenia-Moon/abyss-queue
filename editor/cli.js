/**
 * 命令行参数与环境变量的解析原语
 *
 * 只有一份实现：入口与 `config.js` 共用同一套 `flag` / `boolFlag`，
 * 避免"同名的参数在两处解析出不同结果"。
 */
import fs from "node:fs"

/** 本进程的参数表（`node editor.mjs --port 7788` → `["--port","7788"]`） */
export const argv = process.argv.slice(2)

/** 取参数值；没写就用回退值（回退值通常来自环境变量） */
export const makeFlag =
  (args = argv) =>
  (name, fallback = "") => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
  }

/**
 * 开关型参数：裸写 `--owner-only` 或 `--owner-only 1/true/yes/on` 都算开；
 * 没写这个参数时用环境变量。
 */
export const makeBoolFlag =
  (args = argv) =>
  (name, envValue = "") => {
    const i = args.indexOf(name)
    if (i < 0) return /^(1|true|yes|on)$/i.test(String(envValue ?? "").trim())
    const next = args[i + 1]
    const raw = next && !next.startsWith("--") ? next : "1"
    return /^(1|true|yes|on)$/i.test(String(raw).trim())
  }

/**
 * 日志文件（可选）：`--log <file>` / 环境变量 `ABYSS_EDITOR_LOG`
 *
 * 存在的理由：本机快捷方式为了不留控制台窗口，是**直接起 node.exe** 的，
 * 没有控制台就没法用 `>>` 重定向；而且挂在控制台上的进程容易被外部的 Ctrl+C 顺手带走。
 * 自己写文件既不依赖外壳，也更稳。
 *
 * @param {string} logFile 目标文件；空串 = 不重定向
 */
export function setupLogFile(logFile) {
  const file = String(logFile ?? "").trim()
  if (!file) return
  const stream = fs.createWriteStream(file, { flags: "a" })
  const tee = original => (...parts) => {
    try {
      const line = parts.map(p => (typeof p === "string" ? p : String(p))).join(" ")
      stream.write(`[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* 写日志失败不影响服务 */
    }
    original(...parts)
  }
  console.log = tee(console.log.bind(console))
  console.error = tee(console.error.bind(console))
  console.warn = tee(console.warn.bind(console))
}
