/**
 * `#更新排队` —— 主人专用，框架 `#更新` 的简写
 *
 * 为什么可以这么写：框架 `plugins/other/update.js` 的规则是 `^#(安?静)?(强制)?更新`
 * 且 `priority: -Infinity`（排在所有插件前面），它先把消息接过去，然后把「排队」
 * 当成插件名去查——查不到就 `return false` 放行，于是本规则接住。
 * 换句话说 `#更新排队` 是「框架更新 + 插件名」的写法，与 `#更新 abyss-queue` 同效，
 * 只是插件名换成群里更顺口的那两个字。
 *
 * **强制更新不在这里**：`git reset --hard` 那种会丢改动的动作交给框架的
 * `#强制更新 abyss-queue`，插件不再自带第二条链路。
 *
 * 权限两道：`permission: "master"` 由框架在进 handler 前挡（非主人回「暂无权限」），
 * handler 里再判一次 `e.isMaster`（与 apps/init.js 同一口径）。
 *
 * 命令实现全在 `components/update.js`（注入 exec / restart，可离线回归）；
 * 这里只负责把框架侧的东西接上去：`Bot.exec` 跑 git、`Bot.restart()` 重启。
 */
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { runUpdate, updateReply } from "../components/update.js"
import { AppBase } from "../components/base.js"
import { pluginRoot } from "../components/config.js"
import { log } from "../components/logger.js"

export class AbyssQueueUpdate extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      /** 比 init（4000）更早一点：更新是运维动作，别让别的规则先拦 */
      priority: 3900,
      rule: [{ reg: "^#更新排队$", fnc: "update", permission: "master", log: true }],
    })
  }

  /** 快进更新：`git pull --ff-only`；有未提交改动时由 `runUpdate` 说明原因 */
  async update() {
    if (!this.e.isMaster) return this.reply("只有主人能更新插件")
    return this.safe(async () => {
      await this.reply("开始更新…")
      const result = await runUpdate({
        cwd: pluginRoot,
        force: false,
        /** 框架的工具：跑命令与重启都由它来，插件不自己 spawn */
        exec: (cmd, opts) => Bot.exec(cmd, opts),
        restart: () => Bot.restart(),
      })
      log("info", `[abyss-queue] 自我更新：${result.ok ? (result.changed ? `成功 ${result.before.commit} → ${result.after.commit}` : "已是最新") : `失败：${result.reason}`}`)
      return this.reply(updateReply(result))
    })
  }
}
