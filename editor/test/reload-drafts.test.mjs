/**
 * 「重新读取」与「回退 / 前进」—— 九页重写后的口径
 *
 * 与旧版的差别（重写时删掉的能力，不再断言）：
 *   ❌ 三类草稿分区保留（`edited` / `added` / `anchorEdited`）—— 新页面只有一个 `st.dirty`
 *   ❌ 重读后的差异条（`#conflict` + `#conflictDiff`）—— 已无该元素
 *   ❌ `#reload` / `#rollbackPrev` / `#rollbackNext` / `#versionsBtn` / `#cloudBtn` / `#ownershipBtn`
 *      —— 现在是顶栏 `#reloadBtn`/`#undoBtn`/`#redoBtn` 与侧栏 `.ni[data-nav]`
 *
 * 现在守的是这些：
 *   ① 有草稿时点「重新读取」会先问；确认后重读、草稿作废（页面明说会丢失）
 *   ② 没有草稿时点「重新读取」：重读一次、不弹确认
 *   ③ 「回退 / 前进」：读一次版本目录，换到**最新那一份**（= 上一次写表之前的状态），
 *      成功后整表重读；两个按钮同一条路、互为反向，**不弹确认框**
 *   ④ 请求期间两个按钮禁用并显示「处理中…」；完成后 3 秒内再点同一个按钮被忽略
 *   ⑤ 还没有版本：只提示、不发请求
 *   ⑥ 顶栏「重新读取」人人可见；「回退 / 前进」只给 `perm.versions`
 *   ⑦ 保存只清本榜草稿，别的榜照旧
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
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

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
const ownerData = () => makeData({ role: "admin", readonly: false, versions: true, manage: true, changes: true })

console.log("「重新读取」与版本回退（editor.html 现脚本 + 请求捕获）")

/* ------------------- ① 有草稿时重读 ------------------- */

await check("有草稿时点「重新读取」：先问一句；确认后重读一次、草稿作废", async () => {
  const server = makeData()
  const h = bootPage({ dataFor: () => server, confirm: () => true })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  must(h.probe.dirty.length === 1, "改动没记成草稿")

  server.version = "v2"
  server.sheets[0].rows[0].note = "别人改的备注"
  await h.click("reloadBtn")
  await h.ready()

  must(h.reads().length === 2, `应当重新读一次表，实际读了 ${h.reads().length} 次`)
  must(h.posts("api/save").length === 0, "「重新读取」不该顺手发保存请求（那是自动覆盖）")
  must(h.probe.meta.version === "v2", `重读后没更新手里的版本：${JSON.stringify(h.probe.meta.version)}`)
  must(h.probe.dirty.length === 0, "重读成功后草稿该作废（页面已经问过「会丢失」）")
  must(h.cellValue(10, "note") === "别人改的备注", `界面上该显示表里的值，实际 ${JSON.stringify(h.cellValue(10, "note"))}`)
})

await check("有草稿时点「重新读取」但在确认框里取消：不重读、草稿留着", async () => {
  const h = bootPage({ dataFor: () => makeData(), confirm: () => false })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("reloadBtn")
  await h.ready()
  must(h.reads().length === 1, `取消之后还是重读了：读了 ${h.reads().length} 次`)
  must(h.probe.dirty.length === 1, "取消之后草稿被清掉了")
})

/* ------------------- ② 没草稿时重读 ------------------- */

await check("没有草稿时点「重新读取」：直接重读一次，不弹确认框", async () => {
  const asked = []
  const h = bootPage({ dataFor: () => makeData(), confirm: msg => (asked.push(msg), true) })
  await h.ready()
  await h.click("reloadBtn")
  await h.ready()
  must(h.reads().length === 2, `应当重新读一次表，实际读了 ${h.reads().length} 次`)
  must(!asked.length, `本来就没有草稿，不该问：${JSON.stringify(asked)}`)
})

/* ------------------- ③ 回退 / 前进 ------------------- */

await check("「回退」：先读版本目录，换到最新那一份（带当前版本号），成功后整表重读", async () => {
  const server = ownerData()
  const asked = []
  const h = bootPage({ dataFor: () => server, versionsReply: () => ({ status: 200, body: VERSIONS }),
    confirm: msg => (asked.push(msg), true) })
  await h.ready()
  await h.click("undoBtn")
  await h.ready()

  const restores = h.posts("api/restore")
  must(restores.length === 1, `应当发一次回退请求，实际 ${restores.length} 次`)
  must(restores[0].body?.id === VERSIONS.versions[0].id,
    `回退该用版本目录里最新那份（= 上一次修改之前的状态），实际 ${JSON.stringify(restores[0].body?.id)}`)
  must(typeof restores[0].body?.version === "string", "回退请求里没带当前版本号（服务端没法先存快照）")
  must(!asked.length, `回退不该再弹确认框（点错再点另一个就回来了）：${JSON.stringify(asked)}`)
  must(h.reads().length >= 2, `回退之后要重新整表读一次，实际读了 ${h.reads().length} 次`)
})

await check("「前进」与「回退」同一条路：都换回最新那一份，互为反向", async () => {
  const h = bootPage({ dataFor: ownerData, versionsReply: () => ({ status: 200, body: VERSIONS }) })
  await h.ready()
  await h.click("undoBtn")
  await h.ready()
  await h.click("redoBtn")
  await h.ready()
  const restores = h.posts("api/restore")
  must(restores.length === 2, `回退 + 前进应当是两次 restore，实际 ${restores.length} 次`)
  /** 服务端每次换表前都会把当前状态存成新版本，所以两次都取「最新那份」就自然后退又回来 */
  must(restores[0].body.id === VERSIONS.versions[0].id, "回退没用最新那份")
  must(restores[1].body.id === VERSIONS.versions[0].id, "前进没用最新那份")
})

await check("防误触：3 秒内再点同一个按钮只提示、不发请求；另一个按钮不受限", async () => {
  const h = bootPage({ dataFor: ownerData, versionsReply: () => ({ status: 200, body: VERSIONS }) })
  await h.ready()
  await h.click("undoBtn")
  await h.ready()
  must(h.posts("api/restore").length === 1, `第一次回退该发一次，实际 ${h.posts("api/restore").length}`)

  /** 窗口期内连点同一个按钮：被忽略 */
  await h.click("undoBtn")
  await h.ready()
  must(h.posts("api/restore").length === 1, "3 秒窗口期内同一按钮又发了请求")
  must(h.toasts().some(t => /3 秒内重复点同一个按钮/.test(t)), `没提示防误触：${JSON.stringify(h.toasts())}`)

  /** 另一个按钮照常可用 */
  await h.click("redoBtn")
  await h.ready()
  must(h.posts("api/restore").length === 2, "窗口期不该拦住另一个按钮")
})

await check("动作进行中两个按钮都禁用，按钮文字变「处理中…」，完成后恢复", async () => {
  const h = bootPage({ dataFor: ownerData, versionsReply: () => ({ status: 200, body: VERSIONS }) })
  await h.ready()
  /** 不等 await：请求刚发出、回执还没回来时就是「处理中」 */
  const pending = h.el("undoBtn").onclick()
  must(h.el("undoBtn").disabled === true, "请求没回来时「回退」该禁用")
  must(h.el("redoBtn").disabled === true, "请求没回来时「前进」也该禁用")
  must(h.el("undoBtn").textContent === "处理中…", `按钮文字没换成处理中：${JSON.stringify(h.el("undoBtn").textContent)}`)
  await pending
  await h.ready()
  must(h.el("undoBtn").disabled === false, "完成后「回退」该恢复可用")
  must(h.el("undoBtn").textContent === "回退", `完成后按钮文字没恢复：${JSON.stringify(h.el("undoBtn").textContent)}`)
  must(h.el("redoBtn").textContent === "前进", `「前进」的文字也被带坏了：${JSON.stringify(h.el("redoBtn").textContent)}`)
})

await check("还没有历史版本时点「回退」：说清没有可回退的版本，不发请求", async () => {
  const h = bootPage({ dataFor: ownerData, versionsReply: () => ({ status: 200, body: { ...VERSIONS, versions: [] } }) })
  await h.ready()
  await h.click("undoBtn")
  await h.ready()
  must(h.posts("api/restore").length === 0, "没有版本却发了回退请求")
  must(h.toasts().some(t => /还没有可回退的版本/.test(t)), `提示文案不对：${JSON.stringify(h.toasts())}`)
})

/* ------------------- ④ 入口可见性 ------------------- */

await check("「重新读取」人人可见；「回退 / 前进」与「历史版本」只给 perm.versions", async () => {
  const owner = bootPage({ dataFor: ownerData })
  await owner.ready()
  must(owner.el("reloadBtn").style.display !== "none", "主人看不到「重新读取」")
  must(owner.el("undoBtn").style.display !== "none", "主人看不到「回退」")
  must(owner.el("redoBtn").style.display !== "none", "主人看不到「前进」")

  const self = bootPage({ dataFor: () => makeData({ role: "self", readonly: false, nick: "甲", versions: false, manage: false }) })
  await self.ready()
  must(self.el("reloadBtn").style.display !== "none", "本人看不到「重新读取」")
  must(self.el("undoBtn").style.display === "none", "本人不该看到「回退」")
  must(self.el("redoBtn").style.display === "none", "本人不该看到「前进」")
})

/* ------------------- ⑤ 保存只清本榜 ------------------- */

await check("保存成功后草稿清干净；换榜前会提醒（重写后换榜等于丢弃草稿）", async () => {
  const timers = makeFakeTimers()
  const asked = []
  const h = bootPage({ timers, confirm: msg => (asked.push(msg), true) })
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗的备注")
  timers.advance(1500)
  await h.ready()

  const saves = h.posts("api/save")
  must(saves.length === 1, `应当只发一发，实际 ${saves.length} 发`)
  must(saves[0].body.sheet === "幻想真境剧诗", `存的应是当前这一榜：${JSON.stringify(saves.map(s => s.body.sheet))}`)
  must(h.probe.dirty.length === 0, "保存成功后草稿该清干净")

  /** 带着草稿换榜：页面按设计先问一句，确认后才切（切了就丢草稿） */
  h.type(h.rowNo(10), "note", "又改了")
  h.tab(1)
  await h.ready()
  must(asked.some(m => /切换后会丢失/.test(m)), `带草稿换榜没有提醒：${JSON.stringify(asked)}`)
  must(h.probe.cur === 1, "确认之后应当真的切到第二个榜")
  must(h.probe.dirty.length === 0, "切榜之后草稿该作废")
})

console.log(failed ? `\n❌ 「重新读取」与版本回退验证失败 ${failed} 项` : "\n✅ 「重新读取」与版本回退验证通过")
process.exitCode = failed ? 1 : 0
