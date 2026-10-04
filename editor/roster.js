/**
 * 群成员名单（机器人推来的）：群昵称候选 + 按 QQ 取当前名片
 *
 * 名单由机器人每天推一次（`POST /api/roster`），存成 `abyss-editor-roster.json`；
 * 编辑器用它做三件事：给页面的"群昵称候选"、给短链补身份昵称、按 QQ 对账表里的昵称。
 *
 * 模块只依赖注入进来的 `deps`，不读全局。
 */
import { readJson, writeJson } from "./util.js"

/**
 * @param {object} deps
 * @param {string} deps.rosterFile 名单文件（生产固定 `<插件根>/data/abyss-editor-roster.json`）
 * @param {() => Promise<object>} deps.store 绑定库（`nickOf` 的兜底来源）；不调用就不必给
 */
export function createRoster({ rosterFile, store }) {
  /** 名单本体：没有就返回空名单（`updatedAt: 0` = 还没收到过） */
  const loadRoster = () => readJson(rosterFile) ?? { group: "", updatedAt: 0, members: [] }

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

  return { loadRoster, saveRoster, nickCandidates, nickOf }
}
