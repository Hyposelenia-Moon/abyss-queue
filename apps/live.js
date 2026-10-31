/**
 * `#排队开播提醒` —— 自己决定要不要收开播 @
 *
 * 维护者口径（2026-10-25）：**@ 是可选功能**。没有订阅的人不会被 @，
 * 没人订阅的开播也不会发整条提醒（不发 @全体、不替群友做主）。
 *
 * 2026-10-31 扩展：支持只订阅某几位主播；不带参数只查看状态，不再“发一次就切换”，
 * 减少误开 / 误关。落点见 model/live-alerts.js。
 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { liveAlertOf, setLiveAlertAnchors } from "../model/live-alerts.js"
import { liveStatusLines, refreshAnchorLive } from "../modules/anchor-live.js"
import { AppBase } from "../components/base.js"

const norm = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase()

/** 当前四张表里出现过的全部主播名（去重；用于“关某位主播”和未知名字提示） */
const anchorNamesOf = models => [
  ...new Set(
    [...models.values()]
      .flatMap(model => (model.anchors ?? []).map(anchor => String(anchor?.name ?? "").trim()))
      .filter(Boolean),
  ),
]

const USAGE = [
  "#开播提醒        查看当前设置",
  "#开播提醒 开      开启全部主播",
  "#开播提醒 关      关闭全部",
  "#开播提醒 开 阿修  只关注某一位主播",
].join("\n")

export class AbyssLiveAlert extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        /* #开播提醒 是新写法；#排队开播提醒 保留为旧写法兼容 */
        { reg: "^#(?:排队)?开播提醒(?:\\s+(.*))?$", fnc: "toggleAlerts" },
        { reg: "^#排队直播状态$", fnc: "showLiveStatus" },
      ],
    })
  }

  /**
   * `#排队直播状态` —— 立即刷新并回报每台直播间的状态
   *
   * 这是给"填了链接但图里没状态"用的自检入口：绕过定时任务直接查一次，
   * 把「开关是否开 / 哪台查到了什么 / 哪台没查到」直接回出来；刷新成功后
   * `#主播` / `#排队` 读到的就是这一份缓存。
   */
  async showLiveStatus() {
    return this.safe(async () => {
      if (!config.anchor_live?.enable) {
        return this.reply("直播状态检测没有开启：请主人在锅巴「主播直播（B站）」打开后再试。", true)
      }
      const models = [...(await this.models()).values()]
      await refreshAnchorLive(models, Date.now(), { force: true })
      const lines = liveStatusLines(models)
      return this.reply(
        `【开播状态】已刷新\n${lines.length ? lines.join("\n") : "没有查到状态：检查主播区 B 站直播间链接或服务器到 B 站接口的网络。"}`,
        true,
      )
    })
  }

  async toggleAlerts() {
    return this.safe(async () => {
      const qq = String(this.e.user_id ?? "").trim()
      if (!qq) return this.reply("没拿到你的 QQ，无法记录开播提醒订阅。", true)
      const raw = this.e.msg.trim().replace(/^#(?:排队)?开播提醒\s*/, "").trim()
      const words = raw.split(/\s+/).filter(Boolean)
      const action = words[0] ?? ""
      const anchorArg = words.slice(1).join(" ").trim()
      const current = liveAlertOf(qq)
      const ready = config.anchor_live?.enable ? "" : "\n（直播检测当前未开启，打开后才会生效）"

      const models = await this.models()
      const known = anchorNamesOf(models)
      const aliases = compileAliases(config.anchor_aliases)
      const resolveAnchor = value => {
        const text = String(value ?? "").trim()
        if (!text) return ""
        const canonical = canonicalAnchor(text, aliases)
        return known.find(name => norm(name) === norm(text) || norm(name) === norm(canonical)) ?? ""
      }
      const stateText = state => {
        if (!state.on) return "当前未订阅开播提醒"
        if (state.all) return "当前订阅：全部主播"
        return "当前订阅：" + state.anchors.join("、")
      }
      const viewReply = state => {
        if (!state.on) {
          return `【开播提醒】当前未订阅\n\n开启全部：#开播提醒 开\n只关注某位：#开播提醒 开 阿修`
        }
        return (
          `【开播提醒】${stateText(state)}\n\n` +
          "只有你正在排队、且选中该主播开播时才会提醒。\n" +
          `关闭这一位：#开播提醒 关 <主播>\n关闭全部：#开播提醒 关`
        )
      }

      /** 不带参数：查看当前设置；没有单独的“列表”命令，避免同一结果两个入口 */
      if (!action) {
        return this.reply(viewReply(current) + ready, true)
      }

      const on = /^(开|开启)$/.test(action)
      const off = /^(关|关闭)$/.test(action)
      if (!on && !off) {
        /** 旧提示里写过的“列表/状态”不再单列入口，引导回唯一的查看命令 */
        if (/^(列表|状态)$/.test(action)) {
          return this.reply("查看当前订阅，直接发 #开播提醒 就行。", true)
        }
        return this.reply(`没看懂「${action}」。\n\n${USAGE}`, true)
      }

      /** 全部主播 */
      if (!anchorArg) {
        if (off) {
          setLiveAlertAnchors(qq, [])
          return this.reply(`【开播提醒】已关闭全部开播提醒\n\n重新开启：#开播提醒 开${ready}`, true)
        }
        setLiveAlertAnchors(qq, null)
        return this.reply(
          `【开播提醒】已开启全部主播\n\n只有你正在排队、且选中主播开播时才会提醒。\n关闭：#开播提醒 关${ready}`,
          true,
        )
      }

      const anchor = resolveAnchor(anchorArg)
      if (!anchor) {
        return this.reply(
          `没找到主播「${anchorArg}」。\n当前主播区：${known.map(name => `「${name}」`).join("、") || "（空）"}`,
          true,
        )
      }

      if (on) {
        if (current.all) {
          return this.reply(`【开播提醒】当前已经是全部主播，已包含「${anchor}」。${ready}`, true)
        }
        const next = [...new Set([...current.anchors, anchor])]
        setLiveAlertAnchors(qq, next)
        return this.reply(
          `【开播提醒】已开启「${anchor}」\n\n当前只提醒：${next.join("、")}\n关闭这一位：#开播提醒 关 ${anchor}${ready}`,
          true,
        )
      }

      if (!current.on) return this.reply(`【开播提醒】当前未订阅，无需关闭。${ready}`, true)
      /**
       * 全部订阅下关掉某一位：当前没有任何“排除名单”存储，
       * 用它当下能看到的全部主播做一次快照，转成“只订阅其余主播”。
       */
      const next = current.all
        ? known.filter(name => norm(name) !== norm(anchor))
        : current.anchors.filter(name => norm(name) !== norm(anchor))
      setLiveAlertAnchors(qq, next)
      if (!next.length) {
        return this.reply(`【开播提醒】已关闭「${anchor}」，当前已无订阅。\n重新开启：#开播提醒 开${ready}`, true)
      }
      return this.reply(
        `【开播提醒】已关闭「${anchor}」\n\n当前只提醒：${next.join("、")}\n关闭全部：#开播提醒 关${ready}`,
        true,
      )
    })
  }
}
