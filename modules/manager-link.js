/**
 * 主人 / 白名单管理员的**私聊链接**：签发、每 5 分钟换新、记录发给了谁
 *
 * ## 为什么私聊
 *
 * 群里发的是短链（`/s/<码>`，30~60 天），谁先点谁认领——主人 / 管理员那份链接一旦落在群里，
 * 任何人点开都可能拿到管理身份（`editor/claims.js`）。所以这一份**只走私聊**，群里一个字都不发
 * （投递方式的判据在 `apps/queue.js`，名单口径在 `model/whitelist.js`）。
 *
 * ## 为什么每 5 分钟换
 *
 * 私聊里不能用短码：短码在编辑器那条路由上是"点开的那一刻现签窗口"，等于永不过期。
 * 所以私聊发的是**带当期时间窗的长地址**（`components/fill-entry.js` 的 `windowedEditorUrl`，
 * `?w=&ws=`），编辑器只认当期与上一期——链在路上超过一个窗口就作废，**不需要任何额外机制**。
 *
 * 换新由**唯一那条定时任务**驱动（`apps/queue.js` 的 `tick()`）：按"时间窗变没变"决定要不要重发，
 * 窗口没变就一个动作都不做（否则每 3 分钟一条私聊，那是骚扰不是安全）。
 *
 * ## 状态文件
 *
 * `<插件根>/data/manager-link.json`（落点见 components/config.js 的 `managerLinkPath`，没有配置项）：
 *
 *   { updatedAt, recipients: { "<qq>": { nick, window, messageId, at } } }
 *
 * 记这四样就够：**发给了谁**（qq，键）、**哪个窗口**（window，换新的判据）、
 * **消息 id**（messageId，框架支持撤回时用它撤上一条）、**什么时候**（at，排查用）。
 * 昵称只进链接身份（`u.n`，展示与"本人那一行"用），权限只认 QQ —— 别把它当判据。
 *
 * 窗口没变 → 不发；发失败 → 记录保持旧窗口，下一次 tick 还会再试（不会静默丢掉刷新）。
 * 被移出白名单的人**不再刷新**、记录也一并丢掉（链接到期自然失效，不留"编外的人还在收链接"）。
 */
import { config } from "../components/config.js"
import { log } from "../components/logger.js"
import { readJson, writeJson } from "../model/queue-state.js"
import { windowEpoch } from "../model/identity.js"
import { windowedEditorUrl } from "../components/fill-entry.js"
import { managerQqs } from "../model/whitelist.js"

/** 私聊链接状态文件的落点（`<插件根>/data/manager-link.json`） */
export const linkStatePath = () => config.managerLinkPath

/** 换新那条私聊消息的正文（链接在下一行） */
export const REFRESH_TEXT = "【排队】这是新的填表链接（有效期 5 分钟，上一条已作废）"

/**
 * 私聊发不出去时在群里说的那一句
 *
 * 只说明"为什么没反应"，**不带链接**——私发失败也不能把管理链接退回群里。
 */
export const DM_FAILED_TEXT = "填表链接只在私聊里发，但私聊发不出去：请先把机器人加为好友，再加好后重新发一次 #排队"

/** 读状态文件：读不出来（首次运行 / 坏了）当空，下一次照常从零开始记 */
export const readLinkState = (file = linkStatePath()) => {
  const raw = readJson(file)
  const recipients = raw?.recipients
  if (!recipients || typeof recipients !== "object" || Array.isArray(recipients)) return { recipients: {} }
  return { recipients }
}

/** 写状态文件（一个写盘点，与 model/queue-state.js 的读写风格一致） */
export const writeLinkState = (state, file = linkStatePath(), now = Date.now()) =>
  writeJson(file, { updatedAt: Number(now) || 0, recipients: state?.recipients ?? {} })

/**
 * 这一轮该给谁重发（**纯函数**，不读文件、不发消息）
 *
 * 判据只有一条：**记的那个窗口不是当期**。窗口没变就不动作（重复 tick、重启都不会重发）。
 * 顺带把"已经不是管理员"的人从状态里剔除。
 *
 * @param {object} opts
 * @param {object} [opts.state] 上一次的状态（`readLinkState()` 的结果；坏了传 null）
 * @param {number} opts.window 当期窗口号（`model/identity.js` 的 `windowEpoch`）
 * @param {string[]} opts.managers 现在的主人 + 白名单管理员（QQ）
 * @returns {{targets: Array<{qq:string,nick:string,prevId:string}>, state:{recipients:object}}}
 *          targets = 要重发的人（按状态文件里的顺序）；state = 要落盘的新状态（发送成功后再更新那一项）
 */
export function refreshPlan({ state = null, window: win = 0, managers = [] } = {}) {
  const allow = new Set((managers ?? []).map(String))
  const before = state?.recipients && typeof state.recipients === "object" ? state.recipients : {}
  const recipients = {}
  const targets = []
  for (const [key, raw] of Object.entries(before)) {
    const qq = String(key)
    /** 移出白名单的人不再刷新、记录也丢掉：链接窗口一过自然失效 */
    if (!allow.has(qq)) continue
    const rec = {
      nick: String(raw?.nick ?? ""),
      window: Number(raw?.window) || 0,
      messageId: String(raw?.messageId ?? ""),
      at: Number(raw?.at) || 0,
    }
    recipients[qq] = rec
    if (rec.window === Number(win)) continue
    targets.push({ qq, nick: rec.nick, prevId: rec.messageId })
  }
  return { targets, state: { recipients } }
}

/**
 * 框架 `sendMsg` 的返回值 → 消息 id（形态不止一种：`{message_id}` / `[{message_id}]` / 带 `data` 的壳）
 * 拿不到就返回空串（撤回那一步自然跳过，不影响发送）
 */
export const messageIdOf = res => {
  const first = Array.isArray(res) ? res[0] : res
  const id = first?.message_id ?? first?.messageId ?? first?.data?.message_id ?? ""
  return id ? String(id) : ""
}

/**
 * 取私聊会话（TRSS：`Bot.pickFriend(qq)`；没有这个能力就返回 null，由调用方兜底）
 *
 * 这里是"框架既有能力"的唯一入口：群消息走 `Bot.pickGroup`（components/notify-send.js），
 * 私聊走 `Bot.pickFriend`，不自己拼协议、也不去碰别的适配层。
 */
const pickFriend = qq => {
  const id = Number(qq)
  const friend = globalThis.Bot?.pickFriend?.(Number.isFinite(id) ? id : qq)
  return friend?.sendMsg ? friend : null
}

/**
 * 一个私聊发送口子（给 `components/render-html.js` 的 renderOrFallback 用）
 *
 * 发不出去一律**抛错**：那边会据此走文本兜底，两边都失败才轮到调用方报"私聊发不出去"。
 * 成功时把消息 id 记在 `out.messageId` 上——`#排队` 那一次要把 id 一起落盘（撤回 / 排查用）。
 */
export const dmSender = qq => {
  const out = { messageId: "" }
  out.send = async msg => {
    const friend = pickFriend(qq)
    if (!friend) throw new Error("框架没有 Bot.pickFriend（不能私聊）")
    const res = await friend.sendMsg(msg)
    out.messageId = messageIdOf(res)
    return res
  }
  return out
}

/**
 * `#排队` 已经私聊发出去了：把"发给了谁 / 哪个窗口 / 消息 id"记进状态文件
 *
 * 只有**发出去了**才记（没 id 说明发送没成功），否则 tick 会去刷新一条根本不存在的链接。
 * @param {string} qq 收件人
 * @param {object} opts nick / window / messageId / now
 */
export const recordManagerLink = (qq, { nick = "", window: win = 0, messageId = "", now = Date.now() } = {}) => {
  const id = String(qq)
  if (!id || !Number(win) || !messageId) return false
  const state = readLinkState()
  state.recipients[id] = { nick: String(nick ?? ""), window: Number(win), messageId: String(messageId), at: Number(now) || 0 }
  writeLinkState(state, linkStatePath(), now)
  return true
}

/**
 * 给一个人重发当期链接（撤回上一条 → 发新的）
 *
 * 撤回是"能撤就撤"：QQ 只允许撤回 2 分钟内的消息，而我们是每 5 分钟换一次，
 * 所以**撤不回来是常态**，失败不记日志、也不影响接着发新的。
 * @returns {{ok: boolean, messageId: string}}
 */
export async function resendOne({ qq, nick = "", prevId = "", now = Date.now() } = {}) {
  const url = windowedEditorUrl({
    base: String(config.remote?.url ?? "").trim().replace(/\/+$/, ""),
    token: String(config.remote?.token ?? "").trim(),
    signKey: String(config.remote?.sign_key ?? "").trim(),
    qq,
    nick,
    now,
  })
  const friend = pickFriend(qq)
  if (!url || !friend) return { ok: false, messageId: "" }
  if (prevId && typeof friend.recallMsg === "function") {
    try {
      await friend.recallMsg(prevId)
    } catch {
      /* 过期撤不回来是常态（QQ 只给 2 分钟），不打扰日志 */
    }
  }
  const res = await friend.sendMsg(`${REFRESH_TEXT}\n${url}`)
  return { ok: true, messageId: messageIdOf(res) }
}

/**
 * 唯一那条 tick 调用的入口：窗口变了就给每个收过链接的管理员重发一条
 *
 * 单个人失败只记日志、继续下一个人（一个人没加好友不该拖住别人）；
 * 成功的当场落盘，失败的保持旧窗口——下一次 tick 还会再试。
 * @param {object} [opts] now 判定时刻（默认当前时间；**只在回归套件里注入**）
 */
export async function refreshManagerLinks({ now = new Date() } = {}) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  const file = linkStatePath()
  const prev = readLinkState(file)
  const plan = refreshPlan({ state: prev, window: windowEpoch(at), managers: managerQqs() })
  const next = plan.state
  let changed = JSON.stringify(prev.recipients) !== JSON.stringify(next.recipients)
  for (const t of plan.targets) {
    try {
      const out = await resendOne({ qq: t.qq, nick: t.nick, prevId: t.prevId, now: at })
      if (!out.ok) continue
      next.recipients[t.qq] = { nick: t.nick, window: windowEpoch(at), messageId: out.messageId, at: at.getTime() }
      changed = true
    } catch (err) {
      log("warn", `[abyss-queue] 重发私聊链接给 ${t.qq} 失败：${err?.message ?? err}`)
    }
  }
  if (changed) writeLinkState(next, file, at)
}
