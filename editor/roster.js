/**
 * 群成员名单（机器人推来的）：群昵称候选 + 按 QQ 取当前名片 + **本群守卫**（谁能改表）
 *
 * 名单由机器人每天推一次（`POST /api/roster`），存成 `abyss-editor-roster.json`；
 * 编辑器用它做四件事：给页面的"群昵称候选"、给短链补身份昵称、按 QQ 对账表里的昵称、
 * 以及**判断这条链接的身份在不在本群里**（不在 ⇒ 只读；判不了 ⇒ 不放权也不拒人）。
 *
 * 模块只依赖注入进来的 `deps`，不读全局。
 */
import { readJson, writeJson } from "./util.js"

/** 名单**还能当权限用**的时长：超过它就不据此拒人（只提醒主人去同步），见 `trusted()` */
export const ROSTER_TRUST_MS = 48 * 60 * 60 * 1000

/**
 * @param {object} deps
 * @param {string} deps.rosterFile 名单文件（生产固定 `<插件根>/data/abyss-editor-roster.json`）
 * @param {() => Promise<object>} deps.store 绑定库（`nickOf` 的兜底来源）；不调用就不必给
 * @param {number} [deps.trustMs] 名单当权限用的时长（默认 48 小时；套件可以调小来验过期）
 */
export function createRoster({ rosterFile, store, trustMs = ROSTER_TRUST_MS }) {
  /** 名单本体：没有就返回空名单（`updatedAt: 0` = 还没收到过） */
  const loadRoster = () => readJson(rosterFile) ?? { group: "", updatedAt: 0, members: [] }

  /**
   * 这份名单现在**能不能当权限用**
   *
   * 三条件缺一不可：收到过（`updatedAt` 非零）、**不是空的**、还没超过 `trustMs`。
   *
   * 为什么"不能当权限用"时选**放行**而不是"一律拒绝"：名单同步依赖网络 + 机器人 + 云端地址，
   * 任一出问题当天就失败；那种时候把全群变成只读，"所有人都不能填"比"个别退群的人还能写"
   * 严重得多（后者有改动记录与回滚兜底）。**不放权也不拒人**：退回"只能改自己那一行"的老口径。
   */
  const trusted = (now = Date.now()) => {
    const r = loadRoster()
    if (!r.updatedAt || !(r.members ?? []).length) return false
    return now - Number(r.updatedAt) <= Math.max(0, Number(trustMs) || 0)
  }

  /**
   * 这个 QQ 现在是不是本群成员
   *
   * @returns {true|false|null} `true` 在名单里、`false` 不在名单里、**`null` = 名单不可信、判不了**
   *   （调用方据此"不放权也不拒人"）
   */
  const isMember = (qq, now = Date.now()) => {
    const id = String(qq ?? "").trim()
    if (!id || !trusted(now)) return null
    return (loadRoster().members ?? []).some(m => String(m?.qq ?? "").trim() === id)
  }

  /** 名单多久没更新了（毫秒；没收到过返回 `Infinity`）——告警文案要用 */
  const ageMs = (now = Date.now()) => {
    const r = loadRoster()
    return r.updatedAt ? now - Number(r.updatedAt) : Infinity
  }

  /** 群昵称候选：名单里的昵称（去重、按中文排序） */
  const nickCandidates = () => {
    const set = new Set()
    for (const m of loadRoster().members ?? []) {
      const n = String(m?.nick ?? "").trim()
      if (n) set.add(n)
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"))
  }

  /**
   * 按 QQ 取这个人**现在的群名片**：群名单（机器人每天推）优先，其次本机绑定记录
   *
   * 短链里的码不放群昵称（中文名一进码就长了），所以身份的 `n` 由这里补上——
   * 机器人签长链接时带的也是同一个东西（发送者当前的群名片）。
   */
  const nickOf = async qq => {
    const id = String(qq ?? "").trim()
    if (!id) return ""
    const fromRoster = String((loadRoster().members ?? []).find(m => String(m?.qq ?? "").trim() === id)?.nick ?? "").trim()
    if (fromRoster) return fromRoster
    const bindStore = await store()
    for (const sheet of bindStore.sheetsOf(id)) {
      const nick = String(bindStore.get(sheet, id)?.nickname ?? "").trim()
      if (nick) return nick
    }
    return ""
  }

  /**
   * 落盘一份新名单（`POST /api/roster` 用）
   *
   * **只做存储**：空名单该不该拒、拒了之后要不要对账，都在路由里判——
   * 那属于接口的输入校验，不是"名单怎么存"。
   */
  const saveRoster = ({ group = "", members = [] } = {}) => {
    writeJson(rosterFile, {
      group: String(group ?? "").trim(),
      updatedAt: Date.now(),
      members: members.map(m => ({ qq: String(m?.qq ?? "").trim(), nick: String(m?.nick ?? "").trim() })).filter(m => m.qq),
    })
  }

  return { loadRoster, saveRoster, nickCandidates, nickOf, trusted, isMember, ageMs }
}
