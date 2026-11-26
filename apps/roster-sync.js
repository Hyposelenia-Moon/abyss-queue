/** `#排队同步名单` —— 主人专用：**立刻**扫一次群成员名单并推给编辑器 */
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
      if (out?.skipped) return this.reply(`这次没同步：${out.skipped}`, true)
      return this.reply(`同步失败：${out?.error ?? "原因见机器人日志"}`, true)
    })
  }
}
