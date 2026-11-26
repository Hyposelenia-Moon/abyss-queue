/** 主播直播：刷新编排、视图查询、开播提醒 */
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { config } from "../components/config.js"
import { parseEntries } from "../components/live-entry.js"
import { log } from "../components/logger.js"
import { at, joinLines, memberDirectory, qqOfRow, sendToGroups } from "../components/notify-send.js"
import { isLiveAlertOn } from "../model/live-alerts.js"
import { liveStatus } from "../model/live-status.js"
import { isPending } from "./progress.js"

const aliases = () => compileAliases(config.anchor_aliases)

const anchorMatches = (value, name, aliasMap = aliases()) => {
  const want = canonicalAnchor(name, aliasMap)
  return String(value ?? "")
    .split(/[,，、]/)
    .map(s => s.trim())
    .filter(Boolean)
    .some(part => canonicalAnchor(part, aliasMap) === want)
}

export const liveLookup = entry => (config.anchor_live?.enable ? liveStatus.lookup(entry) : null)

export const refreshAnchorLiveDetailed = (models, at = Date.now(), opts = {}) => liveStatus.refreshDetailed(models, at, opts)

export const takeAnchorLiveStarted = () => liveStatus.takePending()

export function liveLinesForMenu(models, active, status = liveStatus) {
  if (!config.anchor_live?.enable) return ""
  const aliasMap = aliases()
  const lines = []
  const seen = new Set()
  for (const item of active ?? []) {
    const model = Array.isArray(models) ? models.find(m => m.name === item.sheet) : models?.get?.(item.sheet)
    if (!model) continue
    for (const part of String(item.anchor ?? "")
      .split(/[,，、]/)
      .map(s => s.trim())
      .filter(Boolean)) {
      const anchor = (model.anchors ?? []).find(a => canonicalAnchor(a.name, aliasMap) === canonicalAnchor(part, aliasMap))
      if (!anchor) continue
      for (const entry of parseEntries(anchor.entry)) {
        const live = status.lookup(entry)
        if (!live || live.state !== "live") continue
        if (seen.has(live.roomId)) continue
        seen.add(live.roomId)
        lines.push(`你的主播「${anchor.name}」正在直播：${live.link}`)
      }
    }
  }
  return lines.join("\n")
}

export function liveStatusLines(models, lookup = entry => liveStatus.lookup(entry)) {
  const merged = new Map()
  for (const model of models ?? []) {
    for (const anchor of model?.anchors ?? []) {
      const name = String(anchor?.name ?? "").trim()
      if (!name) continue
      const labels = new Set()
      for (const entry of parseEntries(anchor.entry)) {
        if (!entry.roomId && !entry.uid) continue
        const live = lookup(entry)
        if (live?.label) labels.add(live.label)
      }
      if (!labels.size) continue
      const row = merged.get(name) ?? new Set()
      for (const label of labels) row.add(label)
      merged.set(name, row)
    }
  }
  return [...merged].map(([name, labels]) => `${name}：${[...labels].join(" / ")}`)
}

export async function notifyAnchorLive(
  started,
  models,
  { groups = [], store = null, status = liveStatus, directory = memberDirectory, send = sendToGroups } = {},
) {
  if (!started?.length || !groups.length) return 0
  if (config.anchor_live?.push === false) return 0
  const aliasMap = aliases()
  const targets = []
  for (const s of started) {
    for (const model of models) {
      for (const anchor of model.anchors ?? []) {
        const hit = parseEntries(anchor.entry).some(e => status.roomOf(e) === s.roomId)
        if (hit) targets.push({ model, anchor, roomId: s.roomId })
      }
    }
  }
  if (!targets.length) return 0
  let sent = 0
  for (const gid of groups) {
    const dir = await directory(gid)
    const blocks = []
    for (const { model, anchor, roomId } of targets) {
      const rows = (model.rows ?? []).filter(r => isPending(r.status) && anchorMatches(r.anchor, anchor.name, aliasMap))
      const mentions = []
      const seen = new Set()
      for (const row of rows) {
        const qq = qqOfRow(dir, { store, sheet: model.name, row: row.row, nickname: row.nickname })
        if (!qq || seen.has(qq) || !isLiveAlertOn(qq, anchor.name)) continue
        seen.add(qq)
        mentions.push(at(qq, row.nickname))
      }
      if (!mentions.length) continue
      blocks.push([
        `【${model.name}】主播「${anchor.name}」已开播，请 `,
        ...mentions.flatMap((m, i) => (i ? ["、", m] : [m])),
        " 注意",
      ])
      blocks.push([`https://live.bilibili.com/${roomId}`])
    }
    if (!blocks.length) continue
    const lines = []
    for (const block of blocks) {
      if (lines.length) lines.push([])
      lines.push(block)
    }
    await send([gid], joinLines(lines))
    sent++
  }
  if (sent) log("info", `[abyss-queue] 主播开播提醒已发送：${started.length} 个直播间`)
  return sent
}
