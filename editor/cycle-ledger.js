/** 清榜账本、重放意图与「帮帮完成情况」的手动收录名单 */
import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"

import { CYCLE_PROTOCOL, PENDING_STATUS, SELF_DONE, WAITING_STATUS } from "./defs.js"

let dataDir = ""
let EXTRA_NAMES_FILE = ""
let CYCLE_LEDGER_FILE = ""
let CYCLE_INTENT_DIR = ""

export const initCycleLedger = ({ dataBase }) => {
  dataDir = String(dataBase ?? "")
  EXTRA_NAMES_FILE = path.join(dataDir, "abyss-editor-status-names.json")
  CYCLE_LEDGER_FILE = path.join(dataDir, "abyss-editor-cycle.json")
  CYCLE_INTENT_DIR = path.join(dataDir, "abyss-editor-cycle-intents")
}

let CYCLE_LEDGER = null

let cycleQueue = Promise.resolve()

export const cycleExclusive = fn => {
  const run = cycleQueue.then(fn, fn)
  cycleQueue = run.catch(() => {})
  return run
}

export const intentKey = eventKey => crypto.createHash("sha256").update(String(eventKey)).digest("hex")

export const intentPath = eventKey => path.join(CYCLE_INTENT_DIR, `${intentKey(eventKey)}.json`)

export const loadCycleLedger = async ({ fresh = false } = {}) => {
  if (CYCLE_LEDGER && !fresh) return CYCLE_LEDGER
  try {
    const raw = JSON.parse(await fsp.readFile(CYCLE_LEDGER_FILE, "utf8"))
    if (!raw || typeof raw !== "object" || !raw.done || typeof raw.done !== "object")
      throw new Error("账本结构不正确")
    CYCLE_LEDGER = raw
  } catch (err) {
    if (err?.code === "ENOENT") CYCLE_LEDGER = { done: {} }
    else {
      throw new Error(`周期账本不可读，停止自动清榜：${err?.message ?? err}`)
    }
  }
  return CYCLE_LEDGER
}

export const writeJsonSynced = async (file, value) => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fh = await fsp.open(tmp, "w")
  try {
    await fh.writeFile(JSON.stringify(value, null, 2) + "\n")
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fsp.rename(tmp, file)
}

export const saveCycleLedger = async next => {
  await writeJsonSynced(CYCLE_LEDGER_FILE, next)
  CYCLE_LEDGER = next
}

export const readCycleIntent = async eventKey => {
  try {
    const raw = JSON.parse(await fsp.readFile(intentPath(eventKey), "utf8"))
    if (!raw || raw.eventKey !== String(eventKey) || raw.protocol !== CYCLE_PROTOCOL)
      throw new Error("intent 内容不正确")
    return raw
  } catch (err) {
    if (err?.code === "ENOENT") return null
    throw new Error(`周期清榜 intent 不可读，停止自动重放：${err?.message ?? err}`)
  }
}

export const createCycleIntent = async (eventKey, data) => {
  await fsp.mkdir(CYCLE_INTENT_DIR, { recursive: true })
  const file = intentPath(eventKey)
  let fh
  try {
    fh = await fsp.open(file, "wx")
  } catch (err) {
    if (err?.code === "EEXIST") return false
    throw err
  }
  try {
    await fh.writeFile(JSON.stringify({ protocol: CYCLE_PROTOCOL, eventKey: String(eventKey), ...data }, null, 2) + "\n")
    await fh.sync()
  } finally {
    await fh.close()
  }
  return true
}

export const removeCycleIntent = async eventKey => {
  await fsp.rm(intentPath(eventKey), { force: true })
}

let EXTRA_NAMES = {}

let extraNamesLoaded = false

export const monthKey = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
export const extraKeyOf = sheet => `${sheet}@${monthKey()}`

export const ensureExtraNames = async () => {
  if (extraNamesLoaded) return
  extraNamesLoaded = true
  try {
    const raw = JSON.parse(await fsp.readFile(EXTRA_NAMES_FILE, "utf8"))
    EXTRA_NAMES = raw && typeof raw === "object" ? raw : {}
  } catch {
    EXTRA_NAMES = {}
  }
  let migrated = false
  for (const [key, value] of Object.entries(EXTRA_NAMES)) {
    if (key.includes("@") || !Array.isArray(value)) continue
    const list = value.map(s => String(s).trim()).filter(Boolean)
    if (list.length) {
      EXTRA_NAMES[`${key}@${monthKey()}`] = [...new Set([...(EXTRA_NAMES[`${key}@${monthKey()}`] ?? []), ...list])]
    }
    delete EXTRA_NAMES[key]
    migrated = true
  }
  if (migrated) {
    try {
      await fsp.writeFile(EXTRA_NAMES_FILE, JSON.stringify(EXTRA_NAMES, null, 2) + "\n")
    } catch {
      extraNamesLoaded = false
    }
  }
}

export const extraNamesOf = sheet => {
  const list = EXTRA_NAMES[extraKeyOf(sheet)]
  return Array.isArray(list) ? list.map(s => String(s).trim()).filter(Boolean) : []
}

export const addExtraName = async (sheet, name) => {
  const clean = String(name ?? "").trim()
  if (!clean) throw new Error("名字不能为空")
  if (clean.length > 30) throw new Error("名字太长了（最多 30 个字）")
  if (/[,，]/.test(clean)) throw new Error("名字里不能有逗号")
  const all = { ...EXTRA_NAMES }
  const key = extraKeyOf(sheet)
  const list = extraNamesOf(sheet)
  if (!list.includes(clean)) list.push(clean)
  all[key] = list
  for (const k of Object.keys(all)) {
    if (k.startsWith(`${sheet}@`) && k !== key) delete all[k]
  }
  await fsp.writeFile(EXTRA_NAMES_FILE, JSON.stringify(all, null, 2) + "\n")
  EXTRA_NAMES = all
  return list
}

export const mergeStatusOptions = (model, anchors, { withExtra = true } = {}) => {
  const current = [...new Set(model.options?.status ?? [])]
  const waitingAllowed = !/剧诗/.test(String(model.name ?? ""))
  const fixed = [
    ...new Set([
      ...PENDING_STATUS.filter(v => v !== WAITING_STATUS || waitingAllowed),
      SELF_DONE,
      ...current.filter(v => PENDING_STATUS.includes(v) || v === SELF_DONE),
    ]),
  ].filter(v => v !== WAITING_STATUS || waitingAllowed)
  return [...new Set([...fixed, ...anchors, ...(withExtra ? extraNamesOf(model.name) : [])])]
}
