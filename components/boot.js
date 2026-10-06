/**
 * 启动期的生命周期副作用
 *
 * 与具体指令无关、但必须在进程里明确的时刻做掉的两件事：
 *   - 装退出钩子：进程退出时留下重启标记，启动器据此判断「重启」还是「停服」
 *   - 清理过期标记：避免上次残留被误判成重启
 *
 * 由 `index.js` 显式调用 `boot()`。为什么不在加载时自动跑：`apps/*` 与测试都会
 * import 插件根下的模块，自动副作用会（1）在回归套件里留下重启标记——落点见下，
 * 套件已用环境变量指到临时目录（2）让"到底谁触发了它"无从判断。显式调用 + 幂等，写调用点一次就够。
 */
import fs from "node:fs"
import path from "node:path"
import { confineDataPath, pluginRoot, testPathsAllowed } from "./config.js"
import { log } from "./logger.js"

/**
 * 重启标记的落点：生产固定 `<插件根>/data/restart.flag`，**只有回归套件能重定向**
 *
 * 与绑定 / 备份同一条口径：落点是拼死的常量，重定向只能走 `ABYSS_QUEUE_RESTART_FLAG`
 * 环境变量 + `ABYSS_QUEUE_TEST_PATHS=1` 那道闸（生产根本不读这个变量），出圈的值由
 * `confineDataPath` 挡回插件内并记 error。
 *
 * 为什么必须能重定向：本文件由 `index.js` 的 `boot()` 装配退出钩子，而 `init.test.mjs` /
 * `workflow.test.mjs` 都会 `import("../index.js")`；钩子在**子进程退出时**触发，直接把标记
 * 写进仓库 `data/`，把一次套件跑成"仓库变脏"（见 test/README.md 第 7 条）。
 *
 * 在模块求值时定死（与 `config.js` 的三个落点一致）。套件侧的值由 `test/_helper.mjs` 在模块
 * 求值时设定（每个套件都会先加载它），`test/env.mjs` 再改指本套件的临时目录；而 boot.js 只在
 * 套件 import `../index.js`（或自己）时才被求值，那时变量已经就位。
 */
export const restartFlagFile = (() => {
  const raw = testPathsAllowed() ? String(process.env.ABYSS_QUEUE_RESTART_FLAG ?? "").trim() : ""
  if (!raw) return path.join(pluginRoot, "data", "restart.flag")
  return confineDataPath("ABYSS_QUEUE_RESTART_FLAG", raw, "data/restart.flag")
})()

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
