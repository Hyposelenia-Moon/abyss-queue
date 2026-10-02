/**
 * 更新类指令：从远端拉取本插件最新代码
 *
 * 为什么由插件自己实现：框架的 `#更新` 规则在本机实测收不到消息（日志无任何痕迹），
 * 因此用极低 priority 抢先匹配 `#更新 abyss`，把这条缩写命令接管过来；
 * 其余写法（`#更新 abyss-queue`、`#全部更新` 等）仍然交给框架处理。
 */
import { config } from "../components/config.js"
import {
  PLUGIN_DSC,
  PLUGIN_NAME,
  UPDATE_ALIASES,
  UPDATE_COMMAND_HINT,
  UPDATE_COMMANDS,
} from "../components/constants.js"
import { pluginRoot } from "../components/config.js"
import { formatUpdateReply } from "../lib/git.js"
import { headCommit, isRepo, pull } from "../model/git.js"
import { AppBase, log } from "./_base.js"

/** 同一时间只允许一个更新流程 */
let updating = false

export class AbyssQueueUpdate extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      /** 必须小于框架 update.js 的 -Infinity 之外的其他插件，排序方向 asc（越小越先） */
      priority: -1e9,
      rule: [
        {
          reg: UPDATE_COMMANDS,
          fnc: "update",
          permission: config.update_permission,
        },
      ],
    })
  }

  /** 这条消息是否指向本插件的更新（缩写或全名） */
  isOwnCommand(msg) {
    const m = /^#(强制)?更新\s+(\S+)$/.exec(String(msg ?? "").trim())
    if (!m) return false
    const arg = m[2]
    const dir = config.plugin_dir || "abyss-queue"
    /** 完整目录名，或别名表里指向该目录的缩写 */
    return arg === dir || UPDATE_ALIASES[arg] === dir
  }

  async update() {
    return this.safe(async () => {
      /** 不是本插件的更新命令：放行给框架的 #更新（返回 "return" 即不回复、不消费） */
      if (!this.isOwnCommand(this.e.msg)) return "return"
      if (!config.update_enable) return this.reply("插件更新已被配置关闭（update_enable: false）", true)
      if (updating) return this.reply("正在更新，请稍候再试", true)

      const dir = pluginRoot
      if (!isRepo(dir))
        return this.reply(
          [
            "当前插件目录不是 git 仓库，无法自动更新",
            `目录：${dir}`,
            "处置：改为 git clone 安装，或由维护者手动替换文件",
          ].join("\n"),
          true,
        )

      updating = true
      try {
        const force = /强制/.test(this.e.msg)
        await this.reply(`开始更新 ${PLUGIN_NAME}${force ? "（强制）" : ""}`, true)

        const before = await headCommit(dir)
        const res = await pull(dir)

        if (res.status === "conflict" || res.status === "error") {
          log("error", `[abyss-queue] 更新失败：${res.message}`)
          return this.reply(formatUpdateReply({ status: res.status, error: res.message, repo: PLUGIN_NAME }), true)
        }

        const after = await headCommit(dir)
        const changed = before.hash !== after.hash
        const text = formatUpdateReply({
          status: changed ? "updated" : "uptodate",
          before,
          after,
          repo: PLUGIN_NAME,
        })
        log("mark", `[abyss-queue] 更新完成 before=${before.hash} after=${after.hash}`)
        return this.reply(changed ? `${text}\n生效方式：${UPDATE_COMMAND_HINT}` : text, true)
      } finally {
        updating = false
      }
    })
  }
}
