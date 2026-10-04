/**
 * 定时任务的状态文件（读写）
 *
 * 配置里能改（`notify.state_file`），但**不许离开插件目录**：每次取用时过一遍
 * `confineDataPath`，出圈就记 error 并回落到 `data/progress.json`。
 * 在取用处判（而不是只用 loadConfig 算出的那份）是为了让套件在运行中改配置照样生效。
 *
 * 这一个文件里装着四件事的去重状态（进度快照 / 每榜开启标记 / 当天已做的标记），
 * 口径见 lib/notify.js 的文件头。
 */
import fs from "node:fs"
import path from "node:path"
import { config, confineDataPath, pluginRoot } from "../components/config.js"
import { log } from "../lib/logger.js"

/** 状态文件绝对路径（出圈记 error 并按默认值回落） */
export const statePath = () => {
  const file = config.notify?.state_file || "data/progress.json"
  const abs = path.isAbsolute(file) ? file : path.join(pluginRoot, file)
  return confineDataPath("notify.state_file", abs, "data/progress.json")
}

/** 读状态；读不出来（首次运行 / 损坏 / 写了一半）由 lib/notify.js 的 readState 判为 null */
export const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** 写状态：先算后写、一次落盘（见 apps/queue.js 的 tick） */
export const writeJson = (file, data) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
  } catch (err) {
    log("error", `[abyss-queue] 写状态文件失败 ${file}：${err.message}`)
  }
}
