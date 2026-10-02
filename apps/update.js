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
import fs from "node:fs"
import path from "node:path"
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

/** 重启标记文件：启动器据此判断退出是"重启"还是"停止"（位于已忽略的 data/ 目录） */
export const RESTART_FLAG = path.join(pluginRoot, "data", "restart.flag")

/** 自动重启时给用户的提示 */
const AUTO_RESTART_HINT = "正在自动重启以使新代码生效，稍等片刻"

function writeRestartFlag() {
  try {
    fs.mkdirSync(path.dirname(RESTART_FLAG), { recursive: true })
    fs.writeFileSync(RESTART_FLAG, String(Date.now()), "utf8")
  } catch (err) {
    log("warn", `[abyss-queue] 写重启标记失败：${err?.message ?? err}`)
  }
}

function clearRestartFlag() {
  try {
    fs.rmSync(RESTART_FLAG, { force: true })
  } catch {
    /* 忽略 */
  }
}

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

  /**
   * 启动时清理过期的重启标记
   *
   * 标记由 `restartFramework()` 写下、由启动器读取并删除。若启动方式不走启动器
   * （例如直接 `node .`），标记会残留，下一次正常退出就可能被误判为"重启"。
   * 因此进程启动时若发现标记且已过期（超过 5 分钟），顺手清掉。
   */
  async init() {
    try {
      if (!fs.existsSync(RESTART_FLAG)) return
      const at = Number(fs.readFileSync(RESTART_FLAG, "utf8").trim())
      if (!at || Date.now() - at > 5 * 60 * 1000) {
        fs.rmSync(RESTART_FLAG, { force: true })
        log("mark", "[abyss-queue] 已清理过期的重启标记")
      }
    } catch {
      /* 忽略 */
    }
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
   * 触发重启（由启动器负责关闭旧窗口并拉起新窗口）
   *
   * 约定：本插件的启动器 `启动云崽与QQ.vbs` 在机器人退出后会检查
   * `data/restart.flag` 是否存在：存在则视为"重启"，先关掉旧窗口与 NapCat，
   * 再重新拉起两个服务，因此不会留下多余空窗口。
   *
   * 同时写框架的重启标记（`Yz:restart`），新进程上线后会在原会话回执「重启成功」。
   * 不直接调用 `Bot.restart()`：框架在 Windows 下用 `cmd /c start "" node .` 自拉起，
   * 会在新窗口之外留下旧窗口。
   */
  async restartFramework() {
    try {
      if (typeof Bot?.exit !== "function") throw new Error("当前环境没有 Bot.exit")
      writeRestartFlag()
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
      await Bot.exit()
      return true
    } catch (err) {
      clearRestartFlag()
      log("error", `[abyss-queue] 自动重启失败：${err?.message ?? err}`)
      return this.reply(`自动重启失败，请手动 #重启：${err?.message ?? err}`, true)
    }
  }
}
