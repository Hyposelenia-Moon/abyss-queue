/**
 * 历史版本与归档（写表前的存底）
 *
 * 三件事的**命名与保留口径只在本模块定义**（含 `/api/download` 认不认这个文件名）：
 *   - 历史版本：`versions/queue-YYYYMMDD-HHMMSS[-n].xlsx`，滚动保留最近 `versionsKeep` 份
 *   - 每日归档：`archives/queue-YYYY-MM-DD.xlsx`，当天第一次写表时留一份（当天起始状态），只留最近 `archiveDays` 天
 *   - 换月归档：`archives/queue-YYYY-MM.xlsx`，**前月最后一次修改**（长期保留，最多 `archivesKeep` 个月）
 *
 * 为什么集中在这：版本文件名的正则若散在（列表、清单、下载校验）三处，加个后缀就可能只改到一处；
 * 这里只有下面的 `RE_VERSION` / `RE_ARCHIVE` 两份。
 *
 * 模块只依赖注入进来的 `deps`，不读全局；归档失败只记日志，绝不影响写表。
 */
import fs from "node:fs"
import path from "node:path"

import { dayStamp, pad2 } from "./util.js"

/** 历史版本文件名（同秒重复时带 `-n` 后缀） */
export const RE_VERSION = /^queue-\d{8}-\d{6}(-\d+)?\.xlsx$/
/** 归档文件名：`queue-YYYY-MM.xlsx`（月度）或 `queue-YYYY-MM-DD.xlsx`（每日） */
export const RE_ARCHIVE = /^queue-\d{4}-\d{2}(-\d{2})?\.xlsx$/
/** 只认月度归档（每日归档不是它） */
const RE_ARCHIVE_MONTHLY = /^queue-\d{4}-\d{2}\.xlsx$/
/** 从每日归档的名字里取出年月日 */
const RE_ARCHIVE_DAY = /^queue-(\d{4})-(\d{2})-(\d{2})\.xlsx$/

/** 版本文件名：queue-YYYYMMDD-HHMMSS.xlsx（同秒重复就加序号） */
export const versionName = (d = new Date()) =>
  `queue-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.xlsx`

/**
 * 这个 id 指向哪一份已存文件（**下载接口的准入判定，只此一处**）
 *
 * `id` 只允许是版本或归档目录里的**文件名**（先 `path.basename` 挡掉路径穿越）。
 * @returns {{kind:"version"|"archive"|"", file:string, monthly:boolean}}
 *   `kind` 为空 = 这个 id 不是我们认的文件名，调用方按 404 处理
 */
export const resolveStoredFile = (versionsDir, archivesDir, id) => {
  const name = path.basename(String(id ?? ""))
  if (RE_VERSION.test(name)) return { kind: "version", file: path.join(versionsDir, name), monthly: false }
  if (RE_ARCHIVE.test(name)) return { kind: "archive", file: path.join(archivesDir, name), monthly: RE_ARCHIVE_MONTHLY.test(name) }
  return { kind: "", file: "", monthly: false }
}

/**
 * @param {object} deps
 * @param {string} deps.versionsDir 历史版本目录
 * @param {string} deps.archivesDir 归档目录
 * @param {string} deps.xlsxPath 当前表（存版本、判"最后一次修改是哪个月"都读它）
 * @param {number} deps.versionsKeep 只留最近几份版本（0 = 不存）
 * @param {number} deps.archiveDays 每日归档留最近几天
 * @param {number} deps.archivesKeep 月度归档最多留几个月（0 = 一直留）
 */
export function createVersions({ versionsDir, archivesDir, xlsxPath, versionsKeep, archiveDays, archivesKeep }) {
  /** 已存的历史版本，新的在前 */
  const listVersions = () => {
    try {
      return fs
        .readdirSync(versionsDir)
        .filter(f => RE_VERSION.test(f))
        .map(f => {
          const st = fs.statSync(path.join(versionsDir, f))
          return { id: f, at: st.mtime.toISOString(), size: st.size, mtime: st.mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  /** 只留最近 versionsKeep 份 */
  const pruneVersions = () => {
    if (versionsKeep <= 0) return
    for (const v of listVersions().slice(versionsKeep)) {
      try {
        fs.rmSync(path.join(versionsDir, v.id))
      } catch {
        /* 删不掉下次再说 */
      }
    }
  }

  /**
   * 把当前这份表存成一个历史版本（**写表前**调用）
   *
   * 空版本目录也就从这里开始攒：不预置任何版本，第一次写表才有第一份。
   * @returns {Promise<string>} 版本文件名（没存成返回空串）
   */
  const snapshotVersion = async () => {
    if (versionsKeep <= 0) return ""
    try {
      if (!fs.existsSync(xlsxPath)) return ""
      await fs.promises.mkdir(versionsDir, { recursive: true })
      const bytes = await fs.promises.readFile(xlsxPath)
      /** 和最新版本一模一样就不重复存（空保存不去占用版本位） */
      const newest = listVersions()[0]
      if (newest) {
        const same = await fs.promises.readFile(path.join(versionsDir, newest.id))
        if (Buffer.compare(same, bytes) === 0) return ""
      }
      let name = versionName()
      let n = 1
      while (fs.existsSync(path.join(versionsDir, name))) name = versionName().replace(/\.xlsx$/, `-${n++}.xlsx`)
      await fs.promises.writeFile(path.join(versionsDir, name), bytes)
      pruneVersions()
      console.log(`[editor] 已存历史版本 ${name}（写表前）`)
      return name
    } catch (err) {
      console.error(`[editor] 存历史版本失败（不影响写表）：${err?.message ?? err}`)
      return ""
    }
  }

  /** 归档清单（新的在前）：月度在前，其次每日 */
  const listArchives = () => {
    try {
      return fs
        .readdirSync(archivesDir)
        .filter(f => RE_ARCHIVE.test(f))
        .map(f => {
          const st = fs.statSync(path.join(archivesDir, f))
          return { id: f, at: st.mtime.toISOString(), size: st.size, mtime: st.mtimeMs, monthly: RE_ARCHIVE_MONTHLY.test(f) }
        })
        .sort((a, b) => (a.monthly === b.monthly ? b.mtime - a.mtime : a.monthly ? -1 : 1))
    } catch {
      return []
    }
  }

  /**
   * 归档只留需要的那部分
   *
   * 每日归档：只留最近 archiveDays 天（默认 7 天，到点就删）；
   * 月归档：最多留 archivesKeep 个月（默认 12，0 = 一直留着）。
   * 已经下载走的归档不受影响，这里只清服务器上的副本。
   */
  const pruneArchives = (now = new Date()) => {
    const list = listArchives()
    const keepFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - archiveDays)
    for (const a of list) {
      if (a.monthly) continue
      const m = a.id.match(RE_ARCHIVE_DAY)
      if (!m) continue
      if (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) >= keepFrom) continue
      try {
        fs.rmSync(path.join(archivesDir, a.id))
        console.log(`[editor] 每日归档超过 ${archiveDays} 天，已删除：${a.id}`)
      } catch {
        /* 删不掉下次再说 */
      }
    }
    if (archivesKeep <= 0) return
    const monthly = list.filter(a => a.monthly)
    for (const a of monthly.slice(archivesKeep)) {
      try {
        fs.rmSync(path.join(archivesDir, a.id))
      } catch {
        /* 删不掉下次再说 */
      }
    }
  }

  /**
   * 写表前的存底：历史版本（滚动）+ 每日归档 + 换月归档
   *
   * - 每日归档：`archives/queue-YYYY-MM-DD.xlsx`，当天第一次写表时留一份
   * - 换月归档：`archives/queue-YYYY-MM.xlsx`，这份表最后一次修改还是上个月（或更早）→ 那正是"前月最后一次修改"
   *   （换月时通常先有人用空模板覆盖/回退，覆盖动作也会走这里，所以上月的收尾状态留得住）
   *
   * @param {Date} [now] 判定时刻（默认当前时间）
   * @returns {Promise<string>} 本次存下的版本文件名（没存成 = 空串）
   */
  const snapshotBeforeWrite = async (now = new Date()) => {
    const version = await snapshotVersion()
    try {
      if (!fs.existsSync(xlsxPath)) return version
      const bytes = await fs.promises.readFile(xlsxPath)
      await fs.promises.mkdir(archivesDir, { recursive: true })

      /** 每日归档：同一天只留第一份（那天的起始状态） */
      const day = `queue-${dayStamp(now)}.xlsx`
      if (!fs.existsSync(path.join(archivesDir, day))) {
        await fs.promises.writeFile(path.join(archivesDir, day), bytes)
        console.log(`[editor] 已归档当天起始状态 ${day}`)
      }

      const mtime = fs.statSync(xlsxPath).mtime
      const month = `${mtime.getFullYear()}-${pad2(mtime.getMonth() + 1)}`
      const nowMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`
      if (month < nowMonth) {
        const monthly = `queue-${month}.xlsx`
        if (!fs.existsSync(path.join(archivesDir, monthly))) {
          await fs.promises.writeFile(path.join(archivesDir, monthly), bytes)
          console.log(`[editor] 已归档 ${month} 的最后一次修改：${monthly}`)
        }
      }
      pruneArchives(now)
    } catch (err) {
      console.error(`[editor] 归档失败（不影响写表）：${err?.message ?? err}`)
    }
    return version
  }

  return { listVersions, pruneVersions, snapshotVersion, listArchives, pruneArchives, snapshotBeforeWrite }
}
