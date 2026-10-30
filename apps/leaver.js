/**
 * `#退队 <榜>` / `#退队 全部`：取消自己在某榜（或全部榜）的排队
 *
 * 权限：**只处理调用者自己**，不看白名单；管理员也不能借这条指令退别人的队。
 * 参数：一次只收一个榜名；`全部` 是唯一的批量写法，`#退队 危战 剧诗` 直接回用法。
 * 执行：先让编辑器清行，再让编辑器立刻整理；插件不写表。
 */
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { log } from "../components/logger.js"
import { insertTargetRow } from "../modules/queue.js"
import { isDone } from "../modules/progress.js"
import { resolveSheet, sheetChoices } from "../modules/router.js"
import { leaveRow, tidySheet } from "../model/leave-row.js"
import { AppBase } from "../components/base.js"

const USAGE = "用法：#退队 <榜>（一次一个榜）或 #退队 全部"

export class AbyssQueueLeave extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        {
          reg: /^#退队(?:\s|$)/,
          fnc: "leave",
          permission: "all",
          log: true,
        },
      ],
    })
  }

  async leave() {
    return this.safe(async () => {
      const rest = String(this.e?.msg ?? "").replace(/^#退队\s*/, "").trim()
      if (!rest || /\s/.test(rest)) return this.reply(USAGE)

      const models = await this.models({ force: true })
      const all = rest === "全部"
      let wanted
      if (all) {
        wanted = sheetChoices(models)
      } else {
        const sheet = resolveSheet(rest, models)
        if (!sheet) return this.reply(`没找到「${rest}」这个榜；${USAGE}`)
        wanted = [sheet]
      }

      const qq = String(this.e?.user_id ?? "").trim()
      /** 与 #排队 同一套候选：群名片 → 群名单昵称 → QQ 名牌；只信第一个会漏掉改过名片的人 */
      const names = [...new Set(this.nicknames().map(s => String(s ?? "").trim()).filter(Boolean))]
      const nick = names[0] ?? qq
      const store = await this.store()
      const done = []
      const completed = []
      const missing = []
      const failed = []

      const findOwnRow = (model, sheet) => {
        for (const name of names) {
          const hit = insertTargetRow(model, store, sheet, qq, "", name)
          if (hit.ok) return hit
        }
        return insertTargetRow(model, store, sheet, qq, "", "")
      }

      for (const sheet of wanted) {
        const model = models.get(sheet)
        if (!model) {
          missing.push({ sheet, reason: "表里没有这个榜" })
          continue
        }
        const hit = findOwnRow(model, sheet)
        if (!hit.ok) {
          missing.push({ sheet, reason: "没在这个榜排队" })
          continue
        }
        /** 回话用**队列序号**，不是工作表行号：空行很多时第 13 行也可能是第 1 位 */
        const item = model.rows.find(r => r.row === hit.row)
        const seq = String(item?.seq ?? "").trim() || String(hit.row)
        /** 已完成（主播打完 / 本人已完成）不允许退队，只提示 */
        if (isDone(item?.status)) {
          completed.push({ sheet, seq, status: String(item?.status ?? "").trim(), nickname: hit.nickname })
          continue
        }
        try {
          await leaveRow({ caller: { qq, nick: hit.nickname || nick }, sheet, row: hit.row })
          done.push({ sheet, row: hit.row, seq, nickname: hit.nickname })
        } catch (err) {
          log("warn", `[abyss-queue] 退队失败（${sheet} 第 ${hit.row} 行）：${err?.message ?? err}`)
          failed.push({ sheet, reason: String(err?.message ?? err) })
        }
      }

      if (done.length) await tidySheet(all ? "" : done[0].sheet)

      const lines = []
      for (const r of done) lines.push(`· ${r.sheet}：已退出（原第 ${r.seq} 位，${r.nickname || nick}）`)
      for (const r of completed) lines.push(`· ${r.sheet}：已完成（原第 ${r.seq} 位），不予退队`)
      for (const r of missing) lines.push(`· ${r.sheet}：没有退（${r.reason}）`)
      for (const r of failed) lines.push(`· ${r.sheet}：没退成（${r.reason}）`)
      const head = done.length
        ? all
          ? `已退出全部可退的榜（${done.length} 个）`
          : `已退出「${done[0].sheet}」的排队`
        : completed.length
          ? "该行已完成，不能退队"
          : "没有可退的排队"
      return this.reply([head, ...lines].join("\n"))
    })
  }
}
