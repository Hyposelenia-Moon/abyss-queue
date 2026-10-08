/**
 * 「重新读取」与「回到上一次修改状态」的语义（头部那两颗按钮）
 *
 * 旧语义：点一下就是整表重读 + **把所有榜的未保存草稿一起清掉**。管理员只是想看看别人改了什么，
 * 回来自己填的整页东西就没了——草稿只在浏览器内存里，没有第二份，用户会以为是自己弄丢的。
 *
 * 现在的语义：
 *   - 「重新读取」= 保留草稿 + 用同一套 describeChanges 把"这一版变了什么"列出来；
 *   - 「回到上一次修改状态」（原「丢弃草稿并重读」）= **服务端回退**：把表换回版本目录里最新那份
 *     （写表前都会存一份；自动保存那条路有 5 分钟节流，所以它是"最近一次留底之前的状态"），走 `POST /api/restore`，
 *     只在主人可见（接口只认主人）。它**不负责清草稿**——想清草稿直接刷新页面；
 *   - 首次进入页面、保存成功之后照旧（该清的清）——这条语义没被动过。
 *
 * 这些都是**页面状态**里的行为（草稿在内存里、按钮在页面上），接口测试正好绕过它们，
 * 所以把 `editor.html` 的内联脚本原样抽出来在 node:vm 里跑，断言真实处理器造成的状态与请求。
 *
 * 用法：node editor/test/reload-drafts.test.mjs（任意 cwd）
 */
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"

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
  h.pick(tr, "anchor", "阿修Axiu")
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

/* ------------------- ② 「回到上一次修改状态」（服务端回退） ------------------- */

/** 主人视图：`perm.versions`（历史版本 / 回退）与 `perm.manage`（上传覆盖云端 / 归属状态）都为真 */
const ownerData = () => makeData({ role: "admin", readonly: false, versions: true, manage: true, cloud: "http://cloud.example" })
/** 版本目录的桩：倒序（最新在前），与 editor.mjs 的 listVersions 同序 */
const VERSIONS = {
  ok: true,
  versions: [
    { id: "queue-20261005-010000.xlsx", at: "2026-10-05T01:00:00.000Z", size: 2048 },
    { id: "queue-20261004-220000.xlsx", at: "2026-10-04T22:00:00.000Z", size: 2000 },
  ],
  archives: [],
  keep: 20,
  archiveDays: 7,
  dir: "（桩）",
  archivesDir: "（桩）",
}

await check("「回退」（无确认框）：直接回退到版本列表里最新那一份，然后整表重读", async () => {
  const server = ownerData()
  const h = bootPage({ dataFor: () => server, versionsReply: () => ({ status: 200, body: VERSIONS }) })
  await h.ready()
  await fillAll(h)
  server.version = "v2"
  server.sheets[0].rows[0].note = "回退后的备注"

  await h.click("rollbackPrev")
  const restores = h.posts("api/restore")
  must(restores.length === 1, `应当发一次回退请求，实际 ${restores.length} 次`)
  must(
    restores[0].body?.id === VERSIONS.versions[0].id,
    `回退用的版本是 ${JSON.stringify(restores[0].body?.id)}，应当是列表里最新那份（= 上一次修改之前的状态）`,
  )
  must(h.reads().length === 2, `回退之后要重新整表读一次，实际读了 ${h.reads().length} 次`)
  must(h.probe.edited.size === 0, `回退后成员行草稿该作废：${JSON.stringify([...h.probe.edited.keys()])}`)
  must(h.probe.added.length === 0, "回退后新增行该作废")
  must(h.probe.anchorEdited.size === 0, "回退后主播列表草稿该作废")
  must(h.cellValue(10, "note") === "回退后的备注", `界面上该显示表里的值，实际 ${JSON.stringify(h.cellValue(10, "note"))}`)
  must(h.toasts().some(t => /已回退到/.test(t)), `提示文案变了：${JSON.stringify(h.toasts())}`)
  must(!h.conflictShown(), "回退之后还挂着提示条")
})

await check("「前进」与「回退」互为反向：走同一份版本、且不再弹确认框", async () => {
  /** confirm 一律返回 false：新口径**不弹确认框**，所以照样该发请求 */
  const h = bootPage({ dataFor: ownerData, versionsReply: () => ({ status: 200, body: VERSIONS }), confirm: () => false })
  await h.ready()
  await h.click("rollbackNext")
  const restores = h.posts("api/restore")
  must(restores.length === 1, `确认框返回 false 也应当直接执行（现在不弹确认框），实际发了 ${restores.length} 次`)
  must(restores[0].body?.id === VERSIONS.versions[0].id, "前进走的也应当是最新那一份（回退时刚存下来的当前状态）")
  must(h.toasts().some(t => /已前进到/.test(t)), `提示文案变了：${JSON.stringify(h.toasts())}`)
  must(h.reads().length === 2, `前进之后也要重新整表读一次，实际读了 ${h.reads().length} 次`)
})

await check("还没有历史版本时点它：说清「没有可回退的版本」，不发回退、也不重读", async () => {
  const h = bootPage({
    dataFor: ownerData,
    versionsReply: () => ({ status: 200, body: { ...VERSIONS, versions: [] } }),
  })
  await h.ready()
  await h.click("rollbackPrev")
  must(h.posts("api/restore").length === 0, "没有版本却发了回退请求")
  must(h.reads().length === 1, `没有版本却重读了：读了 ${h.reads().length} 次`)
  must(h.toasts().some(t => /还没有可回退的版本/.test(t)), `提示文案变了：${JSON.stringify(h.toasts())}`)
})

/* ------------------- ③ 入口的可见性 ------------------- */

/**
 * 入口的可见性（维护者口径：**历史版本 / 归档 / 回退**给主人与白名单管理员；
 * **上传覆盖云端**与**归属状态**是重动作，只给主人）
 */
await check("「回退」「前进」「历史版本」主人与白名单管理员都可见；上传覆盖云端 / 归属状态只在主人可见", async () => {
  const owner = bootPage({ dataFor: ownerData })
  await owner.ready()
  must(owner.document.getElementById("reload").style.display === "", "主人看不到「重新读取」")
  must(owner.document.getElementById("rollbackPrev").style.display === "", "主人看不到「回退」")
  must(owner.document.getElementById("rollbackNext").style.display === "", "主人看不到「前进」")
  must(owner.document.getElementById("versionsBtn").style.display === "", "主人看不到「历史版本」")
  must(owner.document.getElementById("cloudBtn").style.display === "", "主人看不到「上传覆盖云端」")
  must(owner.document.getElementById("ownershipBtn").style.display === "", "主人看不到「归属状态」")

  /**
   * 白名单管理员：看得到历史版本与回退（`perm.versions` 现在也给他），
   * 但**看不到**上传覆盖云端 / 归属状态（那两个由 `perm.manage` 管，只给主人）。
   */
  const admin = bootPage({ dataFor: () => makeData({ role: "admin", readonly: false, versions: true, manage: false, cloud: "http://cloud.example" }) })
  await admin.ready()
  must(admin.document.getElementById("reload").style.display === "", "管理员看不到「重新读取」")
  must(admin.document.getElementById("versionsBtn").style.display === "", "管理员看不到「历史版本」（现在该给他）")
  must(admin.document.getElementById("rollbackPrev").style.display === "", "管理员看不到「回退」（现在该给他）")
  must(admin.document.getElementById("rollbackNext").style.display === "", "管理员看不到「前进」（现在该给他）")
  must(admin.document.getElementById("cloudBtn").style.display === "none", "管理员不该看到「上传覆盖云端」（主人专属）")
  must(admin.document.getElementById("ownershipBtn").style.display === "none", "管理员不该看到「归属状态」（主人专属）")

  const self = bootPage({ dataFor: () => makeData({ role: "self", readonly: false, nick: "甲" }) })
  await self.ready()
  must(self.document.getElementById("reload").style.display === "none", "本人不该看到「重新读取」")
  must(self.document.getElementById("versionsBtn").style.display === "none", "本人不该看到「历史版本」")
  must(self.document.getElementById("rollbackPrev").style.display === "none", "本人不该看到「回退」")
  must(self.document.getElementById("rollbackNext").style.display === "none", "本人不该看到「前进」")
})

await check("保存成功的原语义没变：只清本次保存那一榜，别的榜草稿照旧留着", async () => {
  /** 没有「保存」按钮：等防抖那 1.5 秒到点，就是一次自动保存 */
  const timers = makeFakeTimers()
  const h = bootPage({ timers })
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗的备注")
  h.tab(1)
  h.type(h.rowNo(10), "note", "危战的备注")
  timers.advance(1500)
  await h.ready()

  const saves = h.posts("api/save")
  must(saves.length === 1 && saves[0].body.sheet === "危战", `先保存的应是危战：${JSON.stringify(saves.map(s => s.body.sheet))}`)
  must(!h.probe.edited.has("危战\u0000" + 10), "保存成功之后本榜的草稿该清掉（原语义）")
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "剧诗的备注", "没保存的那一榜的草稿被清掉了")
})

console.log(failed ? `\n❌ 「重新读取」草稿语义验证失败 ${failed} 项` : "\n✅ 「重新读取」草稿语义验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
