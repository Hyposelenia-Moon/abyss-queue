/**
 * 各入口 app 的公共基类
 *
 * 这里只放与具体指令无关的胶水：日志、异常出口、取表模型、上下文装配。
 * 每个 app 文件自己定义 rule 与 handler。
 */
import fs from "node:fs"
import path from "node:path"
import { config, configHint, pluginRoot } from "../components/config.js"
import { JOIN_CONTEXT } from "../components/constants.js"
import { ValidationError } from "../lib/router.js"
import { getTable, getStore } from "../model/index.js"

export const log = (level, ...args) => {
  if (typeof logger !== "undefined" && logger?.[level]) logger[level](...args)
  else console.log(...args)
}

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

export class AppBase extends plugin {
  /** 取表格模型（只读） */
  async models() {
    if (!config.xlsxPath) throw new Error(configHint())
    return getTable().read(({ models }) => models)
  }

  async store() {
    return getStore()
  }

  table() {
    return getTable()
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

  /** 引导流程的上下文存活时间 */
  armJoin() {
    this.setContext(JOIN_CONTEXT, this.isGroup(), config.context_timeout)
  }
}
