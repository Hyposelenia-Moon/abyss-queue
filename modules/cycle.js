/** 分榜清榜 / 月末提醒 / 版本等待期 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { cycleEvents, fmt, SHEET_ABYSS, SHEET_ATTACK, SHEET_DRAMA, SHEET_STYGIAN } from "../components/cycle.js"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"
import { cycleStatus, cycleWrite } from "../model/editor-commands.js"
import { runPrecheck } from "./check-done.js"
import { readJson, statePath, writeJson } from "../model/queue-state.js"
import { readTable, snapshotBuffer } from "../model/local.js"
import { oneSheetBuffer } from "../model/xlsx.js"
import { queuedInSheet } from "./notify.js"
import { joinLines, memberDirectory, mentionParts, sendToGroups } from "../components/notify-send.js"
import { dmSender } from "./manager-link.js"
import { readWhitelist } from "../model/whitelist.js"

const cycleStateFile = () => path.join(path.dirname(statePath()), "cycle.json")
const archiveDir = () => path.join(path.dirname(statePath()), "archives")
const sha256 = buffer => crypto.createHash("sha256").update(buffer).digest("hex")
const isSha256 = value => /^[0-9a-f]{64}$/i.test(String(value ?? ""))

const eventKey = event => `${event.sheet}:${event.type}:${event.round}`

const loadCycleState = () => {
  const raw = readJson(cycleStateFile())
  return raw && typeof raw === "object" && raw.done && typeof raw.done === "object" ? raw : { done: {} }
}

const saveCycleState = state => writeJson(cycleStateFile(), state)

const alertOwner = async text => {
  try {
    const { owners } = readWhitelist()
    const qq = owners[0] ?? ""
    if (!qq) return log("warn", `[abyss-queue] 周期清榜失败且没有可私聊的主人：${text}`)
    await dmSender(qq).send(`【abyss-queue】周期任务失败\n${text}`)
  } catch (err) {
    log("error", `[abyss-queue] 周期失败私聊主人也失败：${err?.message ?? err}\n${text}`)
  }
}

async function writeExclusive(file, data) {
  const fh = await fsp.open(file, "wx")
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
}

async function readArchiveMeta(file) {
  const metaFile = `${file}.meta.json`
  let meta
  try {
    meta = JSON.parse(await fsp.readFile(metaFile, "utf8"))
  } catch (err) {
    throw new Error(`归档缺少可读的元数据（${metaFile}）：${err?.message ?? err}`)
  }
  if (!meta || meta.version !== 1 || !isSha256(meta.sourceVersion) || !isSha256(meta.archiveSha256))
    throw new Error(`归档元数据格式不正确：${metaFile}`)
  return meta
}

async function archiveSheet(sheet, round) {
  const dir = archiveDir()
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${sheet}-${round}.xlsx`)
  try {
    await fsp.access(file)
    const meta = await readArchiveMeta(file)
    if (meta.sheet !== sheet || meta.round !== round)
      throw new Error(`归档元数据与文件名不符：${file}`)
    const bytes = await fsp.readFile(file)
    if (sha256(bytes) !== meta.archiveSha256)
      throw new Error(`归档内容与元数据摘要不符：${file}`)
    log("info", `[abyss-queue] 归档已存在，保留首份：${file}`)
    return { file, sourceVersion: meta.sourceVersion }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
  }
  try {
    await fsp.access(`${file}.meta.json`)
    throw new Error(`归档元数据存在但归档文件缺失：${file}`)
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
  }
  const buffer = await snapshotBuffer()
  const sourceVersion = sha256(buffer)
  const one = await oneSheetBuffer(buffer, sheet)
  const archiveSha256 = sha256(one)
  const meta = { version: 1, sheet, round, sourceVersion, archiveSha256 }
  try {
    await writeExclusive(file, one)
    await writeExclusive(`${file}.meta.json`, JSON.stringify(meta, null, 2) + "\n")
  } catch (err) {
    if (err?.code === "EEXIST") throw new Error(`归档刚被另一轮创建，请重试：${file}`)
    throw err
  }
  log("info", `[abyss-queue] 已归档 ${sheet} → ${file}`)
  return { file, sourceVersion }
}

async function currentSourceVersion() {
  const buffer = await snapshotBuffer()
  return sha256(buffer)
}

async function sendReminder(event, models, { store } = {}) {
  if (config.notify?.enable === false) {
    log("info", `[abyss-queue] notify.enable=false，跳过 ${event.sheet} 清榜提醒`)
    return 0
  }
  const groups = (config.notify?.groups ?? []).map(Number).filter(Boolean)
  if (!groups.length) {
    log("info", `[abyss-queue] ${event.sheet} 清榜提醒没有配置 notify.groups，跳过`)
    return 0
  }
  let issueBlocks = []
  if (event.sheet !== SHEET_ATTACK) {
    try {
      const checked = await runPrecheck({
        models,
        now: event.at,
        store,
        events: [event],
        phase: "reminder",
        group: groups[0],
      })
      issueBlocks = checked?.issueBlocks ?? []
      if (checked?.updated) models = await readTable(({ models: fresh }) => [...fresh.values()])
    } catch (err) {
      log("warn", `[abyss-queue] ${event.sheet} 清榜提醒前核查失败：${err?.message ?? err}`)
    }
  }
  const model = models.find(m => m.name === event.sheet)
  const queue = model ? queuedInSheet(model) : []
  const target = fmt(event.targetAt ?? event.at)
  const head =
    event.sheet === SHEET_ATTACK
      ? [`【${event.sheet}】版更提醒`, `版更时间：${target}`, "本次只清理已完成人员，排队中与等待开启保留。"]
      : event.sheet === SHEET_STYGIAN
        ? [`【${event.sheet}】清榜提醒`, `清榜时间：${target}`, "清榜后进入等待开启，下一版本开始时自动恢复排队中。"]
        : event.sheet === SHEET_ABYSS
          ? [`【${event.sheet}】清榜提醒`, `清榜时间：${target}`, "清榜后进入排队阶段，请留意自己的顺序。"]
          : [`【${event.sheet}】清榜提醒`, `清榜时间：${target}`, "清榜后将重新排队，请留意自己的顺序。"]
  let sent = 0
  for (const gid of groups) {
    const dir = await memberDirectory(gid)
    const line = [`当前仍有 ${queue.length} 人排队：`]
    queue.forEach((r, i) => {
      if (i) line.push("、")
      line.push(...mentionParts(r.nickname, dir))
    })
    const blocks = [...head.map(t => [t])]
    if (queue.length) blocks.push(line)
    if (issueBlocks.length) {
      blocks.push([])
      blocks.push(...issueBlocks)
    }
    await sendToGroups([gid], joinLines(blocks))
    sent++
  }
  log("info", `[abyss-queue] 已发 ${event.sheet} ${event.type === "reminder" ? "清榜" : "周期"}提醒（${queue.length} 人排队）`)
  return sent
}

const writeForEvent = event => {
  if (event.type === "start") return { sheet: event.sheet, mode: "promote", promote: "all" }
  if (event.sheet === SHEET_DRAMA) return { sheet: event.sheet, mode: "all" }
  if (event.sheet === SHEET_ABYSS) return { sheet: event.sheet, mode: "queued-done", promote: "all" }
  if (event.sheet === SHEET_STYGIAN) return { sheet: event.sheet, mode: "queued-done" }
  if (event.sheet === SHEET_ATTACK) return { sheet: event.sheet, mode: "done", promote: "future-real" }
  throw new Error(`不认识的榜：${event.sheet}`)
}

export async function runCycle({ models, now = new Date(), store } = {}) {
  const state = loadCycleState()
  const done = []
  const failed = []
  for (const event of cycleEvents(now)) {
    const key = eventKey(event)
    if (state.done[key]) continue
    try {
      if (event.type === "reminder") {
        await sendReminder(event, models, { store })
      } else {
        const status = await cycleStatus(key)
        if (status.protocol !== 2) throw new Error(`编辑器周期协议不是 2（${status.protocol ?? "缺失"}），拒绝自动清榜`)
        if (status.done) {
          state.done[key] = new Date().toISOString()
          saveCycleState(state)
          done.push(key)
          continue
        }
        if (status.pending) throw new Error("服务端存在未决 intent，已停止自动重放；请人工核对归档、当前表与账本")
        if (event.type === "clear") {
          try {
            const checked = await runPrecheck({
              models,
              now,
              store,
              events: [event],
              phase: "clear",
              silent: true,
            })
            if (checked?.updated) models = await readTable(({ models: fresh }) => [...fresh.values()])
          } catch (err) {
            log("warn", `[abyss-queue] ${event.sheet} 清榜时完成复查失败（不阻断清榜）：${err?.message ?? err}`)
          }
        }
        let version
        if (event.type === "start") version = await currentSourceVersion()
        else ({ sourceVersion: version } = await archiveSheet(event.sheet, event.round))
        const written = await cycleWrite({ ...writeForEvent(event), eventKey: key, version })
        if (store && written?.rowMap && typeof written.rowMap === "object") {
          const moved = store.remap(written.sheet ?? event.sheet, written.rowMap)
          if (moved) await store.save()
        }
      }
      state.done[key] = new Date().toISOString()
      saveCycleState(state)
      done.push(key)
    } catch (err) {
      const error = String(err?.message ?? err)
      failed.push({ key, error })
      log("warn", `[abyss-queue] 周期事件 ${key} 失败：${error}`)
      await alertOwner(`${key}\n${error}`)
    }
  }
  return { done, failed }
}
