/**
 * 定时任务的状态文件（读写）
 *
 * 落点是**常量**：`<插件根>/data/progress.json`（在 `components/config.js` 里拼好，
 * 见 `config.notifyStatePath`），配置里没有对应的键——所以想要它不落在插件里，连入口都没有。
 * 回归套件要重定向，走 `ABYSS_QUEUE_STATE_FILE` 环境变量（仍由 `confineDataPath` 把守）。
 *
 * 这一个文件里装着四件事的去重状态（进度快照 / 每榜开启标记 / 当天已做的标记），
 * 口径见 modules/notify.js 的文件头。
 */
import fs from "node:fs"
import path from "node:path"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"

/** 状态文件绝对路径 */
export const statePath = () => config.notifyStatePath

/** 读状态；读不出来（首次运行 / 损坏 / 写了一半）由 modules/notify.js 的 readState 判为 null */
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
