/** 各入口 app 的公共基类 */
import { ValidationError } from "../modules/router.js"
import { readTable } from "../model/local.js"
import { getStore } from "../model/store.js"
import { cachedRoster } from "../model/roster.js"
import { config } from "./config.js"
import { log } from "./logger.js"

export class AppBase extends plugin {
  async models() {
    return readTable(({ models }) => models)
  }
  async store() {
    return getStore()
  }
  nicknames() {
    const out = []
    const push = v => {
      const s = String(v ?? "").trim()
      if (s && !out.includes(s)) out.push(s)
    }
    push(this.e?.sender?.card)
    const group = String(config.roster?.group ?? "").trim()
    const qq = String(this.e?.user_id ?? "").trim()
    if (group && qq) push(cachedRoster(group)?.members?.find(m => String(m?.qq ?? "").trim() === qq)?.nick)
    push(this.e?.sender?.nickname)
    return out
  }
  nickname() {
    return this.nicknames()[0] ?? String(this.e?.user_id ?? "")
  }
  isGroup() {
    return Boolean(this.e.isGroup)
  }
  draftKey() {
    return `${this.e.self_id}:${this.e.user_id}`
  }
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
