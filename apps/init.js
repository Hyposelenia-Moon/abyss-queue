/**
 * `#排队初始化` —— 主人专用的一次性初始化
 *
 * 逻辑全在 components/init/：它要读文件、要注册计划任务、要探活，
 * 放在组件层才能用注入的桩跑回归（`initDeps` 就是这个注入点，见 test/init.test.mjs）。
 */
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { runInitCommand } from "../components/init/index.js"
import { AppBase } from "../components/base.js"

export class AbyssQueueInit extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        /**
         * `permission: "master"` 是框架自己的主人判定（loader.js 的 filtPermission：
         * 非主人直接回「暂无权限，只有主人才能操作」，压根不进 handler）；
         * handler 里再判一次 `e.isMaster` 是第二道闸——两道都留着，别删其中任何一道。
         */
        { reg: "^#排队初始化$", fnc: "queueInit", permission: "master", log: true },
      ],
    })
  }

  /**
   * 为什么按 QQ 而不是昵称写白名单：权限只认稳定身份（AGENTS.md），昵称随时能改。
   * 非主人由 `runInitCommand` 挡掉：**不读配置、不建目录、一个字都不写**。
   */
  async queueInit() {
    return this.safe(() => runInitCommand(this.e, { reply: text => this.reply(text), ...(this.initDeps ?? {}) }))
  }
}
