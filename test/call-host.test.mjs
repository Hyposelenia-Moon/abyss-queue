/**
 * 群呼叫宿主回归：编辑器点「呼叫TA」后，真正发群消息这一段
 *
 * 只测宿主侧的 `sendGroupCall`（不启动真编辑器）：
 *   - 群消息必须是 @ 目标 + 「主播喊你回家吃饭了」；
 *   - 目标不在群 / 找不到群 / 发送抛错都要冒出来，不能假装成功。
 *
 * 用法：node test/call-host.test.mjs
 */
import assert from "node:assert/strict"
import { sendGroupCall } from "../modules/editor-host.js"

/** 框架注入的 segment（真实运行时有，测试里补上） */
globalThis.segment = { at: (qq, name) => ({ type: "at", qq, name }) }

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}

const groupOf = ({ member = true, sent = null, fail = null } = {}) => ({
  pickMember: async () => (member ? { qq: "123456" } : null),
  sendMsg: async msg => {
    if (fail) throw fail
    if (sent) sent.push(msg)
  },
})

console.log("群呼叫宿主：")

await check("发到指定群：@ 目标 + 固定文案", async () => {
  const sent = []
  const out = await sendGroupCall({
    qq: "123456",
    nickname: "小明",
    groupId: 777,
    pickGroup: id => {
      assert.equal(id, 777)
      return groupOf({ sent })
    },
    logImpl: () => {},
  })
  assert.deepEqual(out, { sent: true, group: 777 })
  assert.equal(sent.length, 1)
  const text = JSON.stringify(sent[0])
  assert.ok(text.includes("123456"), text)
  assert.ok(text.includes("小明"), text)
  assert.ok(text.includes("主播喊你回家吃饭了"), text)
})

await check("自定义文案：主播区 / 排队区各自带榜名", async () => {
  const sent = []
  await sendGroupCall({
    qq: "123456",
    nickname: "小明",
    groupId: 777,
    text: " 快开播打剧诗了",
    pickGroup: () => groupOf({ sent }),
    logImpl: () => {},
  })
  const text = JSON.stringify(sent[0])
  assert.ok(text.includes("快开播打剧诗了"), text)
  assert.ok(!text.includes("回家吃饭"), text)
})

await check("目标不在群里：拒绝，不硬 @", async () => {
  await assert.rejects(
    () =>
      sendGroupCall({
        qq: "123456",
        groupId: 777,
        pickGroup: () => groupOf({ member: false }),
        logImpl: () => {},
      }),
    /不在这个群里/,
  )
})

await check("框架没有 pickGroup：明确报错", async () => {
  await assert.rejects(
    () =>
      sendGroupCall({
        qq: "123456",
        groupId: 777,
        pickGroup: () => null,
        logImpl: () => {},
      }),
    /Bot\.pickGroup/,
  )
})

await check("发消息抛错：原样冒出来", async () => {
  await assert.rejects(
    () =>
      sendGroupCall({
        qq: "123456",
        groupId: 777,
        pickGroup: () => groupOf({ fail: new Error("风控拦截") }),
        logImpl: () => {},
      }),
    /风控拦截/,
  )
})

await check("空 QQ：直接拒绝", async () => {
  await assert.rejects(
    () => sendGroupCall({ qq: "", groupId: 777, pickGroup: () => groupOf(), logImpl: () => {} }),
    /QQ/,
  )
})

if (failed) {
  console.error(`\n❌ 群呼叫宿主失败：${failed} 项`)
  process.exit(1)
}
console.log("\n✅ 群呼叫宿主验证通过")
