/**
 * `#排队开播提醒` —— 自己决定要不要收开播 @
 *
 * 维护者口径（2026-10-25）：**@ 是可选功能**。没有订阅的人不会被 @，
 * 没人订阅的开播也不会发整条提醒（不发 @全体、不替群友做主）。
 *
 * 只记 QQ，不记榜/主播：提醒时按"表里那一行现在选的是谁"实时判断，
 * 退队或改选之后自然就不再命中。落点见 model/live-alerts.js。
 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { isLiveAlertOn, setLiveAlert } from "../model/live-alerts.js"
import { liveStatusLines, refreshAnchorLive } from "../modules/anchor-live.js"
import { AppBase } from "../components/base.js"

export class AbyssLiveAlert extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        { reg: "^#排队开播提醒(?:\\s*(开|关|开启|关闭))?$", fnc: "toggleAlerts" },
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
      const arg = /^#排队开播提醒(?:\s*(开|关|开启|关闭))?$/.exec(this.e.msg.trim())?.[1]
      const qq = String(this.e.user_id ?? "").trim()
      const on = arg ? /开/.test(arg) : !isLiveAlertOn(qq)
      setLiveAlert(qq, on)
      if (!on) return this.reply("已关闭开播提醒：以后主播开播不会再 @ 你。", true)
      const ready = config.anchor_live?.enable ? "" : "（插件当前未开启直播状态检测，打开后才会生效）"
      return this.reply(
        `已开启开播提醒：只有你正在排队、且选中的那位主播开播时才会 @ 你${ready}。` +
          "关闭发 #排队开播提醒 关",
        true,
      )
    })
  }
}
