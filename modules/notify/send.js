/**
 * 定时通知的发送编排（`modules/` = 业务编排层）
 *
 * 三条通知各做什么、"发什么内容"都在这里；`apps/queue.js` 的 `tick()` 只负责
 * 取表、算时间、落盘，然后把这一轮该发的交给这三个函数。
 *
 * 分工口径：
 *   - `lib/notify.js`：**纯函数**判断该不该发（去重状态 + 这一轮该发什么）
 *   - 本文件：把 `tickTasks()` 的结论变成群消息（编排）
 *   - `components/notify-send.js`：群号、@ 人、成员名单映射、逐群发送（工具）
 *
 * 三个函数都**无状态**（不读配置、不碰文件）：发不发由调用方决定，发什么由入参决定，
 * 因此可以脱离机器人单测。
 */
import { queuedInSheet } from "../../lib/notify.js"
import { nextPending } from "../../lib/progress.js"
import { log } from "../../components/logger.js"
import { joinLines, memberDirectory, mentionParts, sendToGroups } from "../../components/notify-send.js"

/**
 * 榜开启提醒：某个榜翻到「已开启」时，把该榜还在排队的人 @ 一遍
 *
 * @param {Array<object>} models 当前各榜模型（取"排队中"的人）
 * @param {string[]} sheets 这一轮刚翻到已开启的榜（`tickTasks` 判的 false→true）
 * @param {number[]} groups 发到哪些群
 */
export async function notifyOpenSheets(models, sheets, groups) {
  if (!sheets.length) return
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
      await sendToGroups(
        [gid],
        joinLines([
          [`【${name}】开榜了！还在排队的有 ${queue.length} 人（下面这些还没轮到，请留意自己的顺序）：`],
          lines,
        ]),
      )
    }
    log("info", `[abyss-queue] 已提醒「${name}」开榜（${queue.length} 人还在排队）`)
  }
}

/**
 * 完成情况轮询：谁刚刚完成了，就 @ 他后面第一个还在排队的人
 *
 * @param {Array<object>} models 当前各榜模型
 * @param {Array<{sheet,row,seq,nickname}>} done 这一轮「上次没完成 → 这次完成了」的人
 * @param {number[]} groups 发到哪些群
 */
export async function notifyCompletions(models, done, groups) {
  if (!done.length) return
  for (const gid of groups) {
    const dir = await memberDirectory(gid)
    const lines = []
    for (const item of done) {
      const model = models.find(m => m.name === item.sheet)
      const following = model ? nextPending(model, item.row) : null
      if (!following) continue
      lines.push([
        `【${item.sheet}】第 ${item.seq} 位「${item.nickname}」已完成 → 下一位 `,
        ...mentionParts(following.nickname, dir),
        `（第 ${following.seq ?? following.row} 位）请准备`,
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
