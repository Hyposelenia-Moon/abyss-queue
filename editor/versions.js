/** 历史版本与归档（写表前的存底） */
import fs from "node:fs"
import path from "node:path"

import { dayStamp, pad2 } from "./util.js"

export const RE_VERSION = /^queue-\d{8}-\d{6}(-\d+)?\.xlsx$/

export const RE_ARCHIVE = /^queue-\d{4}-\d{2}(-\d{2})?\.xlsx$/

const RE_ARCHIVE_MONTHLY = /^queue-\d{4}-\d{2}\.xlsx$/

const RE_ARCHIVE_DAY = /^queue-(\d{4})-(\d{2})-(\d{2})\.xlsx$/

export const versionName = (d = new Date()) =>
  `queue-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.xlsx`
export const AUTOSAVE_SNAPSHOT_MS = 5 * 60 * 1000

export const resolveStoredFile = (versionsDir, archivesDir, id) => {
  const name = path.basename(String(id ?? ""))
  if (RE_VERSION.test(name)) return { kind: "version", file: path.join(versionsDir, name), monthly: false }
  if (RE_ARCHIVE.test(name)) return { kind: "archive", file: path.join(archivesDir, name), monthly: RE_ARCHIVE_MONTHLY.test(name) }
  return { kind: "", file: "", monthly: false }
}

export function createVersions({ versionsDir, archivesDir, xlsxPath, versionsKeep, archiveDays, archivesKeep }) {
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
  const pruneVersions = () => {
    if (versionsKeep <= 0) return
    for (const v of listVersions().slice(versionsKeep)) {
      try {
        fs.rmSync(path.join(versionsDir, v.id))
      } catch {
      }
    }
  }
  const snapshotVersion = async ({ throttleMs = 0, now = Date.now() } = {}) => {
    if (versionsKeep <= 0) return ""
    try {
      if (!fs.existsSync(xlsxPath)) return ""
      await fs.promises.mkdir(versionsDir, { recursive: true })
      const newest = listVersions()[0]
      if (newest && throttleMs > 0 && now - Number(newest.mtime || 0) < throttleMs) {
        console.log(`[editor] 距上一份历史版本不到 ${Math.round(throttleMs / 60000)} 分钟，这一次不存（自动保存节流）`)
        return ""
      }
      const bytes = await fs.promises.readFile(xlsxPath)
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
      }
    }
    if (archivesKeep <= 0) return
    const monthly = list.filter(a => a.monthly)
    for (const a of monthly.slice(archivesKeep)) {
      try {
        fs.rmSync(path.join(archivesDir, a.id))
      } catch {
      }
    }
  }
  const snapshotBeforeWrite = async (arg = {}) => {
    const opts = arg instanceof Date ? { now: arg } : arg
    const now = opts?.now instanceof Date ? opts.now : new Date(opts?.now ?? Date.now())
    const version = await snapshotVersion({ throttleMs: Number(opts?.throttleMs) || 0, now: now.getTime() })
    try {
      if (!fs.existsSync(xlsxPath)) return version
      const bytes = await fs.promises.readFile(xlsxPath)
      await fs.promises.mkdir(archivesDir, { recursive: true })
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
