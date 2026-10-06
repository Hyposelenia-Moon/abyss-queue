/**
 * 各入口 app 的公共基类
 *
 * 这里只放与具体指令无关的胶水：异常出口、取表模型、上下文装配。
 * 每个 app 文件自己定义 rule 与 handler，这里不放业务方法。
 */
import { ValidationError } from "../lib/router.js"
import { getRemote } from "../model/remote.js"
import { getStore } from "../model/store.js"
import { log } from "./logger.js"

export class AppBase extends plugin {
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
        log("info", `[abyss-queue] ${err.message}`)
        return this.reply(err.message)
      }
      log("error", `[abyss-queue] ${err?.stack || err}`)
      return this.reply(`出错了：${err.message}`)
    }
  }
}
