/** `#排队初始化` —— 主人专用的一次性初始化 */
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
        { reg: "^#排队初始化$", fnc: "queueInit", permission: "master", log: true },
      ],
    })
  }
  async queueInit() {
    return this.safe(() => runInitCommand(this.e, { reply: text => this.reply(text), ...(this.initDeps ?? {}) }))
  }
}
