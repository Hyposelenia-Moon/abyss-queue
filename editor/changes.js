/**
 * 改动记录（留痕）：谁、什么时候、改了哪个榜哪一行的哪个字段、从什么改成什么
 *
 * ## 为什么需要它
 *
 * 编辑器正在走向"本群成员都能写"（放开权限那几步见 `AGENTS.md` §十 与本轮沿革）：权限放开之后，
 * 真正兜底的**不是拦阻，而是"看得见 + 退得回"**。现有三套痕迹各缺一块：
 *   - 历史版本（`editor/versions.js`）回答"怎么退回去"，但它**没有作者**，答不出"这一格是谁改的"；
 *   - 审计日志（`editor/audit.js`）答得出"谁在什么时候调了哪个接口"，但没有字段级差异；
 *   - 归属锁（`editor/ownership.js` 的 `lockRows`）只覆盖"完成情况"一格，而且 `by` 存的是昵称。
 * 所以这一份是**唯一能回答"某人在某时把某行的某数据改成什么"的地方**。
 *
 * ## 口径
 *
 * 1. **只记事实**：一行一条（同一行的多个字段合成一条），字段值是**写完之后的最终值**——
 *    服务端会改造提交值（「本人已完成」落成群昵称、主播锁回退、改名连带），记最终值才对得上表。
 * 2. **服务端级联单独记**：改名连带写的是**别人那些行**的完成情况，`via` 标成 `"改名连带"`，
 *    免得看起来像用户自己去动了别人的行。
 * 3. **被拒绝的保存也记**（`kind: "reject"`）：拒绝对审计最有价值（"谁在试"和"谁改成了"一样重要）。
 *    但拒绝时手上没有逐字段差异（那一份还没算完就被拦下了），所以记的是**试图改哪几行 + 原因**。
 * 4. **不记口令与 query**（与 `editor/audit.js` 同一条纪律），也不记 IP。
 * 5. **滚动保留** `keep` 条（默认 2000）：这里只放"最近的改动"，长期留档由历史版本 / 归档负责。
 *
 * 文件落在 `<数据目录>/abyss-editor-changes.json`（数据不出 `plugins/abyss-queue/data`），
 * 写入走 `editor/util.js` 的 `writeJson`（临时文件 + 原子替换）。
 */
import { readJson, writeJson } from "./util.js"

/** 默认保留条数（可用 `ABYSS_EDITOR_CHANGES_KEEP` 调） */
export const CHANGES_KEEP = 2000

/**
 * 条目形状（面板按 `kind` 分派渲染；模块只做存储与筛选，不校验字段）
 *
 * - `edit`   `{ kind:"edit", at, qq, nick, sheet, row, via, changes:{ 字段: [原值, 新值] }, version, snapshot }`
 * - `reject` `{ kind:"reject", at, qq, nick, sheet, rows:[行号…], reason, version }`
 * - `remove` `{ kind:"remove", at, qq, nick, sheet, row, reason }`（退群/被移出：行被删掉并压紧）
 * - `order`  `{ kind:"order", at, qq, nick, sheet, row, from, to, moved }`（插队：这一行挪到第几位）
 */

/**
 * @param {object} deps
 * @param {string} deps.file 记录文件（生产固定 `<插件根>/data/abyss-editor-changes.json`）
 * @param {number} [deps.keep] 只留最近多少条（非法 / `<=0` 时用默认值）
 */
export function createChanges({ file, keep = CHANGES_KEEP } = {}) {
  const limit = Number(keep) > 0 ? Math.floor(Number(keep)) : CHANGES_KEEP

  /** 读全部记录（新的在后；读不出来当"还没有"） */
  const load = () => {
    const raw = file ? readJson(file) : null
    return { updatedAt: Number(raw?.updatedAt) || 0, rows: Array.isArray(raw?.rows) ? raw.rows : [] }
  }

  /**
   * 追加若干条
   *
   * **不影响写表**：调用方在 `afterCommit` 里调它，记录写不进去只记一行日志（与归档失败同一口径），
   * 绝不把已经写成功的表带崩。
   * @returns {number} 真正追加的条数
   */
  const append = (records = []) => {
    const list = (Array.isArray(records) ? records : []).filter(r => r && Number(r.at))
    if (!list.length || !file) return 0
    try {
      const rows = [...load().rows, ...list].slice(-limit)
      writeJson(file, { updatedAt: Date.now(), keep: limit, rows })
      return list.length
    } catch (err) {
      console.error(`[editor] 记改动记录失败（不影响写表）：${err?.message ?? err}`)
      return 0
    }
  }

  /** 这条记录说的是不是我名下那些行（`mine` = `{ 榜名 → Set(行号) }`，即 `mineRows()` 的返回） */
  const hitsMine = (entry, mine) => {
    if (!mine || !mine.size) return false
    const rows = mine.get(String(entry?.sheet ?? ""))
    if (!rows || !rows.size) return false
    if (Number(entry?.row) && rows.has(Number(entry.row))) return true
    for (const r of entry?.rows ?? []) if (rows.has(Number(r))) return true
    return false
  }

  /**
   * 取记录（**新的在前**，面板直接用）
   *
   * @param {object} [opts]
   * @param {number} [opts.limit] 最多几条（默认 200）
   * @param {boolean} [opts.all] true = 全部（管理员）；false = 只给"我发的 + 改到我自己那些行的"
   * @param {string} [opts.qq] 调用者的 QQ（`all: false` 时用）
   * @param {Map<string, Set<number>>} [opts.mine] 调用者名下那些行
   * @returns {object[]}
   */
  const list = ({ limit: take = 200, all = false, qq = "", mine = null } = {}) => {
    const rows = load().rows
    const picked = all ? rows : rows.filter(e => (qq && String(e?.qq ?? "") === String(qq)) || hitsMine(e, mine))
    const n = Number(take) > 0 ? Math.floor(Number(take)) : 200
    return picked.slice(-n).reverse()
  }

  return { file, keep: limit, load, append, list, hitsMine }
}
