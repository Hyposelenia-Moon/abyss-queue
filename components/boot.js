/**
 * 启动期的生命周期副作用
 *
 * 与具体指令无关、但必须在进程里明确的时刻做掉的两件事：
 *   - 装退出钩子：进程退出时留下重启标记，启动器据此判断「重启」还是「停服」
 *   - 清理过期标记：避免上次残留被误判成重启
 *
 * 由 `index.js` 显式调用 `boot()`。为什么不在加载时自动跑：`apps/*` 与测试都会
 * import 插件根下的模块，自动副作用会（1）在回归套件里往仓库 `data/` 写标记
 * （2）让"到底谁触发了它"无从判断。显式调用 + 幂等，写调用点一次就够。
 */
import fs from "node:fs"
import path from "node:path"
import { pluginRoot } from "./config.js"
import { log } from "./logger.js"

/** 重启标记：启动器据此判断本次退出是「重启」还是「停服」，决定是否重新拉起两个服务 */
export const restartFlagFile = path.join(pluginRoot, "data", "restart.flag")

/** 标记的新鲜度上限：超过则视为上次遗留，不当作重启 */
const RESTART_FLAG_TTL = 5 * 60 * 1000

let booted = false
let exitHookInstalled = false

/** 进程退出时写下标记（无论重启是框架 #重启 还是插件触发，退出后都由启动器接管） */
function installExitHook() {
  if (exitHookInstalled || typeof process?.once !== "function") return
  exitHookInstalled = true
  process.once("exit", () => {
    try {
      fs.mkdirSync(path.dirname(restartFlagFile), { recursive: true })
      fs.writeFileSync(restartFlagFile, String(Date.now()), "utf8")
    } catch {
      /* 退出阶段不抛错 */
    }
  })
}

/** 启动时清理过期标记，避免上次残留被误判为重启 */
function clearStaleFlag() {
  try {
    if (!fs.existsSync(restartFlagFile)) return
    const at = Number(fs.readFileSync(restartFlagFile, "utf8").trim())
    if (!at || Date.now() - at > RESTART_FLAG_TTL) {
      fs.rmSync(restartFlagFile, { force: true })
      log("info", "[abyss-queue] 已清理过期的重启标记")
    }
  } catch {
    /* 忽略 */
  }
}

/** 幂等：重复调用只生效一次 */
export function boot() {
  if (booted) return
  booted = true
  installExitHook()
  clearStaleFlag()
}
