/**
 * 自动保存：没有「保存」按钮之后，"什么时候写表、写什么、失败了怎么办"
 *
 * 为什么单开一套：这件事只在**页面状态**里成立（防抖计时器、进行中的请求、必填没齐就不发），
 * 服务端接口测试直接 POST 一份填好的对象，正好绕过"输入 → 草稿 → 什么时候发请求"这一段。
 * 所以照旧把 `editor.html` 的内联脚本原样抽出来在 node:vm 里跑，并把**时钟**换成假的
 * （`makeFakeTimers`）——"改完等 1.5 秒才发、连着改只发一次"这种判据，
 * 只有能精确推时钟才测得出来。
 *
 * 覆盖的口径（每条都能失败）：
 *   ① 「保存」按钮彻底不在（DOM 与脚本里都没有），换成了状态文字 `#saveState`；
 *      主播列表那颗「保存主播列表」仍在（它是结构性写表，保持手动，不在这一步的范围里）
 *   ② 防抖：改完不到 1.5 秒不发；连着改两次只发**一发**，且两处改动都在请求里
 *   ③ 必填四项没齐：**一个请求都不发**，状态写「未保存（有改动）· 必填没补全」；补齐后自动发
 *   ④ 状态文字：请求在飞是「保存中…」、成功是「已保存」；失败是「保存失败，点这里重试」，
 *      点它立刻重发（不点就不发）
 *   ⑤ 版本冲突（409）：草稿留着、冲突条照旧、**不自动重试**（再等一个防抖周期也不发）、
 *      也不自动重读（重读会清草稿）
 *   ⑥ 只读视图看不到状态文字
 *   ⑦ 删行回执带 `compacted` 时明说"下面的行已上移"（服务端删行后立刻压紧）
 *   ⑧ 回执带 `rowMap`（服务端搬过行）时草稿键跟着搬
 *   ⑨ 新增行保存成功后本地那一行退场（不画第二次、草稿清干净）
 *
 * 用法：node editor/test/autosave.test.mjs（任意 cwd）
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

/** 防抖那 1.5 秒（editor.html 的 AUTOSAVE_DELAY）——套件里用字面量钉住，改了就得两边一起改 */
const DELAY = 1500

/** 把该跑的回调跑完（fetch → note → load 是几层微任务，多刷几次） */
const settle = async h => {
  await h.ready()
  await h.ready()
}

/** 状态文字现在写的是什么（没有这个元素就是页面把状态显示整个删了） */
const state = h => h.el("saveState").textContent

console.log("自动保存（editor.html 原脚本 + 假时钟 + 请求捕获）")

/* ------------------- ① 「保存」按钮彻底不在 ------------------- */

/** 能失败：把 `<button id="save">保存</button>` 加回来（或脚本里再按 id 取它），这条立刻红 */
await check("「保存」按钮彻底不在：DOM 里没有 id=\"save\"，脚本里也不再按 id 取它", async () => {
  const { readFileSync } = await import("node:fs")
  const html = readFileSync(new URL("../editor.html", import.meta.url), "utf8")
  /** 只要再有 `getElementById('save')` / `id="save"`，这条立刻红（不是靠"点了没反应"猜的） */
  must(!/id=["']save["']/.test(html), '页面里又出现了 id="save" 的「保存」按钮')
  must(!/getElementById\(\s*["']save["']\s*\)/.test(html), "页面脚本里还在按 id 取「保存」按钮")
  /** 换成状态文字之后，状态元素必须真的在页面上（不然用户看不到"存没存上"） */
  must(/id=["']saveState["']/.test(html), "没有找到状态文字 #saveState")

  const h = bootPage({ timers: makeFakeTimers() })
  await h.ready()
  must(h.el("saveState").className.includes("savestate"), `状态文字的类名不对：${JSON.stringify(h.el("saveState").className)}`)
  /** 主播列表那颗按钮不在这一步的范围里（结构性写表：会在主播区插一行、下面的行整体下移） */
  must(typeof h.el("anchorSave").onclick === "function", "主播列表的保存入口被误删了")
})

/* ------------------- ② 防抖：改完停手才写 ------------------- */

/**
 * 能失败：① 把防抖去掉（改一格立刻发）→ "还没到 1.5 秒就发了"；
 * ② 重排时不 clearTimeout（连着改各发一发）→ "改完停手应当只发一发" 立刻红
 */
await check("改完 1.5 秒才自动存；连着改只发一发，且两处改动都在请求里", async () => {
  const timers = makeFakeTimers()
  const h = bootPage({ timers })
  await h.ready()
  const row = h.rowNo(10)

  h.type(row, "note", "第一处改动")
  timers.advance(1000)
  await settle(h)
  must(h.posts("api/save").length === 0, `还没到 1.5 秒就发了保存请求（${h.posts("api/save").length} 发）`)

  /** 同一轮里再改一格：计时器要重排（合并成一次请求） */
  h.type(row, "gameName", "甲的游戏B")
  timers.advance(DELAY - 1)
  await settle(h)
  must(h.posts("api/save").length === 0, `第二处改动之后不足 1.5 秒就发了（${h.posts("api/save").length} 发）`)

  timers.advance(1)
  await settle(h)
  const posts = h.posts("api/save")
  must(posts.length === 1, `改完停手应当只发一发，实际 ${posts.length} 发`)
  const values = posts[0].body.rows[0].values
  must(values.note === "第一处改动", `第一处改动没进请求：${JSON.stringify(values.note)}`)
  must(values.gameName === "甲的游戏B", `第二处改动没进请求：${JSON.stringify(values.gameName)}`)
  must(posts[0].body.sheet === "剧诗", `请求发给了 ${JSON.stringify(posts[0].body.sheet)}，应当是当前这一榜`)
})

/* ------------------- ③ 必填没齐：一个请求都不发 ------------------- */

/** 能失败：把 `collectSaveRows` 的必填那道闸去掉（有草稿就发）→ "必填没齐却发了保存请求" */
await check("必填四项没齐：一个请求都不发，状态写清「必填没补全」；补齐后自动发", async () => {
  const timers = makeFakeTimers()
  const h = bootPage({ timers })
  await h.ready()
  await h.click("addRow")
  const tr = h.newRow()
  /** 只填群昵称：原神游戏名 / 选择主播 / 难度及目标还空着 */
  h.type(tr, "nickname", "新人丙")

  timers.advance(DELAY)
  await settle(h)
  must(h.posts("api/save").length === 0, `必填没齐却发了保存请求（${JSON.stringify(h.posts("api/save").map(p => p.body.rows))}）`)
  must(/未保存/.test(state(h)), `状态文字没写"未保存"：${JSON.stringify(state(h))}`)
  must(/必填/.test(state(h)), `状态文字没写清是必填没补全：${JSON.stringify(state(h))}`)

  /** 补齐剩下三项：下一次防抖就该自动写表 */
  h.type(tr, "gameName", "丙的游戏")
  h.pick(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")
  timers.advance(DELAY)
  await settle(h)
  const posts = h.posts("api/save")
  must(posts.length === 1, `补齐必填之后应当自动存一发，实际 ${posts.length} 发`)
  must(posts[0].body.rows[0].values.nickname === "新人丙", `新增行没进请求：${JSON.stringify(posts[0].body.rows)}`)
})

/* ------------------- ④ 状态文字 + 失败重试 ------------------- */

/**
 * 能失败：① 失败时不写状态文字 / 不挂 `onclick` → 三条状态断言立刻红；
 * ② 把"失败后不自动重试"改成自动重排 → "没人点重试却自己又发了一发"
 */
await check("状态文字：飞的时候「保存中…」、成功「已保存」；失败「保存失败，点这里重试」，点了才重发", async () => {
  const timers = makeFakeTimers()
  let n = 0
  const h = bootPage({
    timers,
    saveReply: () => {
      n++
      return n === 1
        ? { status: 500, body: { ok: false, error: "服务端炸了" } }
        : { status: 200, body: { ok: true, written: 1, cleared: 0, ignored: [], notices: [] } }
    },
  })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")

  /** 推时钟但不刷新：这一刻请求刚发出去（同步跑到 fetch 之前的那句 setSaveState） */
  timers.advance(DELAY)
  must(state(h) === "保存中…", `请求在飞时状态应当是「保存中…」，实际 ${JSON.stringify(state(h))}`)

  await settle(h)
  must(h.posts("api/save").length === 1, `应当只发一发，实际 ${h.posts("api/save").length} 发`)
  must(state(h) === "保存失败，点这里重试", `失败之后状态应当是「保存失败，点这里重试」，实际 ${JSON.stringify(state(h))}`)
  must(h.el("saveState").className.includes("fail"), `失败这一档没有可点的样式：${JSON.stringify(h.el("saveState").className)}`)
  must(typeof h.el("saveState").onclick === "function", "「点这里重试」没有点击处理器")
  must(h.toasts().some(t => /保存失败/.test(t) && /服务端炸了/.test(t)), `失败原因没透出来：${JSON.stringify(h.toasts())}`)

  /** 不点就不发：再等一个防抖周期也不该自己重试 */
  timers.advance(DELAY)
  await settle(h)
  must(h.posts("api/save").length === 1, `没人点重试却自己又发了一发（${h.posts("api/save").length} 发）`)

  await h.click("saveState")
  must(h.posts("api/save").length === 2, `点状态文字应当立刻重发一次，实际 ${h.posts("api/save").length} 发`)
  must(state(h) === "已保存", `重试成功之后状态应当是「已保存」，实际 ${JSON.stringify(state(h))}`)
  must(h.el("saveState").onclick === null, "成功之后状态文字还留着「点这里重试」的处理器")
})

/* ------------------- ⑤ 409：草稿留着、不自动重试、不自动重读 ------------------- */

/**
 * 能失败：① 去掉 `autoSavePaused` 那道闸 → "自动保存没暂停"；
 * ② 409 之后顺手重读（把草稿清掉）→ 草稿断言与 `reads()` 断言同时红
 */
await check("409：草稿留着、冲突条照旧、自动保存暂停（再等一个周期也不发）、也不自动重读", async () => {
  const timers = makeFakeTimers()
  const h = bootPage({
    timers,
    saveReply: () => ({
      status: 409,
      body: { ok: false, conflict: true, error: "表格在你保存期间被改过（别人先提交、或表被外部改动），请刷新页面确认后再改" },
    }),
  })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")

  timers.advance(DELAY)
  await settle(h)
  must(h.posts("api/save").length === 1, `应当发了一发（被 409 拒），实际 ${h.posts("api/save").length} 发`)
  must(state(h) === "保存失败，点这里重试", `409 之后的状态文字不对：${JSON.stringify(state(h))}`)
  must(h.conflictShown(), "409 之后没有摆出常驻冲突条")
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "409 把草稿弄丢了")
  must(h.reads().length === 1, `409 之后自动重读了表（重读会清草稿）：读了 ${h.reads().length} 次`)

  /** 暂停：再改、再等一个防抖周期都不发（不然每次敲键都拿旧表算出来的整行值去撞别人的改动） */
  h.type(h.rowNo(10), "note", "又改了一版")
  timers.advance(DELAY)
  await settle(h)
  must(h.posts("api/save").length === 1, `409 之后自动保存没暂停，又发了 ${h.posts("api/save").length - 1} 发`)
  must(state(h) === "保存失败，点这里重试", `暂停期间状态文字被冲掉了：${JSON.stringify(state(h))}`)
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "又改了一版", "暂停期间草稿被清了（用户改的第二版丢了）")
})

/* ------------------- ⑥ 只读视图 ------------------- */

/** 能失败：只读时也给状态文字留着显示位置（`renderPerm` 里那句 display 判断去掉）→ 立刻红 */
await check("只读视图看不到状态文字（没有写权限，就不该显示「存没存上」）", async () => {
  const h = bootPage({ dataFor: () => makeData({ role: "guest", readonly: true }), timers: makeFakeTimers() })
  await h.ready()
  must(h.el("saveState").style.display === "none", `只读视图还显示着状态文字：${JSON.stringify(h.el("saveState").style.display)}`)
})

/* ------------------- ⑦ 删行回执：下面的行被提上来了 ------------------- */

/**
 * 能失败：`saveDrafts` 里那句 `out.compacted` 的提示去掉 → 立刻红。
 *
 * 服务端清空整行之后会把下面的行**立刻提上来**（序号列不留空档，见 `editor.mjs` 的
 * `compactClearedRows`），行号跟着变——用户"删的是第 16 行、下面的人怎么跑到 16 去了"这一问
 * 必须有句话答，不能让人对着表自己猜。
 */
await check("服务端回执带 compacted（删行后下面的行上移）：页面明说一句", async () => {
  const timers = makeFakeTimers()
  const h = bootPage({
    timers,
    saveReply: () => ({
      status: 200,
      body: { ok: true, written: 0, cleared: 1, compacted: { removed: 1, moved: 5 }, ignored: [], notices: [] },
    }),
  })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")

  timers.advance(DELAY)
  await settle(h)
  must(h.posts("api/save").length === 1, `应当发一发，实际 ${h.posts("api/save").length} 发`)
  must(
    h.toasts().some(t => /已删掉 1 行/.test(t) && /上移/.test(t)),
    `删行之后没告诉用户"下面的行上移了"：${JSON.stringify(h.toasts())}`,
  )
})

/* ------------- ⑧ 服务端搬过行：草稿键跟着搬 ------------- */

/**
 * 能失败：`saveDrafts` 里那句 `remapDrafts(savedName, out.rowMap, [savedSnap])` 去掉 → 立刻红。
 *
 * 场景：服务端在保存之后**搬过行**（删行压紧 / 改了完成情况立刻整理）——"第 10 行"现在已经是别人了。
 * 页面上的草稿按 (榜 × 行号) 存，不跟着搬的话：① 保存回执里值对不上，草稿清不掉，界面永远停在
 * 「未保存」；② 下一次自动保存会拿**这个人的值**去写那一行现在的人（被红线拒掉、或者把别人顶掉）。
 */
await check("保存回执带 rowMap（服务端搬过行）：草稿键搬到新行号，保存完就是「已保存」", async () => {
  const timers = makeFakeTimers()
  const before = makeData()
  const after = makeData()
  /** 甲 从第 10 行被前移到第 11 行（第 10 行换成了乙）——与"改了完成情况立刻整理"之后一模一样 */
  after.sheets[0].rows = [
    { row: 10, seq: 1, nickname: "乙", gameName: "乙的游戏", anchor: "阿修Axiu", goal: "困难满花", strength: "中配", note: "", status: "排队中" },
    { row: 11, seq: 2, nickname: "甲", gameName: "甲的游戏", anchor: "阿修Axiu", goal: "困难满花", strength: "中配", note: "我的备注", status: "排队中" },
  ]
  let reads = 0
  const h = bootPage({
    timers,
    dataFor: () => (++reads === 1 ? before : after),
    saveReply: () => ({
      status: 200,
      body: { ok: true, written: 1, cleared: 0, tidied: 2, rowMap: { 10: 11 }, ignored: [], notices: [] },
    }),
  })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")

  timers.advance(DELAY)
  await settle(h)
  must(h.posts("api/save").length === 1, `应当发一发，实际 ${h.posts("api/save").length} 发`)
  must(!h.probe.edited.has("剧诗\u0000" + 10), "草稿还挂在老行号上（那一行现在已经是别人了）")
  must(state(h) === "已保存", `搬行之后状态应当是「已保存」，实际 ${JSON.stringify(state(h))}`)
  must(h.toasts().some(t => /已整理/.test(t)), `没提示"顺手整理了"：${JSON.stringify(h.toasts())}`)
})

/* ------------- ⑨ 新增行保存成功：本地那一行退场，不许变成"第二行" ------------- */

/**
 * 能失败：`load()` 里给 `settleAddedRows` 传的 `keepAddedKeys` 去掉 → 立刻红。
 *
 * 提交过的那个"新增行"在重读回来的表里当然已经存在了，要是也按"撞号"把它挪到别的行号，
 * `savedSnap` 就对不上（那一份快照是按旧行号建的）——本地那一行永远退不了场：表里一行、
 * 界面上两行，点保存还会拿它去写另一个行号。
 */
await check("新增行保存成功：本地那一行退场（不画第二次），草稿也清干净", async () => {
  const timers = makeFakeTimers()
  const server = makeData()
  const h = bootPage({
    timers,
    dataFor: () => server,
    saveReply: (n, body) => {
      /** 服务端真把这一行写进去了：桩数据也改成"写完之后"的样子（重读拿到的就是它） */
      for (const r of body.rows) {
        const exists = server.sheets[0].rows.find(x => x.row === r.row)
        if (exists) Object.assign(exists, r.values)
        else server.sheets[0].rows.push({ row: r.row, seq: server.sheets[0].rows.length + 1, ...r.values })
      }
      server.sheets[0].taken = server.sheets[0].rows.map(r => r.row)
      return { status: 200, body: { ok: true, written: body.rows.length, cleared: 0, version: "v2", ignored: [], notices: [] } }
    },
  })
  await h.ready()
  await h.click("addRow")
  const tr = h.newRow()
  const row = h.probe.added[0].row
  h.type(tr, "nickname", "新人丙")
  h.type(tr, "gameName", "丙的游戏")
  h.pick(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")

  timers.advance(DELAY)
  await settle(h)
  must(h.posts("api/save").length === 1, `应当发一发，实际 ${h.posts("api/save").length} 发`)
  must(!h.probe.added.length, `本地新增行没退场：${JSON.stringify(h.probe.added)}`)
  const titles = h.el("grid").childNodes[0].childNodes[1].childNodes.map(x => x.childNodes[0].title)
  const dup = titles.filter((x, i) => titles.indexOf(x) !== i)
  must(!dup.length, `同一个行号画了两次：${JSON.stringify(titles)}`)
  must(!h.probe.edited.has("剧诗\u0000" + row), `保存成功之后那一行的草稿该清掉：${JSON.stringify([...h.probe.edited])}`)
})

console.log(failed ? `\n❌ 自动保存验证失败 ${failed} 项` : "\n✅ 自动保存验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
