/**
 * 「重新读取」的草稿语义（管理员那一颗按钮）
 *
 * 旧语义：点一下就是整表重读 + **把所有榜的未保存草稿一起清掉**。管理员只是想看看别人改了什么，
 * 回来自己填的整页东西就没了——草稿只在浏览器内存里，没有第二份，用户会以为是自己弄丢的。
 *
 * 现在的语义：
 *   - 默认「重新读取」= 保留草稿 + 用同一套 describeChanges 把"这一版变了什么"列出来；
 *   - 真要丢草稿必须点**另一个**按钮「丢弃草稿并重读」，并且要过二次确认；
 *   - 首次进入页面、保存成功之后照旧（该清的清）——这条语义没被动过。
 *
 * 这些都是**页面状态**里的行为（草稿在内存里、按钮在页面上），接口测试正好绕过它们，
 * 所以把 `editor.html` 的内联脚本原样抽出来在 node:vm 里跑，断言真实处理器造成的状态与请求。
 *
 * 用法：node editor/test/reload-drafts.test.mjs（任意 cwd）
 */
import { bootPage, makeData } from "./page-vm.mjs"

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** 一页三类草稿都填上：成员行备注 + 新增行 + 主播列表 */
const fillAll = async h => {
  h.type(h.rowNo(10), "note", "我的备注")
  h.typeAnchor(0, "skills", "我改的强项")
  await h.click("addRow")
  const tr = h.newRow()
  h.type(tr, "nickname", "新人丙")
  h.type(tr, "gameName", "丙的游戏")
  h.type(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")
}

console.log("「重新读取」的草稿语义（editor.html 原脚本 + 状态断言）")

/* ------------------- ① 默认：保草稿 + 列出差异 ------------------- */

await check("「重新读取」默认保留三类草稿（edited / added / anchorEdited 都还在）", async () => {
  const server = makeData()
  const h = bootPage({ dataFor: () => server })
  await h.ready()
  await fillAll(h)

  /** 另一个窗口在这中间改了同一行的备注（表因此换了版本） */
  server.version = "v2"
  server.sheets[0].rows[0].note = "别人改的备注"
  await h.click("reload")

  must(h.reads().length === 2, `应当重新读一次表，实际读了 ${h.reads().length} 次`)
  must(h.posts("api/save").length === 0, "「重新读取」不该顺手发保存请求（那是自动覆盖）")
  must(h.probe.version === "v2", `重读后没更新手里的版本：${JSON.stringify(h.probe.version)}`)

  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "重新读取把成员行的草稿清掉了")
  must(h.probe.added.length === 1, "重新读取把新增行清掉了")
  must(h.probe.anchorEdited.size === 1, "重新读取把主播列表的草稿清掉了")
  must(h.cellValue(10, "note") === "我的备注", `界面上第 10 行的备注变成了 ${JSON.stringify(h.cellValue(10, "note"))}`)
  must(h.anchorValue(0, "skills") === "我改的强项", `界面上主播强项变成了 ${JSON.stringify(h.anchorValue(0, "skills"))}`)
})

await check("「重新读取」列出这一版的变化（别人改了哪一格看得见）", async () => {
  const server = makeData()
  const h = bootPage({ dataFor: () => server })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  server.version = "v2"
  server.sheets[0].rows[0].note = "别人改的备注"
  await h.click("reload")

  must(h.conflictShown(), "重读之后没有摆出差异条（用户看不到表里变了什么）")
  const diff = h.conflictDiff()
  must(/备注/.test(diff), `差异里没写出改的是哪一格：${JSON.stringify(diff)}`)
  must(/别人改的备注/.test(diff), `差异里没写出改成了什么：${JSON.stringify(diff)}`)
  /** 这条不是"保存冲突"：标题别照抄冲突那套，否则用户会以为自己的保存被拒了 */
  must(!/版本冲突/.test(h.conflictText()), `重读的差异条用了"版本冲突"的文案：${JSON.stringify(h.conflictText())}`)
  must(/重新读取/.test(h.conflictText()), `差异条没说明这是"重新读取"的结果：${JSON.stringify(h.conflictText())}`)
})

await check("没有草稿时点「重新读取」：照旧拉最新 + 提示一句，不摆差异条", async () => {
  const server = makeData()
  const h = bootPage({ dataFor: () => server })
  await h.ready()
  await h.click("reload")
  must(h.reads().length === 2, `应当重新读一次表，实际读了 ${h.reads().length} 次`)
  must(!h.conflictShown(), "本来就没有草稿，却摆出了一条差异提示")
  must(h.toasts().some(t => /已重新读取表格/.test(t)), `提示文案变了：${JSON.stringify(h.toasts())}`)
})

/* ------------------- ② 显式「丢弃草稿并重读」 ------------------- */

await check("「丢弃草稿并重读」+ 确认：三类草稿清空、表数据换成最新", async () => {
  const server = makeData()
  const h = bootPage({ dataFor: () => server, confirm: () => true })
  await h.ready()
  await fillAll(h)
  server.version = "v2"
  server.sheets[0].rows[0].note = "别人改的备注"

  await h.click("reloadDiscard")
  must(h.reads().length === 2, `应当重新读一次表，实际读了 ${h.reads().length} 次`)
  must(h.probe.edited.size === 0, `成员行草稿没清掉：${JSON.stringify([...h.probe.edited.keys()])}`)
  must(h.probe.added.length === 0, "新增行没清掉")
  must(h.probe.anchorEdited.size === 0, "主播列表草稿没清掉")
  must(h.probe.version === "v2", `重读后没更新手里的版本：${JSON.stringify(h.probe.version)}`)
  must(h.cellValue(10, "note") === "别人改的备注", `界面上该显示表里的值，实际 ${JSON.stringify(h.cellValue(10, "note"))}`)
  must(!h.conflictShown(), "丢完草稿重读之后还挂着提示条")
})

await check("「丢弃草稿并重读」二次确认取消：一个草稿都不许丢，也不多发请求", async () => {
  const h = bootPage({ dataFor: () => makeData(), confirm: () => false })
  await h.ready()
  await fillAll(h)
  await h.click("reloadDiscard")

  must(h.reads().length === 1, `用户取消了却还是重读了：读了 ${h.reads().length} 次`)
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "取消之后成员行草稿丢了")
  must(h.probe.added.length === 1, "取消之后新增行丢了")
  must(h.probe.anchorEdited.size === 1, "取消之后主播列表草稿丢了")
})

await check("没有草稿时点「丢弃草稿并重读」：直接说没有草稿，不重读", async () => {
  const h = bootPage({ dataFor: () => makeData() })
  await h.ready()
  await h.click("reloadDiscard")
  must(h.reads().length === 1, `没有草稿却重读了：读了 ${h.reads().length} 次`)
  must(h.toasts().some(t => /没有未保存的草稿/.test(t)), `提示文案变了：${JSON.stringify(h.toasts())}`)
})

/* ------------------- ③ 入口的可见性与原语义 ------------------- */

await check("「重新读取」与「丢弃草稿并重读」都只有管理员看得到", async () => {
  const admin = bootPage()
  await admin.ready()
  must(admin.document.getElementById("reload").style.display === "", "管理员看不到「重新读取」")
  must(admin.document.getElementById("reloadDiscard").style.display === "", "管理员看不到「丢弃草稿并重读」")

  const self = bootPage({ dataFor: () => makeData({ role: "self", readonly: false, nick: "甲" }) })
  await self.ready()
  must(self.document.getElementById("reload").style.display === "none", "本人不该看到「重新读取」")
  must(self.document.getElementById("reloadDiscard").style.display === "none", "本人不该看到「丢弃草稿并重读」")
})

await check("保存成功的原语义没变：只清本次保存那一榜，别的榜草稿照旧留着", async () => {
  const h = bootPage()
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗的备注")
  h.tab(1)
  h.type(h.rowNo(10), "note", "危战的备注")
  await h.click("save")

  const saves = h.posts("api/save")
  must(saves.length === 1 && saves[0].body.sheet === "危战", `先保存的应是危战：${JSON.stringify(saves.map(s => s.body.sheet))}`)
  must(!h.probe.edited.has("危战\u0000" + 10), "保存成功之后本榜的草稿该清掉（原语义）")
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "剧诗的备注", "没保存的那一榜的草稿被清掉了")
})

console.log(failed ? `\n❌ 「重新读取」草稿语义验证失败 ${failed} 项` : "\n✅ 「重新读取」草稿语义验证通过")
process.exit(failed ? 1 : 0)
