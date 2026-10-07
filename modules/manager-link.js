/**
 * 主人 / 白名单管理员的**私聊链接**：签发、记录发给了谁
 *
 * ## 为什么私聊
 *
 * 群里发的是短链（`/s/<码>`，30~60 天），谁先点谁认领——主人 / 管理员那份链接一旦落在群里，
 * 任何人点开都可能拿到管理身份（`editor/claims.js`）。所以这一份**只走私聊**，群里一个字都不发
 * （投递方式的判据在 `apps/queue.js`，名单口径在 `model/whitelist.js`）。
 *
 * ## 只在本人发 `#排队` 时给一次，5 分钟过期即失效
 *
 * 私聊里不能用短码：短码在编辑器那条路由上是"点开的那一刻现签窗口"，等于永不过期。
 * 所以私聊发的是**带当期时间窗的长地址**（`components/fill-entry.js` 的 `windowedEditorUrl`，
 * `?w=&ws=`），编辑器只认当期与上一期——链在路上超过一个窗口就作废，**不需要任何额外机制**。
 *
 * 这份链接**只在本人发 `#排队` 时给一次**（`apps/queue.js` 的 `menu()`）：窗外没再发过就等下一次
 * `#排队` 拿新的。从前那条"由 tick 每 5 分钟主动重发"的路已去掉——那等于每分钟都在私聊里推链接，
 * 而时间窗本身已经保证旧链过期，主动重发只增加了骚扰与要维护的定时状态。
 *
 * ## 状态文件
 *
 * `<插件根>/data/manager-link.json`（落点见 components/config.js 的 `managerLinkPath`，没有配置项）：
 *
 *   { updatedAt, recipients: { "<qq>": { nick, window, messageId, at } } }
 *
 * 记这四样就够：**发给了谁**（qq，键）、**哪个窗口**（window）、**消息 id**（messageId）、
 * **什么时候**（at，排查用）。昵称只进链接身份（`u.n`，展示与"本人那一行"用），权限只认 QQ。
 */
import { config } from "../components/config.js"
import { readJson, writeJson } from "../model/queue-state.js"

/** 私聊链接状态文件的落点（`<插件根>/data/manager-link.json`） */
export const linkStatePath = () => config.managerLinkPath

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
 * 框架 `sendMsg` 的返回值 → 消息 id（形态不止一种：`{message_id}` / `[{message_id}]` / 带 `data` 的壳）
 * 拿不到就返回空串（发送那一步照常算成功）
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
 * 成功时把消息 id 记在 `out.messageId` 上——`#排队` 那一次要把 id 一起落盘（排查用）。
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
 * 只有**发出去了**才记（没 id 说明发送没成功），否则等于把这次失败记成"链接已经在路上"。
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
