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
import { readJson, writeJson } from "./queue-state.js"
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
 * 最近一次**扫成功**的名单：内存一份 + **落盘一份**
 *
 * 为什么要有它：@ 人要拿"群昵称 → QQ"，而通知是**那一刻**发的——机器人刚重启、
 * 取群成员失败、或群里那一刻取不到名单时，实时名单是空的，于是一条本该 @ 到人的通知
 * 就只能干写名字（表现就是"艾特功能没实现"）。把每次扫描成功的名单记下来兜底，
 * 只要扫到过一次，通知就照样 @ 得动。
 *
 * **落盘**（`<插件根>/data/roster.json`，与绑定 / 进度同档、没有配置项）：
 * 只放内存的话"重启到下一次扫描之间"等于没有，而且"本地到底有没有名单"在插件侧无从查起
 * （维护者就是这么找上门的）。文件里只有 `{ group, at, members: [{qq, nick}] }`——
 * 每台机器人只有一份"自己扫到的名单"，不存在跟谁比新旧的问题。
 * 读盘**懒加载**（第一次要用才读），坏文件当没有。
 */
let LAST_ROSTER = { group: "", at: 0, members: [] }
/** 读盘有没有做过：`forgetRoster()` 之后置真，避免"刚清掉又被盘上的旧值读回来" */
let rosterLoaded = false

/** 统一成形（盘上的、框架给的都过这一道） */
const normMembers = members =>
  (Array.isArray(members) ? members : [])
    .map(m => ({ qq: String(m?.qq ?? "").trim(), nick: String(m?.nick ?? "").trim() }))
    .filter(m => m.qq)

/** 第一次要用时从盘上读回来（读不出来 / 结构不对 / 空的都当没有，不抛错） */
const loadRosterFromDisk = () => {
  if (rosterLoaded) return LAST_ROSTER
  rosterLoaded = true
  const raw = readJson(config.rosterPath)
  const list = normMembers(raw?.members)
  if (!list.length) return LAST_ROSTER
  LAST_ROSTER = { group: String(raw?.group ?? "").trim(), at: Number(raw?.at) || 0, members: list }
  return LAST_ROSTER
}

/**
 * 记下一次扫成功的名单（`pushRoster` 里调）：内存 + 盘上都写
 *
 * 空名单不写（那是"没扫到"，不是"扫到了空群"）。
 */
export const rememberRoster = (groupId, members = []) => {
  const list = normMembers(members)
  if (!list.length) return LAST_ROSTER
  LAST_ROSTER = { group: String(groupId ?? "").trim(), at: Date.now(), members: list }
  rosterLoaded = true
  writeJson(config.rosterPath, LAST_ROSTER)
  return LAST_ROSTER
}

/** 取缓存名单：群号对不上（换了群）或还没扫过，就返回 null（内存没有会先读一次盘） */
export const cachedRoster = groupId => {
  const gid = String(groupId ?? "").trim()
  const cache = LAST_ROSTER.members.length || rosterLoaded ? LAST_ROSTER : loadRosterFromDisk()
  if (!gid || cache.group !== gid || !cache.members.length) return null
  return cache
}

/**
 * 只给回归套件用：把缓存清掉，免得两条用例互相影响
 *
 * `rosterLoaded = true` 也是清的一部分：清完就不该再从盘上把同一个名单读回来
 * （否则"两边都拿不到"那条用例会被上一次扫描留下的文件救活）。
 */
export const forgetRoster = () => {
  LAST_ROSTER = { group: "", at: 0, members: [] }
  rosterLoaded = true
}

/** 只给回归套件用：假装刚重启——下次取缓存时会重新读一遍盘 */
export const reloadRosterFromDisk = () => {
  LAST_ROSTER = { group: "", at: 0, members: [] }
  rosterLoaded = false
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
