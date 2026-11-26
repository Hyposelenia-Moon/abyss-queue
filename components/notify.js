/** 主人提示（带静默期的一次性通知） */
import fs from "node:fs"
import path from "node:path"
import { pluginRoot } from "./config.js"
import { log } from "./logger.js"

const NOTICE_COOLDOWN = 6 * 60 * 60 * 1000

export const noticeFile = key => path.join(pluginRoot, "data", `notice.${key}`)

function readNoticeAt(file) {
  try {
    return Number(fs.readFileSync(file, "utf8").trim()) || 0
  } catch (err) {
    if (err?.code === "ENOENT") return 0
    throw err
  }
}

export function notifyOnce(file, text, { cooldown = NOTICE_COOLDOWN, now = Date.now(), send } = {}) {
  try {
    const last = readNoticeAt(file)
    if (now - last < cooldown) return false
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(now), "utf8")
    Promise.resolve((send ?? (t => Bot?.sendMasterMsg?.(t)))(text)).catch(() => {})
    return true
  } catch (err) {
    log("warn", `[abyss-queue] 通知标记读写失败（${file}）：${err?.message ?? err}`)
    return false
  }
}
