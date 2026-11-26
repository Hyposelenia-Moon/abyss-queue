/** 启动期的生命周期副作用 */
import fs from "node:fs"
import path from "node:path"
import { confineDataPath, pluginRoot, testPathsAllowed } from "./config.js"
import { log } from "./logger.js"

/**
 * 重启标记的落点。
 *
 * 按**调用时**的环境算，不在模块求值时定死：套件会把 `ABYSS_QUEUE_RESTART_FLAG`
 * 指到各自的临时目录，定死的话换一个套件就写回上一个套件的目录。
 */
export function restartFlagPath() {
  const raw = testPathsAllowed() ? String(process.env.ABYSS_QUEUE_RESTART_FLAG ?? "").trim() : ""
  if (!raw) return path.join(pluginRoot, "data", "restart.flag")
  return confineDataPath("ABYSS_QUEUE_RESTART_FLAG", raw, "data/restart.flag")
}

const RESTART_FLAG_TTL = 5 * 60 * 1000

let booted = false
let exitHookInstalled = false

function installExitHook() {
  if (exitHookInstalled || typeof process?.once !== "function") return
  exitHookInstalled = true
  process.once("exit", () => {
    try {
      fs.mkdirSync(path.dirname(restartFlagPath()), { recursive: true })
      fs.writeFileSync(restartFlagPath(), String(Date.now()), "utf8")
    } catch {
    }
  })
}

function clearStaleFlag() {
  try {
    if (!fs.existsSync(restartFlagPath())) return
    const at = Number(fs.readFileSync(restartFlagPath(), "utf8").trim())
    if (!at || Date.now() - at > RESTART_FLAG_TTL) {
      fs.rmSync(restartFlagPath(), { force: true })
      log("info", "[abyss-queue] 已清理过期的重启标记")
    }
  } catch {
  }
}

export function boot() {
  if (booted) return
  booted = true
  installExitHook()
  clearStaleFlag()
}
