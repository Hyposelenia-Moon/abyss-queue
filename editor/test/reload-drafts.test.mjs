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
 *   ③ 「回退 / 前进」：拿版本栈里的下一份发 `api/restore{id,version}`，成功后整表重读
 *   ④ 还没有版本、或已到两端：只提示、不发请求
 *   ⑤ 顶栏「重新读取」人人可见；「回退 / 前进」只给 `perm.versions`
 *   ⑥ 保存只清本榜草稿，别的榜照旧
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

await check("「回退」：发一次 api/restore（带上当前版本号），成功后整表重读", async () => {
  const server = ownerData()
  const h = bootPage({ dataFor: () => server, versionsReply: () => ({ status: 200, body: VERSIONS }), confirm: () => true })
  await h.ready()
  /** 版本栈由「历史版本」页填充，先走一遍那一页 */
  h.nav("versions")
  await h.ready()
  await h.click("undoBtn")
  await h.ready()

  const restores = h.posts("api/restore")
  must(restores.length === 1, `应当发一次回退请求，实际 ${restores.length} 次`)
  must(restores[0].body?.id === VERSIONS.versions[1].id, `回退用的版本是 ${JSON.stringify(restores[0].body?.id)}，应当是栈里的下一份`)
  must(typeof restores[0].body?.version === "string", "回退请求里没带当前版本号（服务端没法先存快照）")
  must(h.reads().length >= 2, `回退之后要重新整表读一次，实际读了 ${h.reads().length} 次`)
})

await check("「前进」与「回退」走同一份版本栈；到两端只提示、不发请求", async () => {
  const h = bootPage({ dataFor: ownerData, versionsReply: () => ({ status: 200, body: VERSIONS }), confirm: () => true })
  await h.ready()
  h.nav("versions")
  await h.ready()
  await h.click("undoBtn")
  await h.ready()
  await h.click("redoBtn")
  await h.ready()
  const restores = h.posts("api/restore")
  must(restores.length === 2, `回退 + 前进应当是两次 restore，实际 ${restores.length} 次`)
  must(restores[0].body.id === VERSIONS.versions[1].id, "回退应落到更旧的那一版")
  must(restores[1].body.id === VERSIONS.versions[0].id, `前进该回到更新的一版，实际 ${JSON.stringify(restores.map(r => r.body.id))}`)

  /** 再点一次前进：栈已经到头，只该提示 */
  await h.click("redoBtn")
  await h.ready()
  must(h.posts("api/restore").length === 2, "已经到最新一版还发了回退请求")
  must(h.toasts().some(t => /最新一版|最早一版|没有可回退/.test(t)), `到边界时没提示：${JSON.stringify(h.toasts())}`)
})

await check("还没有历史版本时点「回退」：说清没有可回退的版本，不发请求", async () => {
  const h = bootPage({ dataFor: ownerData, versionsReply: () => ({ status: 200, body: { ...VERSIONS, versions: [] } }) })
  await h.ready()
  h.nav("versions")
  await h.ready()
  await h.click("undoBtn")
  await h.ready()
  must(h.posts("api/restore").length === 0, "没有版本却发了回退请求")
  must(h.toasts().some(t => /还没有可回退的历史版本/.test(t)), `提示文案不对：${JSON.stringify(h.toasts())}`)
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
