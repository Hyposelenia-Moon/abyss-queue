/**
 * 越界配额：**普通群友改别人的行**的限速（滑动窗口）
 *
 * ## 为什么要有它
 *
 * 编辑器正在走向"本群成员都能写"（见 `docs/权限与链接方案.md` 与 `editor/changes.js` 的说明）：
 * 放开之后，唯一还拦着"一次手滑爆改一片"的就是这一层。三档口径：
 *   - **自己的行**：不限（改多少格、存多少次都行）；
 *   - **别人的行**：每次保存 ≤ `maxPerSave` 行，且 `windowMs` 滑动窗口内累计 ≤ `maxPerWindow` 行；
 *   - **硬红线**：清空别人的行 / 改别人行的群昵称 / 改被主播锁定的完成情况 —— 不计数，直接拒（在 `editor.mjs` 里判）。
 *
 * ## 两条诚实说明（都影响了实现）
 *
 * 1. 它是「**每次保存**」的额度，不是「每人每天」的额度：页面是 1.5 秒防抖自动保存，
 *    改 3 行、每行间隔超过 1.5 秒就会被拆成 3 次请求 ⇒ 单次上限拦不住"慢慢改"，
 *    真正拦得住的是**窗口累计**这一档。
 * 2. **被拒的尝试不占额度**（只记日志与改动记录）：否则一次手滑会把后面整个窗口锁死，
 *    用户明明只想补一格却怎么都存不进去。
 *
 * 窗口状态落在 `<数据目录>/abyss-editor-quota.json`（数据不出 `plugins/abyss-queue/data`），
 * 写入走 `editor/util.js` 的 `writeJson`（临时文件 + 原子替换）。这里只放"最近一个窗口"，
 * 每条记录很小；读不出来 / 坏掉一律当"这个窗口还没记过"（宁可放松一次，也不能把人卡死）。
 */
import { readJson, writeJson } from "./util.js"

/** 每次保存最多动几个别人 的行 */
export const MAX_PER_SAVE = 3
/** 滑动窗口长度与窗口内总行数上限 */
export const WINDOW_MS = 10 * 60 * 1000
export const MAX_PER_WINDOW = 10

/**
 * @param {object} deps
 * @param {string} deps.file 窗口状态文件
 * @param {number} [deps.maxPerSave] 单次保存上限（默认 3）
 * @param {number} [deps.windowMs] 窗口长度（默认 10 分钟）
 * @param {number} [deps.maxPerWindow] 窗口内累计上限（默认 10）
 */
export function createQuota({
  file,
  maxPerSave = MAX_PER_SAVE,
  windowMs = WINDOW_MS,
  maxPerWindow = MAX_PER_WINDOW,
} = {}) {
  const limit = { maxPerSave: Math.max(0, Number(maxPerSave) || 0), windowMs: Math.max(0, Number(windowMs) || 0), maxPerWindow: Math.max(0, Number(maxPerWindow) || 0) }

  /** 读窗口状态（`{ qq: [[at, n], …] }`）；坏掉当"没记过" */
  const load = () => {
    const raw = file ? readJson(file) : null
    return raw && typeof raw === "object" ? raw : {}
  }

  /** 这个 QQ 在窗口内已经用掉多少行（顺手把过期的条目丢掉，但不落盘） */
  const used = (qq, now = Date.now()) => {
    const list = Array.isArray(load()[String(qq)]) ? load()[String(qq)] : []
    return list.filter(e => Array.isArray(e) && now - Number(e[0]) <= limit.windowMs).reduce((n, e) => n + (Number(e[1]) || 0), 0)
  }

  /**
   * 这一次要动几个"别人的行"，能不能放行
   *
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
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

  /**
   * 记一笔（**只在保存成功之后调**：被拒的尝试不占额度）
   *
   * 落盘失败只记日志：额度记不进去顶多让下一次松一点，绝不能把已经写成功的保存带崩。
   * @returns {number} 这个窗口内现在的累计值
   */
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
