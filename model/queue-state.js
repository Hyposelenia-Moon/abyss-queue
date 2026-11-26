/** 定时任务的状态文件（读写） */
import { readJson, writeJson as writeJsonFile } from "../components/json-file.js"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"

export { readJson }

export const statePath = () => config.notifyStatePath

export const writeJson = (file, data) => {
  try {
    writeJsonFile(file, data)
  } catch (err) {
    log("error", `[abyss-queue] 写状态文件失败 ${file}：${err.message}`)
  }
}
