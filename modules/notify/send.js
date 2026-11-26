/** 定时通知的发送编排（`modules/` = 业务编排层） */
import { queuedInSheet } from "../notify.js"
import { nextPending, QUEUED } from "../progress.js"
import { config } from "../../components/config.js"
import { log } from "../../components/logger.js"
import { readAnchorNames } from "../../model/anchor-names.js"
import { at, joinLines, memberDirectory, mentionParts, qqOfAnchor, sendToGroups } from "../../components/notify-send.js"

const openAnchorLine = (model, dir, names) => {
  const anchors = (model?.anchors ?? []).map(a => String(a?.name ?? "").trim()).filter(Boolean)
  if (!anchors.length) return null
  const parts = [`本榜主播：`]
  const missed = []
  anchors.forEach((name, i) => {
    const qq = qqOfAnchor(dir, name, names)
    if (i) parts.push("、")
    if (qq) parts.push(at(qq, name))
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

export async function notifyOpenSheets(models, sheets, groups, now = new Date()) {
  if (!sheets.length) return
  const atTime = now instanceof Date ? now : new Date(now)
  const pad = n => String(n).padStart(2, "0")
  const when = `${atTime.getFullYear()}-${pad(atTime.getMonth() + 1)}-${pad(atTime.getDate())} ${pad(atTime.getHours())}:${pad(atTime.getMinutes())}`
  const withAnchors = config.notify?.open_anchor !== false
  const names = withAnchors ? readAnchorNames() : {}
  for (const name of sheets) {
    const model = models.find(m => m.name === name)
    const queue = model ? queuedInSheet(model) : []
    if (!queue.length) {
      log("info", `[abyss-queue]「${name}」已开启，但还没有人排队，不提醒`)
      continue
    }
    for (const gid of groups) {
      const dir = await memberDirectory(gid)
      const queueLine = [`当前仍有 ${queue.length} 人排队：`]
      queue.forEach((r, i) => {
        if (i) queueLine.push("、")
        const qq = dir.get(String(r.nickname ?? "").trim())
        queueLine.push(qq ? at(qq, r.nickname) : String(r.nickname ?? "").trim())
      })
      const anchors = withAnchors ? openAnchorLine(model, dir, names) : null
      await sendToGroups(
        [gid],
        joinLines([
          [`【${name}】开榜提醒`],
          [`开榜时间：${when}`],
          queueLine,
          ["请留意自己的顺序。"],
          ...(anchors ? [anchors] : []),
        ]),
      )
    }
    log("info", `[abyss-queue] 已提醒「${name}」开榜（${queue.length} 人还在排队）`)
  }
}

const ANY_ANCHOR = "公共队列"

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
    if (qq) parts.push(at(qq, name))
    else {
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

const anchorLineOf = (row, dir, names) => {
  const parts = anchorMentions(row, dir, names)
  return parts ? ["主播：", ...parts] : null
}

export async function notifyCompletions(models, done, groups) {
  if (!done.length) return
  const names = readAnchorNames()
  for (const gid of groups) {
    const dir = await memberDirectory(gid)
    const lines = []
    for (const item of done) {
      const model = models.find(m => m.name === item.sheet)
      const following = model ? nextPending(model, item.row, { wrap: true }) : null
      if (!following) continue
      const name = String(following.nickname ?? "").trim()
      if (lines.length) lines.push([])
      lines.push([`【${item.sheet}】第 ${item.seq} 位「${item.nickname}」已完成`])
      lines.push(["下一位：", name])
      const anchor = anchorLineOf(following, dir, names)
      if (anchor) lines.push(anchor)
    }
    if (lines.length) await sendToGroups([gid], joinLines(lines))
  }
}

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
