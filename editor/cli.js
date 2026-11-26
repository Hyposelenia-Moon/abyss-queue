/** 命令行参数与环境变量的解析原语 */
import fs from "node:fs"

export const argv = process.argv.slice(2)

export const makeFlag =
  (args = argv) =>
  (name, fallback = "") => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
  }
export const makeBoolFlag =
  (args = argv) =>
  (name, envValue = "") => {
    const i = args.indexOf(name)
    if (i < 0) return /^(1|true|yes|on)$/i.test(String(envValue ?? "").trim())
    const next = args[i + 1]
    const raw = next && !next.startsWith("--") ? next : "1"
    return /^(1|true|yes|on)$/i.test(String(raw).trim())
  }
export function setupLogFile(logFile) {
  const file = String(logFile ?? "").trim()
  if (!file) return
  const stream = fs.createWriteStream(file, { flags: "a" })
  const tee = original => (...parts) => {
    try {
      const line = parts.map(p => (typeof p === "string" ? p : String(p))).join(" ")
      stream.write(`[${new Date().toISOString()}] ${line}\n`)
    } catch {
    }
    original(...parts)
  }
  console.log = tee(console.log.bind(console))
  console.error = tee(console.error.bind(console))
  console.warn = tee(console.warn.bind(console))
}
