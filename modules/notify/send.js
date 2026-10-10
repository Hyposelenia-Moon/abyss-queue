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
import { nextPending } from "../progress.js"
import { config } from "../../components/config.js"
import { log } from "../../components/logger.js"
import { readAnchorNames } from "../../model/anchor-names.js"
import { at, joinLines, memberDirectory, mentionParts, qqOfAnchor, qqOfRow, sendToGroups } from "../../components/notify-send.js"

/**
 * 开榜播报末尾那一行：**@ 这一榜的主播**
 *
 * 「这一榜的主播」= 这一榜**主播区**里列着的那几位（表头上方 A 列，与 `#主播` 是同一份名单）——
 * 维护者定的口径就是"该榜的所有主播"，不按「专职」那一列再筛一遍（专职是给人看的说明）。
 * 名字与群里不一致的（表里「听雨」、群里「珀西瓦尔」）走 `data/anchor-names.json` 的映射；
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
 * 完成情况轮询：谁刚刚完成了，就 @ 他后面第一个还在排队的人
 *
 * 文案是「…已完成 → 下一位 <名字>（第 N 位）请准备」，**末尾再补一个 @ 下一位**：
 * 让 QQ 里显示成他的实际群昵称，人一眼知道该谁上了。名字本身照旧用表里那一行的群昵称
 * （这一列就是群昵称，群里对不上号的名字本来也该由名单同步去纠正）。
 * 拿不到 QQ（既没有绑定、群名单里也没有这个名字）时**只留名字、不发 @**——不瞎 @，更不 @ 全体。
 *
 * @param {Array<object>} models 当前各榜模型
 * @param {Array<{sheet,row,seq,nickname}>} done 这一轮「上次没完成 → 这次完成了」的人
 * @param {number[]} groups 发到哪些群
 * @param {object} [opts]
 * @param {object} [opts.store] 绑定库（QQ → 行）：@ 下一位时优先按行反查 QQ
 */
export async function notifyCompletions(models, done, groups, { store } = {}) {
  if (!done.length) return
  for (const gid of groups) {
    const dir = await memberDirectory(gid)
    const lines = []
    for (const item of done) {
      const model = models.find(m => m.name === item.sheet)
      const following = model ? nextPending(model, item.row) : null
      if (!following) continue
      const name = String(following.nickname ?? "").trim()
      const qq = qqOfRow(dir, { store, sheet: item.sheet, row: following.row, nickname: name })
      lines.push([
        `【${item.sheet}】第 ${item.seq} 位「${item.nickname}」已完成 → 下一位 `,
        name,
        `（第 ${following.seq ?? following.row} 位）请准备`,
        ...(qq ? [" ", at(qq)] : []),
      ])
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
