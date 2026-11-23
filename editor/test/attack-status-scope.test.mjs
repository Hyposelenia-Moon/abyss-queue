/**
 * 攻炼完成范围（全部 / 部分）
 *
 * **这套能力已经退场**（2026-11 九页重写）：编辑器里点「排队状态」只给
 * `options.status` 里的词（`等待开启` / `排队中` / `本人已完成`），不再有
 * 「全部 / 部分」两个范围按钮；服务端也不再按 scope 重算复合状态
 * （`grep scope editor/editor.mjs` 无命中），复合状态由 `attackPendingStatus()`
 * 按 goal 里的模式自动生成。
 *
 * 保留这个文件是为了**守住剩下的口径**：选择器里不许出现「全部 / 部分」，
 * 攻炼与普通榜的状态选项都只来自 `options.status`。哪天把范围功能加回来，
 * 再把 7.1/7.2/7.3 那几组用例补上。
 */
import assert from "node:assert/strict"
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("攻炼完成范围")

/** 打开某一行的状态选择器，把选项文字与保存后的状态一起取回来 */
async function openStatusPicker({ goal, perm, sheet = "绝境攻炼" } = {}) {
  const data = makeData(perm)
  data.sheets[0].name = sheet
  data.sheets[0].rows[0].goal = goal
  const timers = makeFakeTimers()
  const h = bootPage({ timers, dataFor: () => data })
  await h.ready()
  const tr = h.rowNo(10)
  h.openPicker(tr, "status")
  const options = [...h.el("picker").querySelectorAll(".opt")].map(n => h.textOf(n).trim())
  return { options, h, timers }
}

await check("选择器里不再提供「全部 / 部分」两个范围按钮", async () => {
  const { options } = await openStatusPicker({ goal: "7.1/7.2/7.3模式｜满星章" })
  assert.deepEqual(options, ["等待开启", "排队中", "本人已完成"], `选项是 ${options.join(" / ")}`)
})

await check("普通榜的状态选项与攻炼同一套（不因榜单变形）", async () => {
  const { options } = await openStatusPicker({ goal: "困难模式｜满星章", sheet: "幻想真境剧诗" })
  assert.deepEqual(options, ["等待开启", "排队中", "本人已完成"])
})

await check("本人视图下选项同样只有这三个词", async () => {
  const { options } = await openStatusPicker({
    goal: "7.1/7.2模式｜满星章",
    perm: { role: "self", nick: "甲", readonly: false },
  })
  assert.deepEqual(options, ["等待开启", "排队中", "本人已完成"])
})

await finish()
