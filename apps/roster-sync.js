/**
 * `#排队同步名单` —— 主人专用：**立刻**扫一次群成员名单并推给编辑器
 *
 * 为什么要有这条：名单本来只有两条自动路径——机器人启动后 20 秒那次 kick、以及每天到
 * `roster.at` 那次 tick。想"现在就看一眼"时没有任何入口（只能重启机器人或等第二天），
 * 排查"名单到底推没推"时尤其别扭。这条命令把同一个 `pushRoster()` 手动跑一次，
 * 回执照它的话说清结果（同步了几人 / 改名几行 / 退群删了几行 / 为什么没做）。
 *
 * 权限与 `#排队初始化` / `#排队更新` 同一档：**主人专用**。名单推送会按 QQ 对账改名、
 * 甚至删掉退群者的行，属于全表级的动作，不该由普通管理员随手触发。
 * 两条闸都留着（框架的 `permission: "master"` + handler 里的 `e.isMaster`），
 * 与 `apps/init.js` 同一口径。
 */
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { pushRoster } from "../model/roster.js"
import { AppBase } from "../components/base.js"

export class AbyssRosterSync extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [{ reg: "^#排队同步名单$", fnc: "rosterSync", permission: "master", log: true }],
    })
  }

  /** 手动推一次名单：结果按 `pushRoster()` 的三种回执分别说清，不猜、不吞错 */
  async rosterSync() {
    return this.safe(async () => {
      if (this.e?.isMaster !== true) return this.reply("只有机器人的主人才能同步群成员名单", true)
      const out = await pushRoster()
      if (out?.ok)
        return this.reply(
          `群成员名单已同步：${out.count} 人` +
            (out.renamed ? `，改名同步 ${out.renamed} 行` : "") +
            (out.removed ? `，退群删除 ${out.removed} 行` : ""),
          true,
        )
      /** 没配群号 / 没配编辑器地址 / 签不出身份：把原因原样说出来（这几条原来只在日志里） */
      if (out?.skipped) return this.reply(`这次没同步：${out.skipped}`, true)
      return this.reply(`同步失败：${out?.error ?? "原因见机器人日志"}`, true)
    })
  }
}
