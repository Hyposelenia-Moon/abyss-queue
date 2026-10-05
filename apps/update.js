/**
 * `#排队更新` / `#排队强制更新` —— 主人专用的插件自我更新
 *
 * 命令写法**刻意不是 `#更新`**：框架 `plugins/other/update.js` 的规则是
 * `^#(安?静)?(强制)?更新` 且 `priority: -Infinity`（排在所有插件前面），
 * 任何以 `#更新` 开头的消息都会被它先吃掉，本插件抢不到。所以这里用
 * `#排队**更新**` 这种「`#排队` 打头」的写法——与 `#排队` / `#排队初始化` 同一族，不与之竞争。
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
      rule: [
        { reg: "^#排队更新$", fnc: "update", permission: "master", log: true },
        { reg: "^#排队强制更新$", fnc: "forceUpdate", permission: "master", log: true },
      ],
    })
  }

  /**
   * @param {boolean} force 强制更新：`git reset --hard origin/main` 后 `pull --rebase`
   *
   * **会丢弃未提交改动**——只在主人显式发 `#排队强制更新` 时走这条路。
   */
  async update(force = false) {
    if (!this.e.isMaster) return this.reply("只有主人能更新插件")
    return this.safe(async () => {
      await this.reply(force ? "开始强制更新（会丢弃未提交改动）…" : "开始更新…")
      const result = await runUpdate({
        cwd: pluginRoot,
        force,
        /** 框架的工具：跑命令与重启都由它来，插件不自己 spawn */
        exec: (cmd, opts) => Bot.exec(cmd, opts),
        restart: () => Bot.restart(),
      })
      log("mark", `[abyss-queue] 自我更新：${result.ok ? (result.changed ? `成功 ${result.before.commit} → ${result.after.commit}` : "已是最新") : `失败：${result.reason}`}`)
      return this.reply(updateReply(result))
    })
  }

  /** `#排队强制更新`：`rule.fnc` 直接指这里，默认参数拿不到 true，所以单独一个方法 */
  async forceUpdate() {
    return this.update(true)
  }
}
