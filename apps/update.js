/**
 * 更新类指令：从远端拉取本插件最新代码
 *
 * 流程设计（要点：不让 git 半途因"本地改动会被覆盖"而失败）：
 *   1. fetch 远端引用（不动工作区）
 *   2. 比较 HEAD 与上游的领先/落后
 *   3. 落后则尝试 `merge --ff-only`：干净工作区可直接快进
 *   4. 快进被本地改动挡住时，提示用 `#强制更新 abyss`（`reset --hard` 对齐上游）
 *
 * 因为部署目录里 `config/config.yaml` 与 `data/` 都是 gitignore 的，
 * 强制对齐不会碰这两处，仅丢弃被跟踪文件的本地改动。
 */
import { config, pluginRoot } from "../components/config.js"
import {
  PLUGIN_DSC,
  PLUGIN_NAME,
  UPDATE_ALIASES,
  UPDATE_COMMAND_HINT,
  UPDATE_COMMANDS,
} from "../components/constants.js"
import { formatUpdateReply } from "../lib/git.js"
import { compareWithUpstream, fastForward, fetchRemote, forceReset, headCommit, isRepo } from "../model/git.js"
import { AppBase, log } from "./_base.js"

/** 同一时间只允许一个更新流程 */
let updating = false

/** 框架重启标记的 Redis key（与 plugins/other/restart.js 保持一致） */
const RESTART_KEY = "Yz:restart"

/** 自动重启时给用户的提示 */
const AUTO_RESTART_HINT = "正在自动重启以使新代码生效，稍等片刻"

export class AbyssQueueUpdate extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      /** 需小于框架 update.js 的优先级（排序方向 asc，越小越先），以抢到这条缩写命令 */
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
    return arg === dir || UPDATE_ALIASES[arg] === dir
  }

  /** 提取要更新的目标目录名（非本插件则返回空串） */
  target() {
    const m = /^#(强制)?更新\s+(\S+)$/.exec(String(this.e.msg ?? "").trim())
    if (!m) return ""
    const arg = m[2]
    const dir = config.plugin_dir || "abyss-queue"
    return arg === dir ? dir : UPDATE_ALIASES[arg] === dir ? dir : ""
  }

  async update() {
    return this.safe(async () => {
      /** 不是本插件的更新命令：放行给框架的 #更新（"return" = 不回复、不消费） */
      if (!this.target()) return "return"
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

      const force = /强制/.test(this.e.msg)
      updating = true
      try {
        const before = await headCommit(dir)

        const fetched = await fetchRemote(dir)
        if (fetched.status === "error") {
          log("error", `[abyss-queue] fetch 失败：${fetched.message}`)
          return this.reply(`${PLUGIN_NAME} 拉取远端失败：${fetched.message}`, true)
        }

        const cmp = await compareWithUpstream(dir)
        if (!cmp.hasUpstream)
          return this.reply(`${PLUGIN_NAME} 当前分支没有配置上游（upstream），无法比对远端`, true)
        if (cmp.behind === 0 && !force)
          return this.reply(formatUpdateReply({ status: "uptodate", before, repo: PLUGIN_NAME }), true)

        await this.reply(
          `开始更新 ${PLUGIN_NAME}${force ? "（强制对齐）" : ""}（落后 ${cmp.behind} 个提交${cmp.changes ? `，本地改动 ${cmp.changes} 处` : ""}）`,
          true,
        )

        /** 强制模式先对齐再校验；普通模式尝试快进 */
        if (force) {
          const res = await forceReset(dir)
          if (res.error) {
            log("error", `[abyss-queue] 强制对齐失败：${res.error.message}`)
            return this.reply(`${PLUGIN_NAME} 强制对齐失败：${res.error.message}`, true)
          }
        } else {
          const res = await fastForward(dir)
          if (res.error) {
            log("mark", `[abyss-queue] 快进被拦下，需强制更新：${res.error.message}`)
            return this.reply(
              [
                `${PLUGIN_NAME} 有本地改动，无法快进`,
                `本地改动：${cmp.changes} 处（部署目录被直接改过）`,
                `处置：发送 #强制更新 abyss（对齐远端 ${cmp.upstream}，丢弃这些改动；config.yaml 与 data/ 不受影响）`,
              ].join("\n"),
              true,
            )
          }
        }

        const after = await headCommit(dir)
        const changed = before.hash !== after.hash
        log("mark", `[abyss-queue] 更新完成 before=${before.hash} after=${after.hash} force=${force}`)
        if (!changed)
          return this.reply(formatUpdateReply({ status: "uptodate", before, after, repo: PLUGIN_NAME }), true)

        const text = formatUpdateReply({ status: "updated", before, after, repo: PLUGIN_NAME })
        /** 更新后自动重启：框架的热重载只失效入口模块，apps/ 等子模块仍命中 ESM 缓存 */
        if (!config.update_auto_restart)
          return this.reply(`${text}\n生效方式：${UPDATE_COMMAND_HINT}`, true)

        await this.reply(`${text}\n${AUTO_RESTART_HINT}`, true)
        return this.restartFramework()
      } finally {
        updating = false
      }
    })
  }

  /**
   * 触发框架重启（复用框架自己的重启链路）
   *
   * 框架 `plugins/other/restart.js` 的 Restart.restart() 会：写 Redis 标记 → Bot.restart()；
   * 新进程上线后读标记并回执。这里只补写标记（含会话信息，让回执发回原群），再调 Bot.restart()。
   */
  async restartFramework() {
    try {
      if (typeof Bot?.restart !== "function") throw new Error("当前环境没有 Bot.restart")
      if (typeof redis?.set === "function")
        await redis.set(
          RESTART_KEY,
          JSON.stringify({
            isExit: false,
            group_id: this.e.group_id,
            user_id: this.e.user_id,
            bot_id: this.e.self_id,
            time: Date.now(),
          }),
          { EX: 300 },
        )
      await Bot.restart()
      return true
    } catch (err) {
      log("error", `[abyss-queue] 自动重启失败：${err?.message ?? err}`)
      return this.reply(`自动重启失败，请手动 #重启：${err?.message ?? err}`, true)
    }
  }
}
