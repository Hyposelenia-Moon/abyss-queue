/** `#排队开播提醒` —— 自己决定要不要收开播 @ */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { liveAlertOf, setLiveAlertAnchors } from "../model/live-alerts.js"
import { liveStatusLines, refreshAnchorLiveDetailed } from "../modules/anchor-live.js"
import { AppBase } from "../components/base.js"

const norm = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase()

const anchorNamesOf = (models, aliases = []) => [
  ...new Set(
    [...models.values()]
      .flatMap(model => (model.anchors ?? []).map(anchor => canonicalAnchor(anchor?.name, aliases)))
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
        { reg: "^#(?:排队)?开播提醒(?:\\s+(.*))?$", fnc: "toggleAlerts" },
        { reg: "^#排队直播状态$", fnc: "showLiveStatus" },
      ],
    })
  }
  async showLiveStatus() {
    return this.safe(async () => {
      if (!config.anchor_live?.enable) {
        return this.reply("直播状态检测没有开启：请主人在锅巴「主播直播（B站）」打开后再试。", true)
      }
      const models = [...(await this.models()).values()]
      const result = await refreshAnchorLiveDetailed(models, Date.now(), {
        force: true,
        maxResolve: Number.MAX_SAFE_INTEGER,
      })
      const lines = liveStatusLines(models)
      const summary =
        result.failed > 0 || result.skipped > 0
          ? `刷新未完成\n共 ${result.total} 个直播入口，本轮成功 ${result.refreshed} 个，失败 ${result.failed} 个，跳过 ${result.skipped} 个。\n以下状态包含缓存，失败或跳过的直播入口尚未更新。`
          : `已刷新 ${result.total} 个直播入口`
      return this.reply(
        `【开播状态】${summary}\n${lines.length ? lines.join("\n") : "没有查到状态：检查主播区 B 站直播间链接或服务器到 B 站接口的网络。"}`,
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
      if (!action) {
        return this.reply(viewReply(current) + ready, true)
      }
      const on = /^(开|开启)$/.test(action)
      const off = /^(关|关闭)$/.test(action)
      if (!on && !off) {
        if (/^(列表|状态)$/.test(action)) {
          return this.reply("查看当前订阅，直接发 #开播提醒 就行。", true)
        }
        return this.reply(`没看懂「${action}」。\n\n${USAGE}`, true)
      }
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
      const aliases = compileAliases(config.anchor_aliases)
      const models = await this.models()
      const known = anchorNamesOf(models, aliases)
      const resolveAnchor = value => {
        const text = String(value ?? "").trim()
        if (!text) return ""
        const canonical = canonicalAnchor(text, aliases)
        return known.find(name => norm(name) === norm(text) || norm(name) === norm(canonical)) ?? ""
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
