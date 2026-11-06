import assert from "node:assert/strict"
import vm from "node:vm"
import { bootPage, makeData, makeFakeTimers, FIELDS } from "./page-vm.mjs"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("攻炼完成范围")
const versions = [
  { version: "7.1", preset: "7.1模式", open_at: "2026-09-30 10:00", modes: [] },
  { version: "7.2", preset: "7.2模式", open_at: "2026-11-04 10:00", modes: [] },
  { version: "7.3", preset: "7.3模式", open_at: "2026-12-16 10:00", modes: [] },
]

async function choose(goal, { scope, perm, sheet = "绝境攻炼", person = "阿修Axiu" } = {}) {
  const data = makeData(perm)
  data.sheets[0].name = sheet
  data.sheets[0].rows[0].goal = goal
  data.sheets[0].options = { ...data.sheets[0].options, attackVersions: versions }
  const timers = makeFakeTimers()
  const h = bootPage({ timers, dataFor: () => data })
  await h.ready()
  vm.runInContext("Date.now=()=>Date.parse('2026-11-06T12:00:00+08:00')", h.ctx)
  const tr = h.rowNo(10)
  const shifted = tr.childNodes.some(n => String(n.className).split(" ").includes("call")) ? 1 : 0
  const td = tr.childNodes[FIELDS.findIndex(f => f.key === "status") + 1 + shifted]
  const walk = node => (node.childNodes ?? []).flatMap(n => [n, ...walk(n)])
  const text = node => (node.textContent || "") + (node.childNodes ?? []).map(text).join("")
  const buttons = () => walk(td).filter(n => n.tagName === "BUTTON")
  const click = name => {
    const button = buttons().find(n => text(n) === name)
    assert.ok(button, `没有按钮 ${name}`)
    button.onclick({ stopPropagation() {} })
  }
  buttons().find(n => n.className.includes("addbtn")).onclick({ stopPropagation() {} })
  const options = buttons().filter(n => String(n.className).split(" ").includes("opt")).map(text)
  if (scope) click(scope)
  click(person)
  vm.runInContext("closePicker()", h.ctx)
  timers.advance(1500)
  await h.ready()
  await h.ready()
  return { options, status: h.posts("api/save")[0]?.body?.rows?.[0]?.values?.status }
}

await check("一个已开放版本时不提供结果相同的全部/部分", async () => {
  const out = await choose("7.2/7.3模式｜满星章")
  assert.ok(!out.options.includes("部分"))
  assert.equal(out.status, "7.2阿修Axiu 7.3等待开启")
})

await check("两个已开放版本可只完成最近版本", async () => {
  const out = await choose("7.1/7.2模式｜满星章", { scope: "部分" })
  assert.equal(out.status, "7.1排队中 7.2阿修Axiu")
})

await check("两个已开放版本全部完成仍写全部版本", async () => {
  const out = await choose("7.1/7.2模式｜满星章", { scope: "全部" })
  assert.equal(out.status, "7.1/7.2阿修Axiu")
})

await check("部分完成保留未来版本等待状态", async () => {
  const out = await choose("7.1/7.2/7.3模式｜满星章", { scope: "部分" })
  assert.equal(out.status, "7.1排队中 7.2阿修Axiu 7.3等待开启")
})

await check("本人菜单仍只允许本人完成", async () => {
  const out = await choose("7.1/7.2模式｜满星章", {
    perm: { role: "self", nick: "甲", readonly: false },
    person: "本人已完成",
  })
  assert.deepEqual(out.options, ["本人已完成"])
  assert.equal(out.status, "7.1/7.2甲")
})

await check("普通榜完成菜单不受攻炼范围改动影响", async () => {
  const out = await choose("困难模式满星章", { sheet: "幻想真境剧诗", person: "本人已完成" })
  assert.ok(!out.options.includes("全部") && !out.options.includes("部分"))
  assert.equal(out.status, "甲")
})

await finish()
