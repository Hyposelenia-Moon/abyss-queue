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
globalThis.Bot = {
  pickGroup: gid => ({
    recallMsg: async id => {
      if (fails.has(String(id))) throw new Error("撤回失败（模拟）")
      recalls.push({ gid: String(gid), id: String(id) })
    },
  }),
}

const { messageIdOf, replaceGroupLink, resetGroupLinks } = await import("../modules/group-link.js")

const GROUP = { isGroup: true, group_id: "20000" }

console.log("【1】消息 id 的几种回执形状")
{
  check("message_id", () => assert.equal(messageIdOf({ message_id: "m1" }), "m1"))
  check("messageId", () => assert.equal(messageIdOf({ messageId: "m2" }), "m2"))
  check("data.message_id", () => assert.equal(messageIdOf({ data: { message_id: "m3" } }), "m3"))
  check("取不到就是空串", () => assert.equal(messageIdOf({ ok: true }), ""))
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

finish()
