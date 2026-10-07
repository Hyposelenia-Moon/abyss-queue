/**
 * `#插队`：把"已经排队的某个人"往前挪一位（越过他前面最近的那一位「排队中」）
 *
 * **只有白名单管理员能用**：权限在 handler 里按 QQ 现查（`model/whitelist.js`，那份文件与编辑器
 * 共用一份），不看框架的 `permission`——规则本身对所有人注册，拦不住才是安全的默认。
 *
 * 三件事按这个顺序做：
 *   1. 鉴权：不是主人 / 白名单管理员，一个字都不查，直接回拒绝；
 *   2. 解析：默认作用于**调用者自己**；`#插队 <群昵称>`（管理能力）可指定别人；
 *      默认处理**他在排队的每一个榜**，带榜名就只处理那一个；
 *   3. 执行：只把"哪一榜、哪一行、怎么挪"交给编辑器（`model/move-row.js`）——
 *      **插件不写表**，位置由编辑器算，算不出就整表不动并回一句原因。
 */
import { PLUGIN_DSC, PLUGIN_NAME, SHEET_ALIASES } from "../components/constants.js"
import { log } from "../components/logger.js"
import { moveRow } from "../model/move-row.js"
import { isManagerQq } from "../model/whitelist.js"
import { insertTargetRow, matchInsertCommand } from "../modules/queue.js"
import { resolveSheet, sheetChoices, ValidationError } from "../modules/router.js"
import { AppBase } from "../components/base.js"

/** 表里表示"正在排队"的那个状态（与编辑器同一份口径，见 editor/editor.mjs 的 QUEUED_STATUS） */
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
          /**
           * `#插队 [<群昵称>] [<榜>]`：**管理员专用**，但权限在 `insert()` 里现查白名单。
           * 不动 `#排队` 那条规则，也不抢别人的命令空间。
           */
          reg: /^#插队(?:\s|$)/,
          fnc: "insert",
          permission: "all",
          log: true,
        },
      ],
    })
  }

  /** `#插队` 的入口：鉴权 → 定人与榜 → 逐榜交给编辑器 */
  async insert() {
    return this.safe(async () => {
      const qq = String(this.e?.user_id ?? "").trim()
      if (!isManagerQq(qq))
        return this.reply("插队是白名单管理员的能力：你不是白名单里的人，这个指令什么都不会改")

      const parsed = matchInsertCommand(this.e.msg)
      const { sheetArg, nick } = this.splitArg(parsed?.rest ?? "")
      const models = await this.models()
      /** 带榜名只处理那一个；不带就在他排队的所有榜上各试一次（编辑器会跳过"本来就在最前面"的） */
      const wanted = sheetArg ? [this.resolveTargetSheet(sheetArg, models)] : sheetChoices(models)
      const report = await this.planInsert({ models, wanted, qq, nick })
      return this.reply(this.describe(report, { qq, nick }))
    })
  }

  /**
   * 拆参数：第一段能当榜名（全名 / 简称 / 序号）就按榜名算，剩下的整段当群昵称
   *
   * 群昵称里允许有空格（"阿修 Axiu"这类），所以只按**空格切一次**，后面原样保留。
   * `#插队 危战` 里的"危战"是榜名不是人名——与 `#排队 危战` 同一条口径。
   * @param {string} rest `#插队` 之后的原文
   */
  splitArg(rest) {
    const text = String(rest ?? "").trim()
    if (!text) return { sheetArg: "", nick: "" }
    const [first, ...others] = text.split(/\s+/)
    /** 认不出来的一律当群昵称：`#插队 甲` 里的"甲"不是榜名，`#插队 2 甲` 里的"2"是 */
    const isSheet = /^\d+$/.test(first) || Object.prototype.hasOwnProperty.call(SHEET_ALIASES, first)
    return isSheet ? { sheetArg: first, nick: others.join(" ").trim() } : { sheetArg: "", nick: text }
  }

  /** 带榜名时解析成表名；解析不出来就按用户输入错误回话（不写表、不调接口） */
  resolveTargetSheet(arg, models) {
    const sheet = resolveSheet(arg, models)
    if (!sheet)
      throw new ValidationError(`没找到「${String(arg ?? "").trim()}」这个榜；现有：${sheetChoices(models).join("、")}`)
    return sheet
  }

  /**
   * 这一榜里"这个名字那一行"归哪个 QQ（反查绑定；找不到返回空串）
   *
   * 只在**唯一命中同名的行**上回答：表里两行同名时无从判断是哪一个，回空串让调用方按普通路径处理
   * （那条路会回"有两行同名，请带上榜名"）。
   */
  qqAtRow(store, sheet, model, nick) {
    const target = String(nick ?? "").trim()
    if (!target) return ""
    const rows = model.rows.filter(r => String(r.nickname ?? "").trim() === target)
    if (rows.length !== 1) return ""
    const owners = typeof store?.qqsOf === "function" ? store.qqsOf(sheet, rows[0].row) : []
    return owners.length === 1 ? owners[0] : ""
  }

  /** 这个 QQ 在绑定里记的昵称，与表里那一行现在的昵称是不是同一个人（对不上账就别动这一行） */
  bindingMatches(store, sheet, qq, nickname) {
    const info = store?.get?.(sheet, qq)
    if (!info) return false
    return String(info.nickname ?? "").trim() === String(nickname ?? "").trim()
  }

  /**
   * 逐榜算出"要不要挪、怎么挪"，再把要挪的交给编辑器
   *
   * 分类判据都在**同一份快照**上（`AppBase.models()`）：插件只负责"看着像能挪才去调接口"，
   * 真正的位置由编辑器算——它算不出来会整表不动并回一句原因，插件照原样回话。
   * @returns {Promise<{ok: Array, notFront: Array, missing: Array, failed: Array}>}
   */
  async planInsert({ models, wanted, qq, nick }) {
    const store = await this.store()
    const ok = []
    const notFront = []
    const missing = []
    const failed = []

    for (const sheet of wanted) {
      const model = models.get(sheet)
      if (!model) {
        missing.push({ sheet, reason: "表里没有这个榜" })
        continue
      }
      /**
       * 指名了谁就以**那位**为准
       *
       * 从绑定里反查"这一行归谁"：查得出来就把他当成目标 QQ（`insertTargetRow` 的归属校验认这个）。
       * **查不出来（或那一行上挂着对不上账的旧绑定）就不动**——那正是"表被外部改过、归属还没对账"
       * 的样子，按名字硬挪等于把别人那一行挪走。宁可回一句没动，让本人先打开一次填表页把归属对回来。
       * 自己那一档不走这条：`insertTargetRow` 已经用绑定认过人了，再查一遍只会把"按名片兜底认出来"
       * 的情况也误关掉。
       */
      const ownerQq = nick ? this.qqAtRow(store, sheet, model, nick) : ""
      const targetQq = nick ? ownerQq || qq : qq
      const hit = insertTargetRow(model, store, sheet, targetQq, nick, this.nickname())
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
      /** 上方没有「排队中」的人 ⇒ 什么都不做（**连接口都不调**，这条口径由套件钉住） */
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
        if (out?.moved) ok.push({ sheet, ...out })
        else notFront.push({ sheet, row: hit.row, nickname: hit.nickname, reason: out?.reason ?? "" })
      } catch (err) {
        log("warn", `[abyss-queue] 插队失败（${sheet} 第 ${hit.row} 行）：${err?.message ?? err}`)
        failed.push({ sheet, reason: String(err?.message ?? err) })
      }
    }
    return { ok, notFront, missing, failed }
  }

  /**
   * 回话：说清"把谁挪到了第几位 / 为什么没动"
   *
   * 每条都点名是哪个榜（一次 `#插队` 可能同时动好几个榜），失败那几条点明原因，
   * 但只写一句话的原因——编辑器返回的原始响应进日志，不进群消息。
   */
  describe({ ok, notFront, missing, failed }, { qq, nick }) {
    const who = nick ? `「${nick}」` : String(qq) === String(this.e?.user_id ?? "") ? "你" : `「${qq}」`
    const lines = []
    for (const r of ok) lines.push(`${r.sheet}：把「${r.nickname}」从第 ${r.from} 位挪到第 ${r.to} 位（越过「${r.crossed}」）`)
    for (const r of notFront)
      lines.push(`${r.sheet}：${r.nickname ? `「${r.nickname}」` : who}已经在最前面，没有动${r.reason ? `（${r.reason}）` : ""}`)
    for (const r of missing) lines.push(`${r.sheet}：没有动（${r.reason}）`)
    for (const r of failed) lines.push(`${r.sheet}：没改成（${r.reason}）`)

    const head = ok.length ? `插队完成：${who}往前挪了 ${ok.length} 个榜` : `${who}没有被挪动`
    return [head, ...lines.map(l => `· ${l}`), ok.length ? "发 #排队 可以确认新的顺序" : "发 #排队 可以看现在的队列"].join("\n")
  }
}
