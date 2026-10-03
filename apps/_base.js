/**
 * 各入口 app 的公共基类
 *
 * 这里只放与具体指令无关的胶水：日志、异常出口、取表模型、上下文装配。
 * 每个 app 文件自己定义 rule 与 handler。
 */
import fs from "node:fs"
import path from "node:path"
import { pluginRoot } from "../components/config.js"

import { log } from "../lib/logger.js"
import { checkPatches, patchNotice } from "../lib/patches.js"
import { ValidationError } from "../lib/router.js"
import { getRemote, getStore } from "../model/index.js"

export { log }

/** 重启标记：启动器据此判断本次退出是「重启」还是「停服」，决定是否重新拉起两个服务 */
const RESTART_FLAG = path.join(pluginRoot, "data", "restart.flag")

/** 标记的新鲜度上限：超过则视为上次遗留，不当作重启 */
const RESTART_FLAG_TTL = 5 * 60 * 1000

/** 进程退出时写下标记（无论重启是框架 #重启 还是插件触发，退出后都由启动器接管） */
let exitHookInstalled = false
function installExitHook() {
  if (exitHookInstalled || typeof process?.once !== "function") return
  exitHookInstalled = true
  process.once("exit", () => {
    try {
      fs.mkdirSync(path.dirname(RESTART_FLAG), { recursive: true })
      fs.writeFileSync(RESTART_FLAG, String(Date.now()), "utf8")
    } catch {
      /* 退出阶段不抛错 */
    }
  })
}

/** 启动时清理过期标记，避免上次残留被误判为重启 */
function clearStaleFlag() {
  try {
    if (!fs.existsSync(RESTART_FLAG)) return
    const at = Number(fs.readFileSync(RESTART_FLAG, "utf8").trim())
    if (!at || Date.now() - at > RESTART_FLAG_TTL) {
      fs.rmSync(RESTART_FLAG, { force: true })
      log("mark", "[abyss-queue] 已清理过期的重启标记")
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 模块级执行（不能放 init()：apps/queue.js 自己定义了 init 做定时推送，会覆盖基类同名方法）
 * - 装退出钩子：进程退出时留下重启标记，启动器据此重启而不是停服
 * - 清理过期标记：避免上次残留被误判
 */
installExitHook()
clearStaleFlag()

/** 自检只跑一次：几个 app 会各实例化一次 */
let patchesChecked = false
let patchesCheckRuns = 0

/** 自检实际执行次数（回归用：确认多个 app 只触发一次） */
export const patchesCheckCount = () => patchesCheckRuns

/** 部署补丁自检：缺失时写日志并私聊主人（换机部署最容易漏这一环） */
function checkDeployPatches() {
  if (patchesChecked) return
  patchesChecked = true
  patchesCheckRuns++
  try {
    const { missing } = checkPatches()
    if (!missing.length) return
    const notice = patchNotice(missing)
    log("warn", notice)
    notifyMasterOnce(notice, "patches")
  } catch (err) {
    log("warn", `[abyss-queue] 部署补丁自检失败：${err?.message ?? err}`)
  }
}

/** 同一条提示的静默期：崩溃重启循环里不至于刷屏 */
const NOTICE_COOLDOWN = 6 * 60 * 60 * 1000

/**
 * 私聊主人一条提示，同一 key 在静默期内只发一次
 *
 * 用文件记时间而不是内存：崩溃重启循环里每次都是新进程，内存记不住。
 */
function notifyMasterOnce(text, key) {
  try {
    const file = path.join(pluginRoot, "data", `notice.${key}`)
    const now = Date.now()
    const last = Number(fs.readFileSync(file, "utf8").trim()) || 0
    if (now - last < NOTICE_COOLDOWN) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(now), "utf8")
    Promise.resolve(Bot?.sendMasterMsg?.(text)).catch(() => {})
  } catch {
    /* 记不上就不发，避免每次启动都打扰主人 */
  }
}

export class AppBase extends plugin {
  /**
   * 自检放构造函数：模块加载期框架的 Bot 还没就绪，那时私聊主人会失败。
   * 走构造函数而不是 init()，因为子类（apps/queue.js）会覆盖 init 做定时推送。
   */
  constructor(...args) {
    super(...args)
    checkDeployPatches()
  }

  /** 取当前数据：来自云端快照（只读，见 model/remote.js） */
  async models() {
    return getRemote().read(({ models }) => models)
  }

  async store() {
    return getStore()
  }

  nickname() {
    return String(this.e.sender?.card || this.e.sender?.nickname || this.e.user_id)
  }

  isGroup() {
    return Boolean(this.e.isGroup)
  }

  draftKey() {
    return `${this.e.self_id}:${this.e.user_id}`
  }

  /** 统一异常出口：出错不让机器人静默；用户输入问题只回原因 */
  async safe(fn) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ValidationError) {
        log("mark", `[abyss-queue] ${err.message}`)
        return this.reply(err.message)
      }
      log("error", `[abyss-queue] ${err?.stack || err}`)
      return this.reply(`出错了：${err.message}`)
    }
  }
}
