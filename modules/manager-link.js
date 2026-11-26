/** 主人 / 白名单管理员的**私聊链接**：签发、记录发给了谁 */
import { config } from "../components/config.js"
import { messageIdOf } from "../components/message-id.js"
import { readJson, writeJson } from "../model/queue-state.js"

export const linkStatePath = () => config.managerLinkPath

export const DM_FAILED_TEXT = "填表链接只在私聊里发，但私聊发不出去：请先把机器人加为好友，再加好后重新发一次 #排队"

export const readLinkState = (file = linkStatePath()) => {
  const raw = readJson(file)
  const recipients = raw?.recipients
  if (!recipients || typeof recipients !== "object" || Array.isArray(recipients)) return { recipients: {} }
  return { recipients }
}

export const writeLinkState = (state, file = linkStatePath(), now = Date.now()) =>
  writeJson(file, { updatedAt: Number(now) || 0, recipients: state?.recipients ?? {} })
export { messageIdOf }

const pickFriend = qq => {
  const id = Number(qq)
  const friend = globalThis.Bot?.pickFriend?.(Number.isFinite(id) ? id : qq)
  return friend?.sendMsg ? friend : null
}

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

export const recordManagerLink = (qq, { nick = "", window: win = 0, messageId = "", now = Date.now() } = {}) => {
  const id = String(qq)
  if (!id || !Number(win) || !messageId) return false
  const state = readLinkState()
  state.recipients[id] = { nick: String(nick ?? ""), window: Number(win), messageId: String(messageId), at: Number(now) || 0 }
  writeLinkState(state, linkStatePath(), now)
  return true
}
