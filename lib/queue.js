/**
 * 排队业务逻辑（纯函数，不依赖 Yunzai / 文件系统，可独立测试）
 */
import { DATA_COLUMNS } from "./schema.js"

const clean = s => String(s ?? "").trim()

/**
 * 把用户输入匹配到下拉选项
 * 支持：完整值、序号（1 起）、唯一的包含匹配
 */
export function matchOption(input, options = []) {
  const text = clean(input)
  if (!text || !options.length) return null
  const exact = options.find(o => o === text)
  if (exact) return exact

  const idx = Number(text)
  if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return options[idx - 1]

  const hits = options.filter(o => o.includes(text) || text.includes(o))
  if (hits.length === 1) return hits[0]
  return null
}

/** 第一个空行（B–H 全空） */
export function firstEmptyRow(model) {
  for (let r = model.dataStart; r <= model.dataEnd; r++) {
    const item = model.rows.find(i => i.row === r)
    if (!item) return r
    if (!DATA_COLUMNS.some(k => clean(item[k]))) return r
  }
  return null
}

/** 按群昵称找行（可能有重名，返回数组） */
export function findByNickname(model, nickname) {
  const text = clean(nickname)
  return model.rows.filter(i => clean(i.nickname) === text)
}

/**
 * 这一行现在**有效归属**给哪些别的 QQ
 *
 * 「有效」= 对方绑定里记的昵称与表里这一行现在的昵称一致。
 * 手工改过表之后留下的那种旧绑定（昵称已经对不上）不算数，否则谁也认不出自己的行了。
 *
 * 之所以要单独拎出来：群昵称是**展示名**、可以重名，而绑定才是身份。
 * 凡是准备"按昵称认领一行"的地方，都要先用它问一句「这行是不是已经是别人的了」。
 */
const otherOwners = (model, store, sheet, row, qq) => {
  const current = clean(model.rows.find(r => r.row === Number(row))?.nickname)
  if (!current) return []
  if (typeof store?.qqsOf !== "function" || typeof store?.get !== "function") return []
  return store
    .qqsOf(sheet, row)
    .filter(id => String(id) !== String(qq))
    .filter(id => clean(store.get(sheet, id)?.nickname) === current)
}

/**
 * 按群昵称找一行（**只认唯一命中，且跳过别人已有效绑定的行**）
 *
 * AQ-02：昵称兜底以前是直接 `rows.find(昵称相同)`，于是两个 QQ 共用同一个群昵称时，
 * 后来的人可以不声不响地拿到先来者已经绑定的那一行（横向越权）。
 * 重名、归属不明时宁可返回"没找到"，让本人去新增 / 找主人确认，也不能认领别人的行——
 * 所以这里要求这个昵称在这一榜里**只出现一次**（表里出现重名时，谁都不自动认领）。
 */
const claimableRow = (model, store, sheet, qq, nick) => {
  const hit = model.rows.filter(r => clean(r.nickname) === nick)
  if (hit.length !== 1) return null
  const row = hit[0]
  return otherOwners(model, store, sheet, row.row, qq).length === 0 ? row : null
}

/**
 * 按 QQ 定位这个人在某一榜里的那一行（**以 QQ 为准**）
 *
 * 表格里没有 QQ 列，所以规则是「先认绑定，再认群昵称」，并且**只认群昵称，不看游戏名**：
 *   1. 有绑定、那一行还在、也没被别的 QQ 有效绑着 → 就是他的行。
 *      表里的群昵称与当前群名片不一致时，返回 `renamedFrom`，由调用方把表里的昵称改成新名片
 *      （群名片是随时可改的，绑定才是稳定的身份）。
 *   2. 绑定指向的行没了，或那一行已经属于别的 QQ → 视为过期：返回 `stale` 并回到昵称兜底，
 *      调用方应当删掉这条失效绑定。
 *   3. 没有绑定 → 按群昵称匹配，**但只认这一榜里唯一的同名行、且那行没有有效归属给别人**；
 *      匹配上说明是首次认人，调用方应记下 `bind`。
 *
 * @param {object} model 榜模型
 * @param {object} store BindStore（有 get / qqsOf 即可）
 * @param {string} sheet 榜名
 * @param {string|number} qq
 * @param {string} nickname 群名片 / 昵称
 * @returns {{row:number, source:"bind"|"nickname"|"none", nick:string, renamedFrom?:string, stale?:boolean, bind?:{row:number,nickname:string}}}
 */
export function locateSelf(model, store, sheet, qq, nickname = "") {
  const nick = clean(nickname)
  const none = { row: 0, source: "none", nick }
  if (!model) return none

  const bind = store?.get?.(sheet, qq)
  if (bind) {
    const item = model.rows.find(r => r.row === Number(bind.row))
    const current = item ? clean(item.nickname) : ""
    /** 这一行是不是已经有效归属给别的 QQ？（只有"对方绑定里的昵称与表里现在一致"才算数） */
    const others = item ? otherOwners(model, store, sheet, bind.row, qq) : []
    /** 行被清空（退队）或已经是别人的记录：绑定作废，请调用方删掉它 */
    if (!item || others.length) {
      const hit = nick ? claimableRow(model, store, sheet, qq, nick) : null
      return hit
        ? { row: hit.row, source: "nickname", nick, stale: true, bind: { row: hit.row, nickname: clean(hit.nickname) } }
        : { ...none, stale: true }
    }
    /** 认绑定：昵称对不上就是本人改了群名片，交给调用方同步表里的昵称 */
    if (current === nick) return { row: item.row, source: "bind", nick }
    return { row: item.row, source: "bind", nick, renamedFrom: current }
  }

  if (!nick) return none
  const hit = claimableRow(model, store, sheet, qq, nick)
  return hit
    ? { row: hit.row, source: "nickname", nick, bind: { row: hit.row, nickname: clean(hit.nickname) } }
    : none
}

/**
 * 找出这个人的行号（0 = 没找到）
 * @returns {number} 表格行号；0 表示没匹配到
 */
export function myRowOf(model, store, sheet, qq, nickname) {
  return locateSelf(model, store, sheet, qq, nickname).row
}

/** 队列（按表内顺序） */
export function listQueue(model, { limit = 0, status = "" } = {}) {
  let list = model.rows.filter(i => clean(i.nickname))
  if (status) list = list.filter(i => i.status === status)
  return limit > 0 ? list.slice(0, limit) : list
}
