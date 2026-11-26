/** 自动保存 —— 九页重写后的口径 */
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"
import { createSoftChecker, must } from "../../test/_helper.mjs"

const { check, finish } = createSoftChecker("自动保存验证")

/** 页面里的防抖是 1200ms（`editor.html` 的 `setTimeout(saveNow, 1200)`），少于它就算"提前发了" */
const DELAY = 1200

/** 状态文字现在写的是什么 */
const state = h => h.el("saveState").textContent
/** 状态文字有没有标红（`setState('bad', …)` 会加 `bad`） */
const stateBad = h => h.el("saveState").className.includes("bad")

console.log("自动保存（editor.html 现脚本 + 假时钟 + 请求捕获）")

/* ------------------- ① 「保存」按钮彻底不在 ------------------- */

await check("「保存」按钮彻底不在：DOM 里没有 id=\"save\"，脚本里也不再按 id 取它", async () => {
  const { readFileSync } = await import("node:fs")
  const html = readFileSync(new URL("../editor.html", import.meta.url), "utf8")
  must(!/id=["']save["']/.test(html), '页面里又出现了 id="save" 的「保存」按钮')
  must(!/getElementById\(\s*["']save["']\s*\)/.test(html), "页面脚本里还在按 id 取「保存」按钮")
  must(/id=["']saveState["']/.test(html), "没有找到状态文字 #saveState")
  const h = bootPage({ timers: makeFakeTimers() })
  await h.ready()
  must(h.el("saveState").className.includes("savestate"), `状态文字的类名不对：${JSON.stringify(h.el("saveState").className)}`)
  must(state(h) === "已保存", `进页面时状态文字应当是「已保存」，实际 ${JSON.stringify(state(h))}`)
})

/* ------------------- ② 防抖 1200ms ------------------- */

await check("改完 1.2 秒才自动存；连着改只发一发，且两处改动都在同一个请求里", async () => {
  const h = bootPage({ timers: makeFakeTimers() })
  await h.ready()
  const tr = h.rowNo(10)
  h.type(tr, "note", "第一处")
  h.advance(DELAY - 100)
  await h.ready()
  must(h.posts("api/save").length === 0, `还没到 1.2 秒就发了 ${h.posts("api/save").length} 个保存请求`)
  must(/未保存/.test(state(h)), `改完应当先写「未保存（有改动）」，实际 ${JSON.stringify(state(h))}`)
  h.type(tr, "note", "第二处")
  h.advance(DELAY - 100)
  await h.ready()
  must(h.posts("api/save").length === 0, "第二处改动没有把防抖重新计时（提前发了）")
  h.advance(200)
  await h.ready()
  const saves = h.posts("api/save")
  must(saves.length === 1, `连着改两处应当只发一发，实际 ${saves.length} 发`)
  const row = saves[0].body.rows[0]
  must(row.values.note === "第二处", `请求里的备注是 ${JSON.stringify(row.values.note)}，应当是后一次的值`)
  must(state(h) === "已保存", `存完状态文字应当是「已保存」，实际 ${JSON.stringify(state(h))}`)
  must(h.probe.dirty.length === 0, "保存成功后草稿没清干净")
})

/* ------------------- ③ 必填没齐 ------------------- */

await check("必填四项没齐：一个请求都不发，状态写清「有必填没补全」并标红；补齐后自动发", async () => {
  const h = bootPage({ timers: makeFakeTimers() })
  await h.ready()
  const tr = h.rowNo(10)
  h.type(tr, "gameName", "")
  h.advance(DELAY + 200)
  await h.ready()
  must(h.posts("api/save").length === 0, `必填没齐还发了 ${h.posts("api/save").length} 个保存请求`)
  must(/必填没补全/.test(state(h)), `状态文字没说清是必填的问题：${JSON.stringify(state(h))}`)
  must(stateBad(h), "必填没齐时状态文字没有标红")
  h.type(tr, "gameName", "补上的游戏名")
  h.advance(DELAY + 200)
  await h.ready()
  const saves = h.posts("api/save")
  must(saves.length === 1, `补齐之后应当发一发，实际 ${saves.length} 发`)
  must(saves[0].body.rows[0].values.gameName === "补上的游戏名", "补齐的值没进请求")
})

/* ------------------- ④ 状态文字与失败 ------------------- */

await check("状态文字：发的瞬间「保存中…」、成功「已保存」；失败「保存失败：…」且不自动重试", async () => {
  const h = bootPage({ timers: makeFakeTimers() })
  await h.ready()
  let sawSaving = ""
  const origFetch = h.ctx.fetch
  h.ctx.fetch = async (...args) => {
    if (String(args[0]).includes("api/save") && !sawSaving) sawSaving = state(h)
    return origFetch(...args)
  }
  h.type(h.rowNo(10), "note", "看看状态字")
  h.advance(DELAY + 200)
  await h.ready()
  must(sawSaving === "保存中…", `发请求那一刻状态文字是 ${JSON.stringify(sawSaving)}，应当是「保存中…」`)
  must(state(h) === "已保存", `成功之后是 ${JSON.stringify(state(h))}`)
  must(!stateBad(h), "成功后状态文字还挂着标红")
  const bad = bootPage({
    timers: makeFakeTimers(),
    saveReply: () => ({ status: 500, body: { ok: false, error: "服务器炸了" } }),
  })
  await bad.ready()
  bad.type(bad.rowNo(10), "note", "存不上的一笔")
  bad.advance(DELAY + 200)
  await bad.ready()
  must(/服务器炸了/.test(state(bad)), `失败时状态文字没说原因：${JSON.stringify(state(bad))}`)
  must(stateBad(bad), "失败时状态文字没有标红")
  must(bad.toasts().some(t => /服务器炸了/.test(t)), `失败时没弹提示：${JSON.stringify(bad.toasts())}`)
  const once = bad.posts("api/save").length
  bad.advance(DELAY * 3)
  await bad.ready()
  must(bad.posts("api/save").length === once, "失败之后自动重试了（应当等用户自己再改一次）")
})

/* ------------------- ⑤ 只读身份 ------------------- */

await check("只读身份：格子禁用、新增行隐藏、改了也不发请求", async () => {
  const h = bootPage({
    timers: makeFakeTimers(),
    dataFor: () => makeData({ role: "guest", readonly: true, changes: false, versions: false, manage: false }),
  })
  await h.ready()
  const tr = h.rowNo(10)
  const box = tr.querySelector("textarea[data-edit]")
  must(box && box.hasAttribute("disabled"), "只读身份下昵称/备注格子没有禁用")
  must(h.el("addRow").style.display === "none", "只读身份下「＋ 新增一行」还露着")
  must(!h.el("undoBtn").style.display || h.el("undoBtn").style.display === "none", "只读身份下还露着回退按钮")
  h.type(tr, "note", "只读也想改")
  h.advance(DELAY * 2)
  await h.ready()
  must(h.posts("api/save").length === 0, `只读身份下还是发了 ${h.posts("api/save").length} 个保存请求`)
})

/* ------------------- ⑥ 新增行 ------------------- */

await check("新增行：请求里不带 base 指纹；保存成功后整份重读、本地那一行退场", async () => {
  let served = makeData()
  const h = bootPage({ timers: makeFakeTimers(), dataFor: () => served })
  await h.ready()
  await h.click("addRow")
  await h.ready()
  const fresh = h.newRow()
  must(fresh, "点了「＋ 新增一行」界面没多出一行")
  must(/新行待填写/.test(state(h)), `新增行之后应当提示「新行待填写」，实际 ${JSON.stringify(state(h))}`)
  h.type(fresh, "nickname", "新来的")
  h.type(fresh, "gameName", "新来的游戏")
  /** 主播与目标也是必填：不补这两样的话页面按设计一个请求都不发 */
  h.pick(fresh, "anchor", "阿修Axiu")
  h.pick(fresh, "goal", "困难模式满星章")
  h.type(fresh, "note", "新增行的备注")
  h.advance(DELAY + 200)
  await h.ready()
  const saves = h.posts("api/save")
  must(saves.length === 1, `应当发一发，实际 ${saves.length} 发`)
  const sent = saves[0].body.rows[0]
  must(sent.values.nickname === "新来的", `新增行没进请求：${JSON.stringify(sent.values)}`)
  must(!Object.prototype.hasOwnProperty.call(saves[0].body.base || {}, String(sent.row)), "新增行不该带 base 指纹（表里本来就没这行）")
  /** 服务端把这一行真的写进表后重读：本地那行必须退场，不能和落表后的那行并存成"两行" */
  served = makeData()
  served.sheets[0].rows.push({
    row: 11,
    seq: 2,
    nickname: "新来的",
    gameName: "新来的游戏",
    anchor: "阿修Axiu",
    goal: "困难模式满星章",
    note: "新增行的备注",
    status: "排队中",
    fp: "fp11",
  })
  h.advance(1)
  await h.ready()
  must(h.reads("api/data").length >= 2, "保存成功后没有整份重读 api/data")
  must(h.probe.dirty.length === 0, "保存成功后草稿没清干净")
  const rows = h.gridRows().filter(t => t.querySelector(".seqcell")?.textContent.trim() === "新")
  must(rows.length === 0, "保存成功后本地那条「新」行还留在界面上（会和落表后的行并存）")
})

await finish()
