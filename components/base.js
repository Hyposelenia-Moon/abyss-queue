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
  /** 取当前数据：来自云端快照（只读，见 model/remote.js） */
  async models() {
    return getRemote().read(({ models }) => models)
  }

  async store() {
    return getStore()
  }

  /**
   * 发送者的**群昵称**
   *
   * 顺序：群名片 → （名片为空时）按 QQ 从群名单缓存里取 → 框架给的昵称 → QQ 号。
   *
   * 为什么中间要多这一步（2026-10-18 维护者反馈"私聊发的图里不是本人的完成情况"）：
   * `#排队` 在**私聊**里也收，而私聊事件没有 `sender.card`，框架给的 `nickname` 是 **QQ 昵称**——
   * 它与群名片通常不是一回事。于是"按昵称兜底定位本人那一行"（`modules/queue.js` 的 `locateSelf`）
   * 全部落空：私聊收到的那张图里就没有「我的排队信息 / 帮帮完成情况」那一块。
   * 群名单缓存（`model/roster.js`，内存 + 落盘）里有"QQ → 群名片"，用它补上；
   * 缓存也没有（刚重启、还没扫过名单）就退回原来的口径，行为与从前一致。
   */
  nickname() {
    const card = String(this.e?.sender?.card ?? "").trim()
    if (card) return card
    const qq = String(this.e?.user_id ?? "").trim()
    const group = String(config.roster?.group ?? "").trim()
    const cached = qq && group ? cachedRoster(group) : null
    const hit = (cached?.members ?? []).find(m => m.qq === qq)
    if (hit?.nick) return hit.nick
    return String(this.e?.sender?.nickname || this.e?.user_id)
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
