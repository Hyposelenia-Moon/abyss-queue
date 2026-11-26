/** `#插队`：把"已经排队的某个人"挪到所有「排队中」的人最前面 */
import { PLUGIN_DSC, PLUGIN_NAME, SHEET_ALIASES } from "../components/constants.js"
import { log } from "../components/logger.js"
import { moveRow } from "../model/editor-commands.js"
import { isManagerQq } from "../model/whitelist.js"
import { insertTargetRow, matchInsertCommand } from "../modules/queue.js"
import { resolveSheet, sheetChoices, ValidationError } from "../modules/router.js"
import { AppBase } from "../components/base.js"

const QUEUED_STATUS = "排队中"

export class AbyssQueueInsert extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [
        {
          reg: /^#插队(?:\s|$)/,
          fnc: "insert",
          permission: "all",
          log: true,
        },
      ],
    })
  }
  async insert() {
    return this.safe(async () => {
      const qq = String(this.e?.user_id ?? "").trim()
      if (!isManagerQq(qq))
        return this.reply("插队是白名单管理员的能力：你不是白名单里的人，这个指令什么都不会改")
      const parsed = matchInsertCommand(this.e.msg)
      const { sheetArg, nick } = this.splitArg(parsed?.rest ?? "")
      const models = await this.models()
      const wanted = sheetArg ? [this.resolveTargetSheet(sheetArg, models)] : sheetChoices(models)
      const selfNames = [...new Set(this.nicknames().map(s => String(s ?? "").trim()).filter(Boolean))]
      const report = await this.planInsert({ models, wanted, qq, nick, selfNames })
      return this.reply(this.describe(report, { qq, nick }))
    })
  }
  splitArg(rest) {
    const text = String(rest ?? "").trim()
    if (!text) return { sheetArg: "", nick: "" }
    const [first, ...others] = text.split(/\s+/)
    const isSheet = /^\d+$/.test(first) || Object.prototype.hasOwnProperty.call(SHEET_ALIASES, first)
    return isSheet ? { sheetArg: first, nick: others.join(" ").trim() } : { sheetArg: "", nick: text }
  }
  resolveTargetSheet(arg, models) {
    const sheet = resolveSheet(arg, models)
    if (!sheet)
      throw new ValidationError(`没找到「${String(arg ?? "").trim()}」这个榜；现有：${sheetChoices(models).join("、")}`)
    return sheet
  }
  qqAtRow(store, sheet, model, nick) {
    const target = String(nick ?? "").trim()
    if (!target) return ""
    const rows = model.rows.filter(r => String(r.nickname ?? "").trim() === target)
    if (rows.length !== 1) return ""
    const owners = typeof store?.qqsOf === "function" ? store.qqsOf(sheet, rows[0].row) : []
    return owners.length === 1 ? owners[0] : ""
  }
  bindingMatches(store, sheet, qq, nickname) {
    const info = store?.get?.(sheet, qq)
    if (!info) return false
    return String(info.nickname ?? "").trim() === String(nickname ?? "").trim()
  }
  async planInsert({ models, wanted, qq, nick, selfNames = [] }) {
    const store = await this.store()
    const ok = []
    const notFront = []
    const missing = []
    const failed = []
    const names = [...new Set(selfNames.map(s => String(s ?? "").trim()).filter(Boolean))]
    for (const sheet of wanted) {
      const model = models.get(sheet)
      if (!model) {
        missing.push({ sheet, reason: "表里没有这个榜" })
        continue
      }
      const ownerQq = nick ? this.qqAtRow(store, sheet, model, nick) : ""
      const targetQq = nick ? ownerQq || qq : qq
      let hit = {}
      if (nick) {
        hit = insertTargetRow(model, store, sheet, targetQq, nick)
      } else {
        for (const name of names) {
          hit = insertTargetRow(model, store, sheet, qq, "", name, { ignoreBind: true })
          if (hit.ok) break
        }
        if (!hit.ok) hit = insertTargetRow(model, store, sheet, qq, "", names[0] ?? "")
      }
      if (hit.ok && nick && hit.source === "nickname" && (!ownerQq || !this.bindingMatches(store, sheet, targetQq, hit.nickname))) {
        missing.push({ sheet, nickname: nick, reason: "这一行的归属还没对上账，请先让本人打开一次填表页" })
        continue
      }
      if (!hit.ok) {
        missing.push({
          sheet,
          nickname: nick,
          reason: hit.ambiguous ? "这一榜里有两行同名，请带上榜名再发一次" : "没在这个榜排队",
        })
        continue
      }
      const person = model.rows.find(r => r.row === hit.row)
      if (String(person?.status ?? "").trim() !== QUEUED_STATUS) {
        missing.push({ sheet, nickname: hit.nickname, reason: `不是「${QUEUED_STATUS}」` })
        continue
      }
      const ahead = model.rows.some(
        r => r.row < hit.row && String(r.nickname ?? "").trim() && String(r.status ?? "").trim() === QUEUED_STATUS,
      )
      if (!ahead) {
        notFront.push({ sheet, row: hit.row, nickname: hit.nickname })
        continue
      }
      try {
        const out = await moveRow({
          caller: { qq: this.e.user_id, nick: this.nickname() },
          sheet,
          row: hit.row,
          nick: hit.nickname,
        })
        if (out?.moved) {
          if (store.remap(sheet, out.rowMap)) await store.save()
          ok.push({ sheet, ...out })
        }
        else notFront.push({ sheet, row: hit.row, nickname: hit.nickname, reason: out?.reason ?? "" })
      } catch (err) {
        log("warn", `[abyss-queue] 插队失败（${sheet} 第 ${hit.row} 行）：${err?.message ?? err}`)
        failed.push({ sheet, reason: String(err?.message ?? err) })
      }
    }
    return { ok, notFront, missing, failed }
  }
  describe({ ok, notFront, missing, failed }, { qq, nick }) {
    const who = nick ? `「${nick}」` : String(qq) === String(this.e?.user_id ?? "") ? "你" : `「${qq}」`
    const lines = []
    for (const r of ok) {
      const from = r.fromSeq ?? r.from
      const to = r.toSeq ?? r.to
      lines.push(`${r.sheet}：把「${r.nickname}」从第 ${from} 位挪到第 ${to} 位（排到最前面）`)
    }
    for (const r of notFront)
      lines.push(`${r.sheet}：${r.nickname ? `「${r.nickname}」` : who}已经在最前面，没有动${r.reason ? `（${r.reason}）` : ""}`)
    for (const r of missing) lines.push(`${r.sheet}：没有动（${r.reason}）`)
    for (const r of failed) lines.push(`${r.sheet}：没改成（${r.reason}）`)
    const head = ok.length
      ? nick
        ? `插队完成：已把「${nick}」排到 ${ok.length} 个榜的最前面`
        : `插队完成：你已在 ${ok.length} 个榜排到最前面`
      : `${who}没有被挪动`
    return [head, ...lines.map(l => `· ${l}`), ok.length ? "发 #排队 可以确认新的顺序" : "发 #排队 可以看现在的队列"].join("\n")
  }
}
