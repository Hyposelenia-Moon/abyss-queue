/**
 * 清榜账本、重放意图与「帮帮完成情况」的手动收录名单
 *
 * 这三样东西都是"跨请求要记住的判断依据"，落点都在插件数据目录里：
 *
 *   - **账本**（`abyss-editor-cycle.json`）：同一个 `eventKey` 只允许真正清榜一次。
 *     账本读不出来时**不重置成空账本**——那会把已完成的事件当成未完成、重放清榜（删别人的行）。
 *   - **意图**（`abyss-editor-cycle-intents/<sha256>.json`）：清榜前先写"我要清什么"，
 *     崩溃后再启动能接着做；`wx` 独占创建，已有就绝不覆盖。
 *   - **收录名单**（`abyss-editor-status-names.json`）：只按「榜名@年月」存，跨月自动失效，
 *     不写进表里的永久下拉。
 *
 * 数据目录由装配根调 `initCycleLedger({ dataBase })` 注入（与 `editor.mjs` 的 `DATA_BASE` 同一份）。
 */
import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"

import { CYCLE_PROTOCOL, PENDING_STATUS, SELF_DONE, WAITING_STATUS } from "./defs.js"

/** 数据目录：装配根注入（`initCycleLedger`）之后这几个路径才有效 */
let dataDir = ""
let EXTRA_NAMES_FILE = ""
let CYCLE_LEDGER_FILE = ""
let CYCLE_INTENT_DIR = ""

/** 由装配根调用：把数据目录注入进来，并算好三个落点 */
export const initCycleLedger = ({ dataBase }) => {
  dataDir = String(dataBase ?? "")
  EXTRA_NAMES_FILE = path.join(dataDir, "abyss-editor-status-names.json")
  CYCLE_LEDGER_FILE = path.join(dataDir, "abyss-editor-cycle.json")
  CYCLE_INTENT_DIR = path.join(dataDir, "abyss-editor-cycle-intents")
}

/**
 * 「帮帮完成情况」的**手动收录名单**（临时成员：既不在主播区、也不是这一行的本人）
 *
 * 为什么不能只写进表里那份下拉验证：`mergeStatusOptions` 的净化口径只认
 * 「状态词 ∪ 主播区 ∪ 本月手动收录」，写进验证列表但没人用的名字会在下次净化时被清掉
 * （就是"小伙01 残留"被清的那套机制）。所以手动收录的名单单独存一份，
 * 但**只按“榜名@年月”存**：本月算数，跨月自动失效，绝不写进永久下拉。
 * 文件与绑定/锁一样放在插件数据目录里（数据不出插件，见硬约定 11）。
 */
let CYCLE_LEDGER = null
/** 同一时刻只让一个周期事件读写账本；不同事件串行，避免共享临时文件互相覆盖 */

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
      /** 损坏账本不重置成空账本继续跑：那会把已完成事件当成未完成，重放清榜 */
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

/** 完成账本写盘成功前不替换共享内存；失败时内存仍是旧账本，status 为 pending */

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

/** 独占创建意图文件；已存在返回 false，绝不覆盖旧 intent */

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

/** 收录名单常驻内存：候选计算（`mergeStatusOptions`）是同步路径，不能在里面读文件 */

let EXTRA_NAMES = {}

let extraNamesLoaded = false

/** 收录只对「本月 + 本榜」有效：键里带月份，跨月自动失效，绝不变成永久候选 */

export const monthKey = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

export const extraKeyOf = sheet => `${sheet}@${monthKey()}`

/** 首个请求时读一次（之后只走内存 + 写回） */

export const ensureExtraNames = async () => {
  if (extraNamesLoaded) return
  extraNamesLoaded = true
  try {
    const raw = JSON.parse(await fsp.readFile(EXTRA_NAMES_FILE, "utf8"))
    EXTRA_NAMES = raw && typeof raw === "object" ? raw : {}
  } catch {
    /** 没文件 / 坏了都当"还没收录过"：不能因为这个把编辑器拦住 */
    EXTRA_NAMES = {}
  }
  /**
   * 旧版按榜名直接存（永久有效）。升级后只把这些名字迁到**当前月**，
   * 下个月自然失效——不能继续当永久名单。
   */
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
      /** 迁移写盘失败不影响本次内存候选；下个请求会再试 */
      extraNamesLoaded = false
    }
  }
}

export const extraNamesOf = sheet => {
  const list = EXTRA_NAMES[extraKeyOf(sheet)]
  return Array.isArray(list) ? list.map(s => String(s).trim()).filter(Boolean) : []
}

/** 收录一个名字（幂等：已存在就原样返回）。名字里不能有逗号——这一列是多值、逗号是分隔符 */

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
  /** 同一个榜以前月份留下的临时名字清掉，文件不无限长 */
  for (const k of Object.keys(all)) {
    if (k.startsWith(`${sheet}@`) && k !== key) delete all[k]
  }
  await fsp.writeFile(EXTRA_NAMES_FILE, JSON.stringify(all, null, 2) + "\n")
  EXTRA_NAMES = all
  return list
}

/**
 * 「帮帮完成情况」的下拉：固定状态（排队中 / 等待开启 / 本人已完成）+ 主播名 + 手动收录
 *
 * 这一列同样是多选（可以同时写多位主播），所以名单也要跟着主播区走。
 *
 * **这一列里"在用的名字"不再当候选**（维护者报告：下拉里混进别人的群昵称甚至广告名）。
 * 为什么不再兜底：点「本人已完成」落进这一列的是**群昵称**，于是每个点过的人的名字都会变成
 * 全体候选；群昵称还会因为改名 / 退群 / 广告名片一路残留，越积越多（`archiveOptions` 又是只增不减）。
 * 现在只认四种来源：状态词、主播区、**本月手动「＋ 收录新名字」**；临时成员就从这里收，
 * 月底自动失效，不写进表里的永久下拉。
 * 两条安全绳：① **当前值永远在候选里**（页面把这一格的现值并进候选，见 editor.html 的
 * `picker` 组装）——不然用户看不到、也取消不了自己那一格；② 校验放行"这一格里本来就有的值"
 * （见 `validateRows`），所以老数据照旧能改能存，只是不再往下扩散，
 * 而且保存/归档时这份净化后的名单会写回表里（自愈）。
 */
export const mergeStatusOptions = (model, anchors, { withExtra = true } = {}) => {
  const current = [...new Set(model.options?.status ?? [])]
  /**
   * 只留**状态词**（等待开启 / 排队中 / 本人已完成）：表里下拉验证里的其它历史值一律不作候选
   *
   * 归档（`archiveOptions`）只增不减：表里当年用过的名字会被写进 xlsx 的下拉验证列表，
   * 之后再没人用时**永远留在那里**；保存/归档时会把这份净化后的名单写回表里，那批残留会顺手清掉（自愈）。
   */
  /**
   * 状态词**永远下发**，不依赖 xlsx 里那份下拉验证是否还留着它：
   * 枪战恢复「等待开启」后，旧表验证列表里没有这个词，曾导致保存被
   * “等待开启不在下拉选项里”卡住。
   *
   * 剧诗没有等待阶段：不向它下发「等待开启」，旧表里残留的状态词也不再进候选。
   */
  const waitingAllowed = !/剧诗/.test(String(model.name ?? ""))
  const fixed = [
    ...new Set([
      ...PENDING_STATUS.filter(v => v !== WAITING_STATUS || waitingAllowed),
      SELF_DONE,
      ...current.filter(v => PENDING_STATUS.includes(v) || v === SELF_DONE),
    ]),
  ].filter(v => v !== WAITING_STATUS || waitingAllowed)
  /** 写回 xlsx 下拉验证时 withExtra=false：本月临时收录的名字只进页面候选，不落成永久下拉 */
  return [...new Set([...fixed, ...anchors, ...(withExtra ? extraNamesOf(model.name) : [])])]
}

/** 业务校验：必填、同榜不重名、下拉值必须命中 */
