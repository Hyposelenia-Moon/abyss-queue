/**
 * 定时通知的发送编排（`modules/` = 业务编排层）
 *
 * 三条通知各做什么、"发什么内容"都在这里；`apps/queue.js` 的 `tick()` 只负责
 * 取表、算时间、落盘，然后把这一轮该发的交给这三个函数。
 *
 * 分工口径：
 *   - `modules/notify.js`：**纯函数**判断该不该发（去重状态 + 这一轮该发什么）
 *   - 本文件：把 `tickTasks()` 的结论变成群消息（编排）
 *   - `components/notify-send.js`：群号、@ 人、成员名单映射、逐群发送（工具）
 *
 * 三个函数都**无状态**（不读配置、不碰文件）：发不发由调用方决定，发什么由入参决定，
 * 因此可以脱离机器人单测。
 */
import { queuedInSheet } from "../notify.js"
import { nextPending, QUEUED } from "../progress.js"
import { config } from "../../components/config.js"
import { log } from "../../components/logger.js"
import { readAnchorNames } from "../../model/anchor-names.js"
import { at, joinLines, memberDirectory, mentionParts, qqOfAnchor, qqOfRow, sendToGroups } from "../../components/notify-send.js"

/**
 * 开榜播报末尾那一行：**@ 这一榜的主播**
 *
 * 「这一榜的主播」= 这一榜**主播区**里列着的那几位（表头上方 A 列，与 `#主播` 是同一份名单）——
 * 维护者定的口径就是"该榜的所有主播"，不按「专职」那一列再筛一遍（专职是给人看的说明）。
 * 名字与群里不一致的（表里叫 A、群里叫 B）走 `data/anchor-names.json` 的映射；
 * 两边都对不上就**只写名字**并记一条 info（与"下一位"同一条纪律：不瞎 @、更不 @ 全体）。
 *
 * @param {object} model 这一榜的模型（`model.anchors` = 主播区）
 * @param {Map<string,string>} dir 群名单：群昵称 → QQ
 * @param {Record<string,string>} names 主播名映射（`readAnchorNames()`）
 * @returns {Array|null} 消息片段；这一榜没有主播时返回 null（不加这一行）
 */
const openAnchorLine = (model, dir, names) => {
  const anchors = (model?.anchors ?? []).map(a => String(a?.name ?? "").trim()).filter(Boolean)
  if (!anchors.length) return null
  const parts = [`本榜主播：`]
  const missed = []
  anchors.forEach((name, i) => {
    const qq = qqOfAnchor(dir, name, names)
    if (i) parts.push("、")
    /** 能对上 QQ 就 @ 他（后面括上表里的名字，免得群里对不上号） */
    if (qq) parts.push(at(qq), `（${name}）`)
    else {
      parts.push(name)
      missed.push(name)
    }
  })
  if (missed.length)
    log(
      "info",
      `[abyss-queue]「${model.name}」开榜播报里没能 @ 这几位主播：${missed.join("、")}` +
        `（data/anchor-names.json 里没登记、群名单里也没这个名字——只写了名字）`,
    )
  return parts
}

/**
 * 榜开启提醒：某个榜翻到「已开启」时，把该榜还在排队的人 @ 一遍
 *
 * 末尾还有一行「本榜主播：@…」——开榜了该干活的是主播，不是等着排队的人；
 * 这一行由 `notify.open_anchor` 开关（锅巴里可关），名字映射见 `data/anchor-names.json`。
 *
 * @param {Array<object>} models 当前各榜模型（取"排队中"的人）
 * @param {string[]} sheets 这一轮刚翻到已开启的榜（`tickTasks` 判的 false→true）
 * @param {number[]} groups 发到哪些群
 */
export async function notifyOpenSheets(models, sheets, groups) {
  if (!sheets.length) return
  const withAnchors = config.notify?.open_anchor !== false
  const names = withAnchors ? readAnchorNames() : {}
  for (const name of sheets) {
    const model = models.find(m => m.name === name)
    const queue = model ? queuedInSheet(model) : []
    /** 开了但还没人排队：不 @ 人也不刷屏，只记一条日志（真到有人时会有"上一位完成 @ 下一位"接上） */
    if (!queue.length) {
      log("info", `[abyss-queue]「${name}」已开启，但还没有人排队，不提醒`)
      continue
    }
    for (const gid of groups) {
      const dir = await memberDirectory(gid)
      const lines = queue.map((r, i) => {
        const parts = [i ? "、" : ""]
        parts.push(...mentionParts(r.nickname, dir))
        return parts
      })
      /** 名单后面接一行主播（没有主播的榜不加；开关关掉时也不加） */
      const anchors = withAnchors ? openAnchorLine(model, dir, names) : null
      await sendToGroups(
        [gid],
        joinLines([
          [`【${name}】开榜了！还在排队的有 ${queue.length} 人（下面这些还没轮到，请留意自己的顺序）：`],
          lines,
          /** 名单与主播那一行之间空一行（`[]` 那一项就是那个空行） */
          ...(anchors ? [[], anchors] : []),
        ]),
      )
    }
    log("info", `[abyss-queue] 已提醒「${name}」开榜（${queue.length} 人还在排队）`)
  }
}

/**
 * 「都可以」= 谁接都行，**不是某位主播** —— 完成播报里遇到它就不写「主播：…」那一句
 * （与编辑器里那个互斥值同一个字符串，见 `editor/editor.mjs` 的 `EXCLUSIVE_VALUES`）
 */
const ANY_ANCHOR = "都可以"

/**
 * 「下一位」「被改回排队」两处共用的**主播提及片段**：表里那一格写的主播 → @ 谁
 *
 * 一格里有多位（逗号分隔）时逐个来；对不上 QQ 的只写名字并记一条 info
 * （与开榜播报同一条纪律：不瞎 @、更不 @ 全体）。
 * 该格是「都可以」或空着 ⇒ 返回 null（调用方据此**整句不写 / 不 @**）。
 *
 * @param {object} row 那一行（读它的 `anchor`）
 * @param {Map<string,string>} dir 群名单：群昵称 → QQ
 * @param {Record<string,string>} names 主播名映射（`data/anchor-names.json`）
 * @returns {Array|null} 片段数组（`@qq`、名字、分隔的「、」）；没有可提的人时 null
 */
const anchorMentions = (row, dir, names) => {
  const tokens = String(row?.anchor ?? "")
    .split(/[,，、]/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(t => t !== ANY_ANCHOR)
  if (!tokens.length) return null
  const parts = []
  const missed = []
  tokens.forEach((name, i) => {
    if (i) parts.push("、")
    const qq = qqOfAnchor(dir, name, names)
    if (qq) {
      parts.push(at(qq))
      /** 表里名字与群里名字不一样时才括注（一样时只是噪音） */
      const shown = String(names?.[name] ?? name)
      if (shown !== name) parts.push(`（${name}）`)
    } else {
      parts.push(name)
      missed.push(name)
    }
  })
  if (missed.length)
    log(
      "info",
      `[abyss-queue] 完成情况播报里没能 @ 这几位主播：${missed.join("、")}` +
        `（data/anchor-names.json 里没登记、群名单里也没这个名字——只写了名字）`,
    )
  return parts
}

/**
 * 完成播报里的「主播：@…」那一行（没有可提的人就整行不写）
 *
 * 维护者模板（2026-10-18）：「xxx已完成，下一位@xxx，主播@xxx。若选择主播为都可以，则取消最后一句」。
 * 主播从**下一位那一行**的「选择主播」格取（他选的是谁，就该 @ 谁）；「都可以」= 谁接都行，
 * 不是某位主播 ⇒ 这一句不写。
 */
const anchorLineOf = (row, dir, names) => {
  const parts = anchorMentions(row, dir, names)
  return parts ? ["主播：", ...parts] : null
}

/**
 * 完成情况轮询：谁刚刚完成了，就 @ 他后面第一个还在排队的人
 *
 * **一块三行、块与块之间空一行**（2026-10-18 维护者：「播报文字会有堆叠感，重点不突出」）：
 *
 *   【深境螺旋】第 3 位「甲」已完成
 *   下一位：@乙（第 4 位）请准备
 *   主播：@丙
 *
 * 原来是「…已完成 → 下一位 乙（第 4 位）请准备 @乙」一整句：谁完成、谁接、主播是谁全糊在
 * 同一行里，@ 对象还落在句尾，群里一眼看不出重点。现在三件事各占一行；
 * 第三行来自**下一位那一行**的「选择主播」，是「都可以」或空着就不写（见 `anchorLineOf`）。
 * @ 人优先这一行的**绑定**（`QQ → 行` 反查），其次群名单按昵称查；两边都拿不到就只写名字、
 * **不发 @**——不瞎 @，更不 @ 全体。
 *
 * @param {Array<object>} models 当前各榜模型
 * @param {Array<{sheet,row,seq,nickname}>} done 这一轮「上次没完成 → 这次完成了」的人
 * @param {number[]} groups 发到哪些群
 * @param {object} [opts]
 * @param {object} [opts.store] 绑定库（QQ → 行）：@ 下一位时优先按行反查 QQ
 */
export async function notifyCompletions(models, done, groups, { store } = {}) {
  if (!done.length) return
  const names = readAnchorNames()
  for (const gid of groups) {
    const dir = await memberDirectory(gid)
    const lines = []
    for (const item of done) {
      const model = models.find(m => m.name === item.sheet)
      const following = model ? nextPending(model, item.row) : null
      if (!following) continue
      const name = String(following.nickname ?? "").trim()
      const qq = qqOfRow(dir, { store, sheet: item.sheet, row: following.row, nickname: name })
      /** 块与块之间空一行（`[]` 那一项就是那个空行，与开榜播报同一写法） */
      if (lines.length) lines.push([])
      lines.push([`【${item.sheet}】第 ${item.seq} 位「${item.nickname}」已完成`])
      lines.push(["下一位：", ...(qq ? [at(qq)] : [name]), `（第 ${following.seq ?? following.row} 位）请准备`])
      const anchor = anchorLineOf(following, dir, names)
      if (anchor) lines.push(anchor)
    }
    if (lines.length) await sendToGroups([gid], joinLines(lines))
  }
}

/**
 * **被改回排队**的补充播报（2026-10-18 维护者：「若已完成状态（包含本人或主播完成）变为排队中，
 * 则补充播报：xxx完成情况由已完成变为排队中，请主播@xxx注意，若完成情况为都可以则不艾特主播」）
 *
 *   【深境螺旋】第 3 位「甲」的完成情况由「已完成」变为「排队中」，请主播 @丙 注意
 *
 * 主播取**被改的那一行**自己选的主播（他原来找的是谁，就让谁注意）；该格是「都可以」或空着 ⇒
 * 照样说这一句，但**不 @ 任何人**（`都可以` = 谁接都行，@ 谁都不对）。
 * 与完成播报一样：一块一行、块与块之间空一行。
 *
 * @param {Array<object>} models 当前各榜模型（要按行号取回那一行的「选择主播」）
 * @param {Array<{sheet,row,seq,nickname,status}>} reverts 这一轮「完成了 → 又变回排队中」的人
 * @param {number[]} groups 发到哪些群
 */
export async function notifyReverts(models, reverts, groups) {
  if (!reverts?.length) return
  const names = readAnchorNames()
  for (const gid of groups) {
    const dir = await memberDirectory(gid)
    const lines = []
    for (const item of reverts) {
      const model = models.find(m => m.name === item.sheet)
      const row = model?.rows?.find(r => r.row === item.row) ?? null
      const nick = String(item.nickname ?? row?.nickname ?? "").trim()
      const mentions = anchorMentions(row, dir, names)
      const head = `【${item.sheet}】第 ${item.seq} 位「${nick}」的完成情况由「已完成」变为「${item.status || QUEUED}」`
      if (lines.length) lines.push([])
      lines.push(mentions ? [head, "，请主播 ", ...mentions, " 注意"] : [head, "，请主播注意"])
    }
    if (lines.length) await sendToGroups([gid], joinLines(lines))
  }
}

/**
 * 月末催办：每月最后一天（到 `notify.monthly_at` 之后）把还在排队的人 @ 一遍
 *
 * "是不是月末""今天发过没有"都在 `tickTasks` 里判完了：这里只负责把内容发出去，
 * 所以不依赖 cron 方言的 L 写法，也不怕重启。
 *
 * @param {{sheets: Array<{sheet, rows}>, day: string}} plan 要发的内容
 * @param {number[]} groups 发到哪些群
 */
export async function notifyMonthly(plan, groups) {
  for (const gid of groups) {
    const dir = await memberDirectory(gid)
    const lines = plan.sheets.map(p => {
      const parts = [`【${p.sheet}】还有 ${p.rows.length} 人：`]
      p.rows.forEach((r, i) => {
        if (i) parts.push("、")
        parts.push(...mentionParts(r.nickname, dir))
      })
      return parts
    })
    await sendToGroups(
      [gid],
      joinLines([["【三路深渊排队】本月最后一天了，还没轮到的记得盯一下进度："], ...lines]),
    )
  }
}
