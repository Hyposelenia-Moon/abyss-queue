/**
 * 完成情况文字：解析、生成、改名
 *
 * 表里 `status` 那一列是**一串文字**：`排队中` / `等待开启` / `12/20 满星` / `7.2排队中`
 * 以及主播代填的 `本人已完成`。解析与生成的规则集中在这里，别在别处再切一遍字符串——
 * 之前就是因为分了两份，攻炼的复合状态被整串当成一个人名。
 *
 * 纯函数：不读写文件，依赖只有 `components/attack.js` 与 `defs.js`。
 */
import { attackCompletedStatus, attackPendingStatus, attackStatusParts } from "../components/attack.js"
import { phaseOf as cyclePhaseOf } from "../components/cycle.js"
import { QUEUED_STATUS, SELF_DONE, WAITING_STATUS } from "./defs.js"

export const defaultStatusOf = (sheetName, now = new Date()) => {
  const name = String(sheetName ?? "")
  /** 枪战新行先等待；真正状态按所选模式在保存时重算 */
  if (/攻炼|绝境/.test(name)) return WAITING_STATUS
  return cyclePhaseOf(name, now) === "queued" ? QUEUED_STATUS : WAITING_STATUS
}

/**
 * 「本人已完成」→ 这一行的群昵称
 *
 * 编辑器里点「本人已完成」会直接落成群昵称，但表格（腾讯文档那份）里能直接选到这个字面值，
 * 所以两头都换一遍：显示时换成昵称、保存时也换成昵称（真写回表里）。
 */
export const statusWithSelfDone = (status, nickname) => {
  const raw = String(status ?? "").trim()
  const parts = raw
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
  /** 不含标记就原样返回：拆开再拼会把昵称里的中文逗号改成英文逗号 */
  if (!parts.includes(SELF_DONE)) return raw
  const nick = String(nickname ?? "").trim()
  if (!nick) return raw
  return [...new Set(parts.map(p => (p === SELF_DONE ? nick : p)))].join(",")
}

/**
 * 「帮帮完成情况」的多值切分：逗号（中英文都认）分隔，两端去空白、丢掉空值
 *
 * 与 `statusWithSelfDone` 同一套写法：这一列是人工维护的多值，分隔符与空格都不统一。
 */
export const statusTokens = status =>
  String(status ?? "")
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)

export const statusLabels = status => {
  const parts = attackStatusParts(status)
  return parts ? parts.flatMap(part => statusTokens(part.label)) : statusTokens(status)
}

/**
 * 昵称改了：「帮帮完成情况」里哪些格要跟着换、换成什么
 *
 * 这一列存的是**人**（主播名，或点「本人已完成」落成的**该行群昵称**），逗号分隔多值。
 * 群昵称改了而这里没跟着改，表里就留下一个查无此人的名字；本人自己改、管理员改那一行、
 * 群名单同步改名三条路都要过这里。
 *
 * 口径（宁可不动，也不乱改）：
 *   1. **逐 token 精确比对**，不做子串替换：只有整段等于旧昵称的 token 才换，
 *      别人的名字（哪怕就是旧昵称加了个后缀）、其余 token 与顺序、重复次数都原样；
 *   2. 旧昵称是固定状态词（等待开启 / 排队中 / 本人已完成）**或**是这一榜的主播名 → 一个字不动：
 *      那两种 token 说的是"状态"或"哪位主播"，不是这一位群友；
 *   3. 这一榜里群昵称等于旧昵称的行**不止一行**（人工改表、重名就会出现）→ 分不清这一格写的是
 *      哪一位 → 整榜不动，把原因交给调用方去说明；
 *   4. 改的范围依据「这个名字在这一榜里唯一对应一个人」+「归属能落到一个 QQ 上」：
 *      - 归属确定（调用方给了 QQ，或绑定反查 `qqsOf` **唯一**命中且记的昵称就是旧昵称）
 *        → 这一榜**所有行**里等于旧昵称的 token 都换（本人那一格是「本人已完成」落的，
 *          别的行是"他帮这一行完成"）；
 *      - 归属确定不了 → 只动被改名的那一行自己那一格（那一格里的旧昵称逐字等于它自己的旧群昵称，
 *        确定就是「本人已完成」落的），别的行一律不动，并给出说明。
 *
 * @param {object} model 榜模型
 * @param {object} opts
 * @param {number} opts.row 被改名的行号
 * @param {string} opts.from 旧群昵称
 * @param {string} opts.to 新群昵称
 * @param {string} [opts.qq] 这个人的 QQ（调用方已知时给出：本人保存自己改、群名单同步）
 * @param {object} [opts.binds] 绑定视图（`bindView` 那种 `{get, qqsOf}`）
 * @param {(row: object) => string} [opts.statusOf] 取某一行**当前**的完成情况：
 *        同一次写入里改了多行时，后面几条要看得到前面几条的结果
 * @returns {{changes: Array<{row:number, status:string}>, skipped: string}} skipped = 没改的原因（空串 = 没跳过）
 */
export const statusRenamePlan = (model, { row, from, to, qq = "", binds = null, statusOf = null } = {}) => {
  /** 固定状态词不是人：改名一律不碰它们（三个字面值与这一列的下拉口径同一份） */
  const statusWords = [WAITING_STATUS, QUEUED_STATUS, SELF_DONE]
  const oldNick = String(from ?? "").trim()
  const newNick = String(to ?? "").trim()
  const at = Number(row) || 0
  const none = { changes: [], skipped: "" }
  if (!model || !at || !oldNick || !newNick || oldNick === newNick) return none
  if (statusWords.includes(oldNick)) return { changes: [], skipped: `「${oldNick}」是状态词、不是人，完成情况没动` }
  if ((model.anchors ?? []).some(a => String(a?.name ?? "").trim() === oldNick))
    return { changes: [], skipped: `「${oldNick}」是这一榜的主播名，完成情况没动` }

  const statusAt = r => String((statusOf ? statusOf(r) : r.status) ?? "")
  const same = (model.rows ?? []).filter(r => String(r.nickname ?? "").trim() === oldNick)
  if (same.length !== 1 || Number(same[0].row) !== at)
    return { changes: [], skipped: `这一榜里有 ${same.length} 行叫「${oldNick}」，分不清完成情况里写的是哪一位，没动` }

  const ids = typeof binds?.qqsOf === "function" ? binds.qqsOf(model.name, at) : []
  const valid = ids.filter(id => String(binds?.get?.(model.name, id)?.nickname ?? "").trim() === oldNick)
  const owner = String(qq ?? "").trim() || (valid.length === 1 ? String(valid[0]) : "")
  const rows = owner ? model.rows ?? [] : same

  /**
   * 枪战复合状态不是逗号分隔：`7.2旧名 7.3等待开启`。
   * 先按 `attackStatusParts` 拆出版本段，只替换 `kind=done` 且 `label` 等于旧昵称的段；
   * 普通榜仍按逗号 token 处理，避免把 `7.2旧名` 当成一个完整名字。
   */
  const renameStatus = status => {
    const attack = attackStatusParts(status)
    if (attack) {
      let hit = false
      const next = attack.map(p => {
        if (p.kind !== "done" || p.label !== oldNick) return p
        hit = true
        return { ...p, label: newNick }
      })
      return hit ? next.map(p => `${p.versions.join("/")}${p.label}`).join(" ") : ""
    }
    const parts = statusTokens(status)
    if (!parts.includes(oldNick)) return ""
    return parts.map(p => (p === oldNick ? newNick : p)).join(",")
  }
  const statusHasNick = status => {
    const attack = attackStatusParts(status)
    if (attack) return attack.some(p => p.kind === "done" && p.label === oldNick)
    return statusTokens(status).includes(oldNick)
  }

  const changes = []
  for (const r of rows) {
    const next = renameStatus(statusAt(r))
    if (!next) continue
    changes.push({ row: r.row, status: next })
  }
  /** 归属不确定：说清楚"只动了本人那一格、别的行为什么没动"（别的行里确实还有这个名字时才提） */
  const others = owner
    ? []
    : (model.rows ?? []).filter(r => Number(r.row) !== at && statusHasNick(statusAt(r)))
  return {
    changes,
    skipped: others.length
      ? `第 ${at} 行没有可依据的 QQ 绑定，只能确认它本人那一格；另外 ${others.length} 行里同样写着「${oldNick}」的没动`
      : "",
  }
}

/**
 * 枪战「等待开启 / 排队中」是随版本开放时间派生的，不能只依赖表里上次保存的死值：
 * 版更后刷新页面就要看到 `7.2排队中`，而不是一直停在 `等待开启`。
 * 已经带完成人的复合状态（`7.2阿修 7.3等待开启`）不能重算，否则会把完成人抹掉。
 */
export const attackDisplayStatus = (sheet, goal, status) => {
  if (!/攻炼|绝境/.test(String(sheet ?? ""))) return status
  const raw = String(status ?? "").trim()
  const parts = attackStatusParts(raw)
  if (parts?.some(part => part.kind === "done")) return attackCompletedStatus(goal, raw)
  if (parts || raw === WAITING_STATUS || raw === QUEUED_STATUS) return attackPendingStatus(goal)
  return raw
}

/**
 * 深渊/危战的裸状态词跟着日历走：表里留着上一周期的「排队中」时，
 * 刷新页面应显示当前周期真正该有的状态，而不是继续沿用旧值。
 * 只改纯状态词；带完成人的复合值不动。
 */
export const cycleDisplayStatus = (sheet, status) => {
  const raw = String(status ?? "").trim()
  if (raw !== WAITING_STATUS && raw !== QUEUED_STATUS) return status
  /** 只修深渊；危战/攻炼的裸状态由各自的周期逻辑处理，不能一起按日历翻 */
  if (!/深境|螺旋/.test(String(sheet ?? ""))) return status
  return defaultStatusOf(sheet)
}

/**
 * 「已完成」的判据（每日整理 / 清榜用）：完成情况写了**人**——主播名，或点「本人已完成」落成的该行群昵称
 *
 * 也就是"既不是「排队中」也不是「等待开启」"；多值（「阿修Axiu,听雨」）同样算已完成。
 * **空着的**不算已完成（那是还没填，整理时跟「排队中」一起放后面）。
 */
export const isDoneStatus = status => {
  const parts = attackStatusParts(status)
  if (parts) return parts.every(part => part.kind === "done")
  const v = String(status ?? "").trim()
  return Boolean(v) && v !== QUEUED_STATUS && v !== WAITING_STATUS
}
