/**
 * 主人提示（带静默期的一次性通知）
 *
 * 用文件记「上次发这条提示的时间」而不是内存：崩溃重启循环里每次都是新进程，内存记不住。
 */
import fs from "node:fs"
import path from "node:path"
import { pluginRoot } from "./config.js"
import { log } from "../lib/logger.js"

/** 同一条提示的静默期：崩溃重启循环里不至于刷屏 */
const NOTICE_COOLDOWN = 6 * 60 * 60 * 1000

/** 提示标记文件路径（按 key 区分不同提示） */
export const noticeFile = key => path.join(pluginRoot, "data", `notice.${key}`)

/** 读「上次发这条提示的时间」：文件不存在 = 从未通知（返回 0，不是错误） */
function readNoticeAt(file) {
  try {
    return Number(fs.readFileSync(file, "utf8").trim()) || 0
  } catch (err) {
    /** 首次部署没有标记文件是**正常状态**，必须当成「从未通知」继续往下走 */
    if (err?.code === "ENOENT") return 0
    /** 其它读错误（权限、IO）保留原来的保护：不发，免得每次启动都打扰主人 */
    throw err
  }
}

/**
 * 通知核心：读旧时间（缺文件 = 0）→ 检查冷却 → 建目录写当前时间 → 通知
 *
 * 顺序刻意如此：**先写标记再通知**，发送失败也不至于在重启循环里反复打扰；
 * 反过来（先通知后写标记）一旦写标记失败就会重复发。
 *
 * 导出是为了回归：可直接指向临时目录，不必碰真实的 data/。
 * @param {string} file 标记文件路径
 * @param {string} text 通知内容
 * @param {object} [opts]
 * @param {number} [opts.cooldown] 静默期（毫秒）
 * @param {number} [opts.now] 当前时间（毫秒时间戳）
 * @param {(text:string)=>Promise<any>} [opts.send] 发送实现（默认私聊主人）
 * @returns {boolean} true = 本次发了；false = 在静默期内或发送失败
 */
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
