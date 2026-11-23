/**
 * 完成情况菜单：只选人，不选状态
 *
 * **口径**（2026-11 重做）：编辑器里点「排队状态」不再给出「等待开启 / 排队中」——
 * 那两个值是机器算出来的（新行默认值、攻炼按版本开放、清榜自动翻），人手去点只会
 * 和自动逻辑打架。菜单改成三段：本人已完成 / 本榜主播 / 本周期临时成员，
 * 已完成的行额外给一个「改回排队中」把这一格交回自动逻辑。
 *
 * 这套件守住三件事：
 *   1. 菜单里**不许**出现「等待开启 / 排队中」（除非该行已经完成，那是「改回」入口）；
 *   2. 主播组与「选择主播」同一套（`options.anchor`）；
 *   3. 攻炼与普通榜同一套，不因榜单变形。
 */
import assert from "node:assert/strict"
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("完成情况菜单")

/** 打开某一行的状态选择器，把选项文字一起取回来 */
async function openStatusPicker({ goal, perm, sheet = "绝境攻炼", status, temp } = {}) {
  const data = makeData(perm)
  data.sheets[0].name = sheet
  data.sheets[0].rows[0].goal = goal
  if (status !== undefined) data.sheets[0].rows[0].status = status
  if (temp !== undefined) data.sheets[0].statusTemp = temp
  const timers = makeFakeTimers()
  const h = bootPage({ timers, dataFor: () => data })
  await h.ready()
  const tr = h.rowNo(10)
  h.openPicker(tr, "status")
  const options = [...h.el("picker").querySelectorAll(".opt")].map(n => h.textOf(n).trim())
  return { options, h, timers, data }
}

await check("菜单里不再有「等待开启 / 排队中」，只有本人已完成与本榜主播", async () => {
  const { options } = await openStatusPicker({ goal: "7.1/7.2/7.3模式｜满星章", status: "排队中" })
  assert.ok(!options.includes("等待开启"), `不该出现「等待开启」：${options.join(" / ")}`)
  assert.ok(!options.includes("排队中"), `不该出现「排队中」：${options.join(" / ")}`)
  assert.deepEqual(options, ["本人已完成", "阿修Axiu", "听雨"], `选项是 ${options.join(" / ")}`)
})

await check("普通榜与攻炼同一套（不因榜单变形）", async () => {
  const { options } = await openStatusPicker({ goal: "困难模式｜满星章", sheet: "幻想真境剧诗", status: "" })
  assert.deepEqual(options, ["本人已完成", "阿修Axiu", "听雨"], `选项是 ${options.join(" / ")}`)
})

await check("本人视图下也是同一套", async () => {
  const { options } = await openStatusPicker({
    goal: "7.1/7.2模式｜满星章",
    perm: { role: "self", nick: "甲", readonly: false },
  })
  assert.deepEqual(options, ["本人已完成", "阿修Axiu", "听雨"], `选项是 ${options.join(" / ")}`)
})

await check("本周期临时成员单独一组，带紫色玻璃类名", async () => {
  const { options, h } = await openStatusPicker({
    goal: "7.1模式｜满星章",
    status: "",
    temp: ["临时帮忙的阿花"],
  })
  assert.ok(options.includes("临时帮忙的阿花"), `临时成员没进菜单：${options.join(" / ")}`)
  const temp = h.el("picker").querySelector(".opt.temp")
  assert.ok(temp, "临时成员没有 temp 类名（紫色玻璃胶囊）")
  assert.equal(h.textOf(temp).trim(), "临时帮忙的阿花")
})

await check("已完成的行多一个「改回排队中」入口，未完成的行没有", async () => {
  /** 已完成的行不在排队表里（渲染时被滤掉），入口在右栏「已完成」列表 → 抽屉里的那一格 */
  const data = makeData()
  data.sheets[0].name = "绝境攻炼"
  data.sheets[0].rows[0].goal = "7.1模式｜满星章"
  data.sheets[0].rows[0].status = "7.1阿修Axiu"
  const timers = makeFakeTimers()
  const h = bootPage({ timers, dataFor: () => data })
  await h.ready()
  h.doneRow(10).onclick({ stopPropagation() {} })
  h.el("msBody").querySelector('[data-pick="status"]').onclick({ stopPropagation() {} })
  const done = [...h.el("picker").querySelectorAll(".opt")].map(n => h.textOf(n).trim())
  assert.ok(done.includes("改回排队中"), `已完成的行没有改回入口：${done.join(" / ")}`)

  const queued = await openStatusPicker({ goal: "7.1模式｜满星章", status: "排队中" })
  assert.ok(!queued.options.includes("改回排队中"), `排队中的行不该有改回入口：${queued.options.join(" / ")}`)
})

await check("点主播名落表的是裸名字（攻炼的版本由服务端包）", async () => {
  const { h, timers } = await openStatusPicker({ goal: "7.1模式｜满星章", status: "" })
  h.pickOption(h.rowNo(10), "status", "阿修Axiu")
  timers.advance(1300)
  await h.ready()
  const sent = h.posts("api/save").at(-1)
  assert.ok(sent, "没有发出保存请求")
  assert.equal(sent.body.rows[0].values.status, "阿修Axiu", `落表值不对：${JSON.stringify(sent.body.rows[0].values)}`)
})

await finish()
