/** 越界配额：**普通群友改别人的行**的限速（滑动窗口） */
import { readJson, writeJson } from "./util.js"

export const MAX_PER_SAVE = 3

export const WINDOW_MS = 10 * 60 * 1000
export const MAX_PER_WINDOW = 10

export function createQuota({
  file,
  maxPerSave = MAX_PER_SAVE,
  windowMs = WINDOW_MS,
  maxPerWindow = MAX_PER_WINDOW,
} = {}) {
  const limit = { maxPerSave: Math.max(0, Number(maxPerSave) || 0), windowMs: Math.max(0, Number(windowMs) || 0), maxPerWindow: Math.max(0, Number(maxPerWindow) || 0) }
  const load = () => {
    const raw = file ? readJson(file) : null
    return raw && typeof raw === "object" ? raw : {}
  }
  const used = (qq, now = Date.now()) => {
    const list = Array.isArray(load()[String(qq)]) ? load()[String(qq)] : []
    return list.filter(e => Array.isArray(e) && now - Number(e[0]) <= limit.windowMs).reduce((n, e) => n + (Number(e[1]) || 0), 0)
  }
  const check = (qq, rows, now = Date.now()) => {
    const n = Math.max(0, Number(rows) || 0)
    if (!n) return { ok: true }
    if (limit.maxPerSave && n > limit.maxPerSave)
      return { ok: false, reason: `一次最多改 ${limit.maxPerSave} 位其他人的行（你这次改了 ${n} 位）` }
    const before = used(qq, now)
    if (limit.maxPerWindow && before + n > limit.maxPerWindow)
      return {
        ok: false,
        reason:
          `${Math.round(limit.windowMs / 60000)} 分钟内最多改 ${limit.maxPerWindow} 位其他人的行` +
          `（这之前已经改了 ${before} 位，这次还要 ${n} 位）`,
      }
    return { ok: true }
  }
  const commit = (qq, rows, now = Date.now()) => {
    const n = Math.max(0, Number(rows) || 0)
    if (!n || !file) return 0
    try {
      const all = load()
      const key = String(qq)
      const kept = (Array.isArray(all[key]) ? all[key] : []).filter(e => Array.isArray(e) && now - Number(e[0]) <= limit.windowMs)
      kept.push([now, n])
      all[key] = kept
      writeJson(file, all)
      return kept.reduce((sum, e) => sum + (Number(e[1]) || 0), 0)
    } catch (err) {
      console.error(`[editor] 记额度失败（不影响写表）：${err?.message ?? err}`)
      return 0
    }
  }
  return { file, limit, used, check, commit }
}
