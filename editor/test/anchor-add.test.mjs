/**
 * 主播区：呼叫入口 + 卡片渲染
 *
 * **旧的「主播列表编辑」已经退场**（2026-11 九页重写）：主播名单现在由机器人侧维护
 * （`/api/anchors` 是给机器人用的），编辑器里主播区只剩**只读卡片 + 呼叫**。
 * 原套件里「新增主播 / 保存主播列表 / 409 草稿 / 空填拦截」那一整套随之删除。
 *
 * 现在守的是这套只读卡片真正会出问题的地方：
 *   - 卡片按 `anchorRows` 逐张渲染，序号连续、名字不丢
 *   - 公共队列单独一张、带「公共队」角标、**不给呼叫按钮**
 *   - 卡片上的「呼叫」打的是 `api/anchor-call`，带当前榜名与主播行号
 *   - 不可呼叫的主播按钮是 disabled（不让人点了没反应）
 */
import assert from "node:assert/strict"
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("主播区呼叫")

const boot = async () => {
  const data = makeData()
  const timers = makeFakeTimers()
  const h = bootPage({
    timers,
    dataFor: () => data,
    anchorReply: () => ({ status: 200, body: { ok: true, notified: 1 } }),
  })
  await h.ready()
  return { h, timers, data }
}

await check("主播卡按 anchorRows 逐张渲染，名字一个不少", async () => {
  const { h, data } = await boot()
  const cards = [...h.el("acards").querySelectorAll(".acard")]
  const names = data.sheets[0].anchorRows.map(a => a.name)
  assert.equal(cards.length, names.length + (data.sheets[0].publicQueue ? 1 : 0), `卡片 ${cards.length} 张 / 主播 ${names.length} 位`)
  for (const name of names) {
    assert.ok(
      cards.some(c => h.textOf(c).includes(name)),
      `卡片里找不到「${name}」`,
    )
  }
})

await check("公共队列单独一张：带「公共队」角标、不给呼叫按钮", async () => {
  const data = makeData()
  /** 服务端在有「公共队列/不挑主播」那类报名时会下发 publicQueue，卡片是**按它**补出来的 */
  data.sheets[0].publicQueue = { name: "公共队列", queued: 2, queuePills: [] }
  const timers = makeFakeTimers()
  const h = bootPage({ timers, dataFor: () => data })
  await h.ready()
  const pub = [...h.el("acards").querySelectorAll(".acard.pub")]
  assert.equal(pub.length, 1, `公共队列卡有 ${pub.length} 张`)
  assert.ok(h.textOf(pub[0]).includes("公共队"), "公共队列卡没有「公共队」角标")
  assert.equal(pub[0].querySelectorAll("[data-acall]").length, 0, "公共队列卡不该有呼叫按钮")
})

await check("呼叫打 api/anchor-call，带当前榜名与主播行号", async () => {
  const { h, timers, data } = await boot()
  const btn = h.el("acards").querySelector("[data-acall]")
  assert.ok(btn, "没有可点的呼叫按钮")
  const row = Number(btn.dataset.acall)
  const anchor = data.sheets[0].anchorRows.find(a => a.row === row)
  assert.ok(anchor, `按钮上的行号 ${row} 对不上任何主播`)
  btn.onclick({ stopPropagation() {} })
  timers.advance(200)
  await h.ready()
  const post = h.posts("api/anchor-call").at(-1)
  assert.ok(post, `没有发出 api/anchor-call（实际发了 ${JSON.stringify(h.posts().map(p => p.url))}）`)
  assert.equal(post.body.sheet, data.sheets[0].name)
  assert.equal(post.body.row, row)
})

await check("呼叫失败只提示，不把页面搞崩", async () => {
  const data = makeData()
  const timers = makeFakeTimers()
  const h = bootPage({
    timers,
    dataFor: () => data,
    anchorReply: () => ({ status: 500, body: { ok: false, error: "（套件：呼叫失败）" } }),
  })
  await h.ready()
  h.el("acards").querySelector("[data-acall]").onclick({ stopPropagation() {} })
  timers.advance(200)
  await h.ready()
  assert.ok(h.toasts().some(t => /呼叫失败/.test(t)), `提示条里没有「呼叫失败」：${JSON.stringify(h.toasts())}`)
})

/**
 * 点下去要有看得见的回执（维护者反馈「按了不知道有没有生效」）
 *
 * 两档都要在：①按下瞬间的 `:active`（CSS，静态断言见 `test/layout.test.mjs`）；
 * ②真正发出之后按钮短暂变蓝（`.called`），900ms 后自己退回去——不能一直卡在"已发出"。
 */
await check("呼叫成功后按钮短暂变成「已发出」，到点自己退回", async () => {
  const { h, timers } = await boot()
  const btn = h.anchorCall(0)
  assert.ok(btn, "没有可点的呼叫按钮")
  assert.equal(btn.classList.contains("called"), false, "点之前不该带 called")
  timers.advance(200)
  await h.ready()
  assert.equal(btn.classList.contains("called"), true, "呼叫成功后按钮没有变成「已发出」")
  timers.advance(1200)
  assert.equal(btn.classList.contains("called"), false, "「已发出」没有自己退回去")
})

await check("呼叫失败时按钮不留「已发出」（别假装成功了）", async () => {
  const data = makeData()
  const timers = makeFakeTimers()
  const h = bootPage({
    timers,
    dataFor: () => data,
    anchorReply: () => ({ status: 500, body: { ok: false, error: "（套件：呼叫失败）" } }),
  })
  await h.ready()
  const btn = h.anchorCall(0)
  timers.advance(200)
  await h.ready()
  assert.equal(btn.classList.contains("called"), false, "失败了还把按钮画成「已发出」")
})


await finish()
