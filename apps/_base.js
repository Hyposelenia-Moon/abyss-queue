/**
 * 各入口 app 的公共基类
 *
 * 这里只放与具体指令无关的胶水：日志、异常出口、取表模型、上下文装配。
 * 每个 app 文件自己定义 rule 与 handler。
 */
import { config, configHint } from "../components/config.js"
import { JOIN_CONTEXT } from "../components/constants.js"
import { ValidationError } from "../lib/router.js"
import { getTable, getStore } from "../model/index.js"

export const log = (level, ...args) => {
  if (typeof logger !== "undefined" && logger?.[level]) logger[level](...args)
  else console.log(...args)
}

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
