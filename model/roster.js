/**
 * 群成员名单 → 在线编辑器
 *
 * 编辑器的「群昵称候选」与"以 QQ 为基准"的日常核对都靠这份名单：
 *   机器人取指定群的成员（群名片优先），签一个**机器人身份**推给云端编辑器；
 *   编辑器存下来当候选，并在收到新名单时按 QQ 对账（改了名片就同步表里的群昵称、
 *   退群/被移出就把对应那行删掉，删之前会自动存历史版本）。
 *
 * 只在配了 `roster.group` 时推送；没配群号就没有推送，本地编辑器因此拿不到群昵称候选。
 */
import { signIdentity } from "./identity.js"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"

/**
 * 机器人专用身份：成员从 #排队 拿到的是**自己 QQ** 的签名，拿不到这个，
 * 所以编辑器只认这个 QQ（或主人）推来的名单，普通成员推不动。
 */
export const ROSTER_QQ = "0"

/**
 * 取群成员列表：把框架给的**各种形状**统一成数组
 *
 * 形状口径：这个 TRSS 版本里 `getMemberMap()` 返回的是**以 QQ 为键的普通对象**（不是 Map），
 * 所以这里把 Map / 普通对象 / 数组 / 异步 `getMemberList` 全吃下来，键里的 QQ 也当兜底。
 * 形状认全了，群名单才推得出去、@ 人也才拿得到群名片。
 */
export async function listMembers(group) {
  if (!group) return []
  /** 统一成"带 qq 字段"的形状：键、值里的 qq / user_id 都当兜底（调用方只认 m.qq 也能用） */
  const norm = list => (Array.isArray(list) ? list : [...list]).map(v => ({ ...(v ?? {}), qq: v?.qq ?? v?.user_id }))
  if (typeof group.getMemberMap === "function") {
    const map = group.getMemberMap()
    if (map instanceof Map) return [...map.entries()].map(([k, v]) => ({ ...(v ?? {}), qq: v?.qq ?? v?.user_id ?? k }))
    if (Array.isArray(map)) return norm(map)
    if (map && typeof map === "object") return Object.entries(map).map(([k, v]) => ({ ...(v ?? {}), qq: v?.qq ?? v?.user_id ?? k }))
  }
  return norm((await group.getMemberList?.()) ?? [])
}

/** 取群成员：返回 [{qq, nick}]，nick 优先用群名片 */
export async function collectMembers(groupId, Bot = globalThis.Bot) {
  const gid = Number(groupId)
  if (!gid) throw new Error("没配群号")
  const group = Bot?.pickGroup?.(gid)
  if (!group) throw new Error("机器人还没有连上，拿不到群成员")
  const list = await listMembers(group)
  const out = []
  const seen = new Set()
  for (const m of list) {
    const qq = String(m?.user_id ?? m?.qq ?? "").trim()
    if (!qq || seen.has(qq)) continue
    seen.add(qq)
    out.push({ qq, nick: String(m?.card ?? "").trim() || String(m?.nickname ?? "").trim() })
  }
  return out
}

/**
 * 最近一次**扫成功**的名单（进程内缓存）
 *
 * 为什么要有它：@ 人要拿"群昵称 → QQ"，而通知是**那一刻**发的——机器人刚重启、
 * 取群成员失败、或群里那一刻取不到名单时，实时名单是空的，于是一条本该 @ 到人的通知
 * 就只能干写名字（表现就是"艾特功能没实现"）。把每次扫描成功的名单记下来兜底，
 * 只要今天扫到过一次，通知就照样 @ 得动。
 *
 * 只放内存、不落盘：它随时可以由下一次扫描（启动后 20 秒那次 kick + 每天一次）重建，
 * 落一份盘反而多一个"和云端那份名单谁更新"的口径要维护（云端那份在编辑器侧的
 * `abyss-editor-roster.json`，是给候选与对账用的）。
 */
let LAST_ROSTER = { group: "", at: 0, members: [] }

/** 记下一次扫成功的名单（`pushRoster` 里调） */
export const rememberRoster = (groupId, members = []) => {
  const list = (Array.isArray(members) ? members : [])
    .map(m => ({ qq: String(m?.qq ?? "").trim(), nick: String(m?.nick ?? "").trim() }))
    .filter(m => m.qq)
  if (!list.length) return LAST_ROSTER
  LAST_ROSTER = { group: String(groupId ?? "").trim(), at: Date.now(), members: list }
  return LAST_ROSTER
}

/** 取缓存名单：群号对不上（换了群）或还没扫过，就返回 null */
export const cachedRoster = groupId => {
  const gid = String(groupId ?? "").trim()
  if (!gid || LAST_ROSTER.group !== gid || !LAST_ROSTER.members.length) return null
  return LAST_ROSTER
}

/** 只给回归套件用：把缓存清掉，免得两条用例互相影响 */
export const forgetRoster = () => {
  LAST_ROSTER = { group: "", at: 0, members: [] }
}

/**
 * 把名单推给云端编辑器（启动时一次 + 每天一次）
 *
 * @returns {Promise<{ok: boolean, skipped?: string, count?: number, renamed?: number, removed?: number, error?: string}>}
 */
export async function pushRoster() {
  const group = String(config.roster?.group ?? "").trim()
  const base = String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
  if (!group) return { ok: false, skipped: "没配 roster.group（群号）" }
  if (!base) return { ok: false, skipped: "没配 remote.url（云端编辑器地址）" }

  try {
    const members = await collectMembers(group)
    /** 空名单绝不能推：编辑器那边会拿它对账，推个空的等于把绑定的人全判成退群 */
    if (!members.length) throw new Error("取到的成员是空的，先不推（避免被当成全员退群）")
    /** 扫成功就记下来：@ 人时实时名单取不到，靠它兜底（见 cachedRoster） */
    rememberRoster(group, members)

    const key = config.remote?.sign_key || config.remote?.token
    const id = signIdentity({ qq: ROSTER_QQ, nick: "群成员名单" }, key)
    if (!id) throw new Error("没有可用的签名密钥（remote.sign_key / remote.token 都是空的）")

    const url = `${base}/api/roster?k=${encodeURIComponent(config.remote?.token ?? "")}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group, members }),
      signal: AbortSignal.timeout(Number(config.remote?.timeout_ms) > 0 ? Number(config.remote.timeout_ms) : 15000),
    })
    const text = await res.text()
    let out = {}
    try {
      out = JSON.parse(text)
    } catch {
      /* 非 JSON 就当失败 */
    }
    if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`)
    log(
      "info",
      `[abyss-queue] 群成员名单已同步到编辑器：${members.length} 人` +
        (out.renamed ? `，改名同步 ${out.renamed} 行` : "") +
        (out.removed ? `，退群删除 ${out.removed} 行` : ""),
    )
    return { ok: true, count: members.length, renamed: out.renamed ?? 0, removed: out.removed ?? 0 }
  } catch (err) {
    log("warn", `[abyss-queue] 推送群成员名单失败：${err?.message ?? err}`)
    return { ok: false, error: err?.message ?? String(err) }
  }
}
