/**
 * 群内链接「只留最新一条」
 *
 * 口径（2026-11-02）：
 *   - 只在群聊里记，私聊链接不参与；
 *   - 新消息发送成功后才撤回上一条；
 *   - 撤回失败只记 warn，不能影响发送。
 */
import assert from "node:assert/strict"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("群内链接撤回")

const recalls = []
const fails = new Set()
/** 这些群模拟「适配器给的 group 对象没有 recallMsg」（Satori 就是这样） */
const noGroupRecall = new Set()
globalThis.Bot = {
  pickGroup: gid => {
    if (noGroupRecall.has(String(gid))) return { group_id: String(gid), sendMsg() {} }
    return {
      recallMsg: async id => {
        if (fails.has(String(id))) throw new Error("撤回失败（模拟）")
        recalls.push({ gid: String(gid), id })
      },
    }
  },
}

const { messageHandlesOf, messageIdOf, messageIdsOf, replaceGroupLink, resetGroupLinks } = await import("../modules/group-link.js")

const GROUP = { isGroup: true, group_id: "20000" }

console.log("【1】消息 id 的几种回执形状")
{
  check("message_id", () => assert.equal(messageIdOf({ message_id: "m1" }), "m1"))
  check("messageId", () => assert.equal(messageIdOf({ messageId: "m2" }), "m2"))
  check("data.message_id", () => assert.equal(messageIdOf({ data: { message_id: "m3" } }), "m3"))
  check("取不到就是空串", () => assert.equal(messageIdOf({ ok: true }), ""))
  check("数组回执取全部 id", () =>
    assert.deepEqual(messageIdsOf([{ message_id: "m4" }, { data: { message_id: "m5" } }, { message_id: "m4" }]), ["m4", "m5"]))
  check("Milky data 原始序号", () => assert.deepEqual(messageHandlesOf({ status: 200, retcode: 0, data: 123 }), [123]))
  check("Milky data.message_seq", () => assert.deepEqual(messageHandlesOf({ data: { message_seq: 456 } }), [456]))
  check("认不出来时保留框架原回执", () => {
    const res = { status: 200, retcode: 0, data: {} }
    assert.deepEqual(messageHandlesOf(res), [res])
  })
}

console.log("【2】同群只留最新一条")
{
  resetGroupLinks()
  recalls.length = 0
  await replaceGroupLink(GROUP, "g1")
  check("第一条没有可撤的", () => assert.equal(recalls.length, 0))
  await replaceGroupLink(GROUP, "g2")
  check("第二条撤第一条", () => assert.deepEqual(recalls, [{ gid: "20000", id: "g1" }]))
  await replaceGroupLink(GROUP, "g3")
  check("第三条撤第二条", () => assert.deepEqual(recalls, [
    { gid: "20000", id: "g1" },
    { gid: "20000", id: "g2" },
  ]))
  await replaceGroupLink(GROUP, "g3")
  check("同一个 id 不重复撤", () => assert.equal(recalls.length, 2))
}

console.log("【2b】不透明回执句柄原样交给 recallMsg")
{
  resetGroupLinks()
  recalls.length = 0
  const h1 = { status: 200, retcode: 0, data: 1 }
  const h2 = { status: 200, retcode: 0, data: 2 }
  await replaceGroupLink(GROUP, h1)
  await replaceGroupLink(GROUP, h2)
  check("对象句柄不强制转字符串", () => assert.equal(recalls[0]?.id, h1))
}

console.log("【3】私聊不参与")
{
  resetGroupLinks()
  recalls.length = 0
  await replaceGroupLink({ isGroup: false, group_id: "20000" }, "p1")
  await replaceGroupLink({ isGroup: false, group_id: "20000" }, "p2")
  check("私聊一条都不撤", () => assert.equal(recalls.length, 0))
  await replaceGroupLink(GROUP, "g1")
  await replaceGroupLink({ isGroup: false, group_id: "20000" }, "p2")
  check("私聊不会顶掉群里的记录", () => assert.equal(recalls.length, 0))
}

console.log("【4】撤回失败只记 warn，不影响新记录")
{
  resetGroupLinks()
  recalls.length = 0
  fails.clear()
  await replaceGroupLink(GROUP, "x1")
  fails.add("x1")
  const prevWarn = globalThis.logger?.warn
  const warns = []
  globalThis.logger = { ...(globalThis.logger ?? {}), warn: (...a) => warns.push(a.join(" ")) }
  try {
    await replaceGroupLink(GROUP, "x2")
  } finally {
    globalThis.logger = { ...(globalThis.logger ?? {}), warn: prevWarn }
  }
  check("撤回失败被记下来", () => assert.equal(warns.length, 1))
  check("下一条仍然撤的是失败那一条", () => {
    assert.deepEqual(recalls, [])
    return true
  })
  fails.delete("x1")
  await replaceGroupLink(GROUP, "x3")
  check("失败后记录仍前移，下一次撤 x2 而不是 x1", () =>
    assert.deepEqual(recalls, [{ gid: "20000", id: "x2" }]))
}

console.log("【5】图文拆成多条消息时，撤掉旧的全部消息 id")
{
  resetGroupLinks()
  recalls.length = 0
  fails.clear()
  await replaceGroupLink(GROUP, ["m1", "m2"])
  check("首条多条回执没有可撤的", () => assert.equal(recalls.length, 0))
  await replaceGroupLink(GROUP, ["m3", "m4"])
  check("下一条撤掉旧的多条消息", () => assert.deepEqual(recalls, [
    { gid: "20000", id: "m1" },
    { gid: "20000", id: "m2" },
  ]))
  recalls.length = 0
  await replaceGroupLink(GROUP, ["m3", "m4", "m5"])
  check("旧 id 里仍存在的部分不重复撤", () => assert.deepEqual(recalls, []))
}

console.log("【6】Satori 回执：主键是 id，不是 message_id")
{
  check("Satori message.create 回执取 id", () =>
    assert.deepEqual(messageHandlesOf({ id: "sat-1", channel: { id: "20001" }, content: "x" }), ["sat-1"]))
  check("数组里混着 Satori 回执", () =>
    assert.deepEqual(messageHandlesOf([{ id: "sat-2", channel: { id: "20001" } }, { message_id: "m9" }]), ["sat-2", "m9"]))
  check("只有 id 的普通对象不误判成 Satori 消息", () => {
    const res = { id: "not-a-message", foo: 1 }
    assert.deepEqual(messageHandlesOf(res), [res])
  })
}

console.log("【7】适配器的群对象没有 recallMsg 时退回 bot 级撤回（Satori）")
{
  resetGroupLinks()
  recalls.length = 0
  fails.clear()
  const gid = "30000"
  noGroupRecall.add(gid)
  const botRecalls = []
  const e = {
    isGroup: true,
    group_id: gid,
    channel_id: "chan-30000",
    group: { group_id: gid, sendMsg() {} },
    bot: {
      recallMsg: async (channelId, id) => {
        botRecalls.push({ channelId: String(channelId), id })
      },
    },
  }
  const prevWarn = globalThis.logger?.warn
  const warns = []
  globalThis.logger = { ...(globalThis.logger ?? {}), warn: (...a) => warns.push(a.join(" ")) }
  try {
    await replaceGroupLink(e, "s1")
    await replaceGroupLink(e, "s2")
  } finally {
    globalThis.logger = { ...(globalThis.logger ?? {}), warn: prevWarn }
    noGroupRecall.delete(gid)
  }
  check("走 bot.recallMsg(channel_id, id)", () =>
    assert.deepEqual(botRecalls, [{ channelId: "chan-30000", id: "s1" }]))
  check("没有 recallMsg 的适配器不再刷 warn", () => assert.equal(warns.length, 0))
}

finish()
