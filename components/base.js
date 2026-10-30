/**
 * 各入口 app 的公共基类
 *
 * 这里只放与具体指令无关的胶水：异常出口、取表模型、上下文装配。
 * 每个 app 文件自己定义 rule 与 handler，这里不放业务方法。
 */
import { ValidationError } from "../modules/router.js"
import { getRemote } from "../model/remote.js"
import { getStore } from "../model/store.js"
import { cachedRoster } from "../model/roster.js"
import { config } from "./config.js"
import { log } from "./logger.js"

export class AppBase extends plugin {
  /** 取当前数据：来自云端快照（只读，见 model/remote.js）；force 时绕过 TTL 立即拉一版 */
  async models({ force = false } = {}) {
    return getRemote().read(({ models }) => models, { force })
  }

  async store() {
    return getStore()
  }

  /**
   * 发送者的**候选群昵称**（按可信度从高到低，去重）
   *
   * **群昵称优先，QQ 名牌靠后**（2026-10-18 维护者："识别的是群昵称，不是 QQ 名片"）：
   * 现场机器人把「希珀塞莱妮娅」（群昵称）认成了「绒月.」（QQ 名牌）。
   * 顺序：框架给的 `card`（群里那一刻最准的群昵称）→ **群名单里该 QQ 的群昵称**（可能会旧一天）
   * → 框架给的 `nickname`（通常就是 QQ 名牌）。
   *
   * 为什么要好几个：只信一个名字，名字一错就永远找不到本人那一行。
   * 认人本身**仍以 QQ 绑定为准**（见 `modules/queue.js` 的 `locateSelf`），这些名字只用来
   * "没有绑定时怎么认"；`mineView` 会逐个试，命中就停。
   */
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

  /**
   * 发送者的**群昵称**（主名片：日志、链接里的 `?n=`、私聊链接记录都用它）
   *
   * 取 `nicknames()` 的第一个；一个都没有（框架什么都没给）就退回 QQ 号。
   * 认"本人那一行"时**不该只用这一个**——见 `nicknames()` 与 `mineView` 的 `moreNames`。
   */
  nickname() {
    return this.nicknames()[0] ?? String(this.e?.user_id ?? "")
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
