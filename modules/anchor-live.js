/**
 * 主播直播：刷新编排、视图查询、开播提醒
 *
 * 分工：
 *   - `model/live-status.js`：缓存 + B 站公开接口
 *   - 本文件：把"表里的主播区"与缓存对上，给 `#主播` / `#排队` 提供查询，并在开播时通知
 *
 * **只 @ 自己订阅过的人**（`#排队开播提醒`）：没人订阅时整条开播提醒不发，
 * 不做"先 @ 全体再说"这种事。开播判定与去重都在 live-status 里（首次只记基线）。
 */
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { config } from "../components/config.js"
import { parseEntries } from "../components/live-entry.js"
import { log } from "../components/logger.js"
import { at, joinLines, memberDirectory, qqOfRow, sendToGroups } from "../components/notify-send.js"
import { isLiveAlertOn } from "../model/live-alerts.js"
import { liveStatus } from "../model/live-status.js"
import { isPending } from "./progress.js"

const aliases = () => compileAliases(config.anchor_aliases)

/** 一个值里可能写着多位主播（逗号分隔），逐个归一再比 */
const anchorMatches = (value, name, aliasMap = aliases()) => {
  const want = canonicalAnchor(name, aliasMap)
  return String(value ?? "")
    .split(/[,，、]/)
    .map(s => s.trim())
    .filter(Boolean)
    .some(part => canonicalAnchor(part, aliasMap) === want)
}

/** 视图用：一条入口 → 状态（没有缓存 / 开关关掉时 null） */
export const liveLookup = entry => (config.anchor_live?.enable ? liveStatus.lookup(entry) : null)

/**
 * 刷新一轮状态
 * @returns {Promise<Array<{roomId:string, uid:string, live:number}>>} 刚开播的房间
 */
export const refreshAnchorLive = (models, at = Date.now(), opts = {}) => liveStatus.refresh(models, at, opts)

/** 取走自检命令/上一轮刷新攒下的开播事件，交给唯一 tick 发送 */
export const takeAnchorLiveStarted = () => liveStatus.takePending()

/**
 * `#排队` 图后面那一行"你的主播正在直播"
 *
 * 只在本人选中的主播里有 B 站状态为"直播中"时返回；多位主播同时开播时一行一条。
 * @param {Array} models
 * @param {Array<{sheet:string, anchor:string}>} active mineView().active
 * @returns {string} 可拼进文本段的若干行（没有就空串）
 */
export function liveLinesForMenu(models, active, status = liveStatus) {
  if (!config.anchor_live?.enable) return ""
  const aliasMap = aliases()
  const lines = []
  const seen = new Set()
  for (const item of active ?? []) {
    const model = Array.isArray(models) ? models.find(m => m.name === item.sheet) : models?.get?.(item.sheet)
    if (!model) continue
    /** 一行可能多选主播（逗号/顿号分隔）；逐个认，不能拿整串去比一个名字 */
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

/**
 * 自检用的合并视图：**同名主播跨榜只出一行**，状态去重。
 *
 * `#排队直播状态` 原来按「榜 · 主播」逐条输出，同一位主播在三个榜就重复三行；
 * 这里按主播名合并，同一主播在不同榜填了不同房间时把状态并列（`未开播 / 直播中`）。
 *
 * @param {Array} models
 * @param {(entry:object)=>({label?:string}|null)} [lookup]
 * @returns {string[]} 形如 `阿修Axiu：未开播`
 */
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

/**
 * 开播提醒：只发给"订阅过、还在排队、且选的是这位主播"的人
 *
 * 一个这样的人都没有时**返回 0 且什么都不发**（维护者口径：没人订阅就不要推送）。
 * @param {Array<{roomId:string}>} started 刚开播的房间
 * @param {Array} models 各榜模型
 * @param {{groups:number[], store:object}} opts
 * @returns {Promise<number>} 发出的群消息条数
 */
export async function notifyAnchorLive(
  started,
  models,
  { groups = [], store = null, status = liveStatus, directory = memberDirectory, send = sendToGroups } = {},
) {
  if (!started?.length || !groups.length) return 0
  if (config.anchor_live?.push === false) return 0
  const aliasMap = aliases()
  /** 房间 → 这一榜的这位主播（同一位主播可能在多个榜） */
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
        mentions.push(at(qq))
      }
      /** 没有订阅的人：这一位主播的开播对谁都不必提醒 */
      if (!mentions.length) continue
      blocks.push([
        `【${model.name}】主播「${anchor.name}」已开播，请 `,
        ...mentions.flatMap((m, i) => (i ? ["、", m] : [m])),
        " 注意",
      ])
      blocks.push([`https://live.bilibili.com/${roomId}`])
    }
    if (!blocks.length) continue
    /** 块与块之间空一行（与完成播报同一写法） */
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
