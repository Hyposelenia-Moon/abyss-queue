/** 写表：inserter / leave-row / check-write / check-done 合并成一个套件（原文件见 git 历史） */
import { ensureEnv } from "./env.mjs"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { installFrameworkStubs, requireSource } from "./_helper.mjs"
import { registerEditorService, resetEditorService } from "../editor/service.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("写表")

await (async () => {
  const calls = []
  registerEditorService({
    moveRow: async (caller, body) => {
      calls.push({ caller, body })
      return { ok: true, moved: true, from: body.row, to: 1, nickname: "被插队的人", crossed: "队首", fromSeq: 3, toSeq: 1 }
    },
  })
  const SOURCE = await requireSource()
  const { check, finish } = createChecker("插队指令")
  const ENV = await ensureEnv({ prefix: "abyss-queue-insert-" })
  const fixture = ENV.fixture
  await fs.copyFile(SOURCE, fixture)
  const ADMIN = "424243"
  const OUTSIDER = "430000"
  await fs.writeFile(path.join(ENV.dir, "abyss-editor-admins.json"), JSON.stringify({ owner: [], admins: [ADMIN] }), "utf8")
  const sent = installFrameworkStubs()
  const { apps } = await import("../index.js")
  const APPS = Object.values(apps).filter(c => typeof c === "function")
  const { Table } = await import("../model/table.js")
  const { firstEmptyRow } = await import("../modules/queue.js")
  const SHEET = "幽境危战"
  const OTHER = "幻想真境剧诗"
  const QUEUED = "排队中"
  const WAITING = "等待开启"
  /** 榜里那一行的群昵称与发送者名片**必须一致**：插件按群名片定位本人，不一致就成了"表里没这个人" */
  const ADMIN_NICK = "管理员甲"
  const TARGET_NICK = "被指定的人"
  const WAITING_NICK = "还没开的人乙"
  const CALLER = { user_id: ADMIN, card: ADMIN_NICK }
  const sha256 = buf => createHash("sha256").update(buf).digest("hex")
  /** 复刻 loader 的取法：非 RegExp 的 reg 编译成正则，按 priority 找第一条命中的规则 */
  const rulesOf = app => (app.rule ?? []).map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))
  const say = async (msg, opts = {}) => {
    /** 发送者 = 管理员甲（`CALLER` 放在最后：用例想改谁就改 `opts`，默认就是这位） */
    const e = { msg, self_id: "10000", group_id: "20000", isGroup: true, sender: { card: ADMIN_NICK, nickname: ADMIN_NICK }, ...CALLER, ...opts }
    if (opts.card) e.sender = { ...e.sender, card: opts.card, nickname: opts.card }
    for (const C of APPS.map(C => Object.assign(new C(), { e, __replies: [] })).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
      const hit = rulesOf(C).find(r => r.reg.test(msg))
      if (!hit) continue
      await C[hit.fnc]()
      return { fnc: hit.fnc, replies: C.__replies }
    }
    return { fnc: null, replies: [] }
  }
  const msgText = m =>
    Array.isArray(m)
      ? m.map(p => (typeof p === "string" ? p : p?.type === "image" ? "[图片]" : String(p?.data?.content ?? p))).join("")
      : String(m)
  const said = r => r.replies.map(msgText).join("\n")
  const readModel = async sheet => new Table({ file: fixture, backup: false }).read(({ models }) => models.get(sheet))
  // **插件自己那一份绑定库**（不是套件另 import 一份）
  const liveStore = async () => new (APPS.find(C => (new C().rule ?? []).some(r => String(r.fnc) === "insert")))()["store"]()
  let rowA = 0
  let rowB = 0
  let rowC = 0
  {
    const model = await readModel(SHEET)
    const base = firstEmptyRow(model)
    if (!base) {
      console.log("⏭ 套件跳过：这份表在「幽境危战」里已经没有空行，摆不下用例数据")
      process.exit(0)
    }
    ;[rowA, rowB, rowC] = [base, base + 1, base + 2]
    const table = new Table({ file: fixture, backup: false })
    await table.mutate(ctx => {
      /** rowA = 被别人插队的那位；rowB = 管理员自己；rowC = 「等待开启」，插不了 */
      for (const [row, nick, status] of [[rowA, TARGET_NICK, QUEUED], [rowB, ADMIN_NICK, QUEUED], [rowC, WAITING_NICK, WAITING]]) {
        ctx.setCell(SHEET, row, "nickname", nick)
        ctx.setCell(SHEET, row, "gameName", `${nick}的游戏名`)
        ctx.setCell(SHEET, row, "status", status)
      }
    })
    /** 绑定认人：管理员自己（rowB）与他要指定的那位（rowA） */
    const store = await liveStore()
    store.set(SHEET, ADMIN, { row: rowB, nickname: ADMIN_NICK })
    store.set(SHEET, "30001", { row: rowA, nickname: TARGET_NICK })
    await store.save()
  }
  console.log(`源表格：${SOURCE}\n测试副本：${fixture}\n${SHEET} 数据行：${rowA} / ${rowB} / ${rowC}\n`)
  // 表格文件的快照（字节哈希）
  const tableSnap = async () => sha256(await fs.readFile(fixture))
  const hashAtStart = await tableSnap()
  console.log("【1】鉴权：只有白名单管理员能插队")
  {
    const before = calls.length
    const r = await say("#插队", { user_id: OUTSIDER, card: "路人" })
    check("非白名单管理员：拒绝，且一次都不调 move-row", () => {
      const text = said(r)
      assert.ok(text.includes("白名单"), text)
      assert.equal(calls.length, before, `不该调 move-row：${JSON.stringify(calls.slice(before))}`)
    })
    check("拒绝的回复里不出现榜名与行号（不泄露表内容）", () => {
      const text = said(r)
      assert.ok(!text.includes(SHEET), text)
      assert.ok(!text.includes(String(rowB)), text)
    })
    check("被拒的这一条一个字没写表", async () => assert.equal(await tableSnap(), hashAtStart))
  }
  // 【1b】主人（白名单文件 `owner` 里的 QQ）也能用
  console.log("\n【1b】主人（owner 名单里的 QQ）：同样能用")
  {
    const OWNER = "424242"
    const wlFile = path.join(ENV.dir, "abyss-editor-admins.json")
    await fs.writeFile(wlFile, JSON.stringify({ owner: [OWNER], admins: [ADMIN] }), "utf8")
    try {
      const before = calls.length
      const r = await say("#插队 被指定的人", { user_id: OWNER, card: "主人" })
      check("主人发 #插队（点名别人）：不拒绝，且真的调了 move-row", () => {
        const text = said(r)
        assert.equal(r.fnc, "insert", JSON.stringify(r))
        assert.ok(!text.includes("白名单"), `主人被当成外人拒了：${text}`)
        assert.equal(calls.length, before + 1, `应当只调一次：${JSON.stringify(calls.slice(before))}`)
      })
      check("这条调用带的是**发起者本人**（主人）", () => {
        const c = calls.at(-1)
        assert.equal(String(c.caller.qq), OWNER, JSON.stringify(c.caller))
        assert.equal(c.caller.role, "admin")
      })
      check("主人这一条也一个字没写表", async () => assert.equal(await tableSnap(), hashAtStart))
    } finally {
      /** 还原成"只有白名单管理员"：后面的用例按这个前提写 */
      await fs.writeFile(wlFile, JSON.stringify({ owner: [], admins: [ADMIN] }), "utf8")
    }
  }
  console.log("\n【2】白名单管理员：调编辑器、带上发起者本人")
  {
    const before = calls.length
    const r = await say("#插队")
    check("白名单管理员这一条也一个字没写表", async () => assert.equal(await tableSnap(), hashAtStart))
    check("命中 insert，且真的调了 move-row", () => {
      assert.equal(r.fnc, "insert", JSON.stringify(r))
      assert.equal(calls.length, before + 1, `应当只调一次：${JSON.stringify(calls.slice(before))}`)
    })
    check("请求体：榜名 + 行号 + 固定 mode，昵称是本人的", () => {
      const m = calls.at(-1).body
      assert.equal(m.sheet, SHEET)
      assert.equal(Number(m.row), rowB)
      assert.equal(m.mode, "queue-front")
      assert.equal(m.nick, ADMIN_NICK)
    })
    check("调用里带上的是发起者本人（管理员）", () => {
      const c = calls.at(-1)
      assert.equal(String(c.caller.qq), ADMIN)
      assert.equal(c.caller.nick, ADMIN_NICK)
      assert.equal(c.caller.role, "admin")
    })
    check("回话说清把谁挪到了第几位，并说明是排到最前面", () => {
      const text = said(r)
      assert.ok(text.includes("被插队的人"), text)
      assert.ok(text.includes("从第 3 位挪到第 1 位"), text)
      assert.ok(text.includes("排到最前面"), text)
      assert.ok(!text.includes("越过"), text)
    })
  }
  console.log("\n【2b】旧绑定指到别人那一行：仍按当前名片认自己")
  {
    const store = await liveStore()
    // 现场复现：表里本人那一行已经改成 ADMIN_NICK，绑定却还指着上方 TARGET_NICK 那一行。
    store.set(SHEET, ADMIN, { row: rowA, nickname: TARGET_NICK })
    await store.save()
    const before = calls.length
    const r = await say("#插队")
    check("绑定指向别人时，请求里的行号仍是当前名片那一行", () => {
      assert.equal(r.fnc, "insert")
      assert.equal(calls.length, before + 1, `应当只调一次：${JSON.stringify(calls.slice(before))}`)
      const m = calls.at(-1).body
      assert.equal(Number(m.row), rowB, `被旧绑定带到了别人那一行：${JSON.stringify(m)}`)
      assert.equal(m.nick, ADMIN_NICK)
    })
    check("这一发也一个字没写表", async () => assert.equal(await tableSnap(), hashAtStart))
    store.set(SHEET, ADMIN, { row: rowB, nickname: ADMIN_NICK })
    await store.save()
  }
  console.log("\n【3】前面没有「排队中」的行：不调 move-row")
  {
    // 管理员站到队列最前面一档（那里上方没有任何「排队中」的行）
    const store = await liveStore()
    const solo = "独自在前的管理员"
    /** 他上方那些「排队中」要先清掉：真实表里前面本来就排着人，不清的话"前面没有排队中的人"这个前提不成立 */
    const ahead = (await readModel(SHEET)).rows.filter(r => r.row < rowA && r.status === QUEUED).map(r => r.row)
    await new Table({ file: fixture, backup: false }).mutate(ctx => {
      ctx.setCell(SHEET, rowA, "nickname", solo)
      for (const r of ahead) ctx.setCell(SHEET, r, "status", WAITING)
    })
    store.set(SHEET, ADMIN, { row: rowA, nickname: solo })
    await store.save()
    const beforeSolo = await tableSnap()
    const before = calls.length
    const r = await say("#插队", { card: solo })
    check("这一条也一个字没写表", async () => assert.equal(await tableSnap(), beforeSolo))
    check("已经在最前面：一次都不调 move-row，回话说明原因", () => {
      assert.equal(calls.length, before, `不该调 move-row：${JSON.stringify(calls.slice(before))}`)
      const text = said(r)
      assert.ok(text.includes("最前面"), `实际回复：${JSON.stringify(text)}`)
    })
    /** 还原：第一位那一行换回被指定的人（状态也还回「排队中」），管理员回到自己那一行 */
    await new Table({ file: fixture, backup: false }).mutate(ctx => {
      ctx.setCell(SHEET, rowA, "nickname", TARGET_NICK)
      ctx.setCell(SHEET, rowA, "status", QUEUED)
      for (const r of ahead) ctx.setCell(SHEET, r, "status", QUEUED)
    })
    store.set(SHEET, ADMIN, { row: rowB, nickname: ADMIN_NICK })
    await store.save()
    check("前置：管理员回到自己那一行（rowB）", () => assert.equal(Number(store.get(SHEET, ADMIN)?.row), rowB))
  }
  console.log("\n【4】指定某位成员与指定榜名")
  {
    // `#插队 <群昵称>`：管理员点名挪**别人**那一行（管理能力），而不是把自己挪走
    const store = await liveStore()
    await new Table({ file: fixture, backup: false }).mutate(ctx => {
      ctx.setCell(SHEET, rowA, "nickname", TARGET_NICK)
      ctx.setCell(SHEET, rowA, "status", QUEUED)
      ctx.setCell(SHEET, rowB, "nickname", ADMIN_NICK)
      ctx.setCell(SHEET, rowB, "status", QUEUED)
    })
    store.set(SHEET, ADMIN, { row: rowB, nickname: ADMIN_NICK })
    store.set(SHEET, "30001", { row: rowA, nickname: TARGET_NICK })
    await store.save()
    const beforeNamed = await tableSnap()
    const before = calls.length
    const r = await say(`#插队 ${TARGET_NICK}`)
    check("#插队 <群昵称>：挪的是被点名的那一行（不是调用者自己）", () => {
      assert.equal(r.fnc, "insert")
      assert.equal(calls.length, before + 1, `应当只调一次：${JSON.stringify(calls.slice(before))}`)
      const m = calls.at(-1).body
      assert.equal(Number(m.row), rowA, `挪的应当是第 ${rowA} 行：${JSON.stringify(m)}`)
      assert.equal(m.nick, TARGET_NICK)
    })
    check("指名别人这一条也没写表", async () => assert.equal(await tableSnap(), beforeNamed))
    const before2 = calls.length
    const r2 = await say("#插队 危战")
    check("#插队 <榜名>：只处理那一个榜（这里是调用者自己那条）", () => {
      assert.equal(r2.fnc, "insert")
      assert.equal(calls.length, before2 + 1, `应当只调一次：${JSON.stringify(calls.slice(before2))}`)
      const m = calls.at(-1).body
      assert.equal(m.sheet, SHEET)
      assert.equal(Number(m.row), rowB)
    })
    const r3 = await say("#插队 不存在的榜")
    check("#插队 <不认识的榜名>：当成群昵称/查不到，回话里点明没有动，不调 move-row", () => {
      const text = said(r3)
      assert.ok(text.includes("没有动") || text.includes("没有挪动"), text)
    })
    // 「被指定的人」那一行**没有任何对得上账的绑定**时一个字都不动
    const before4 = calls.length
    const beforeStale = await tableSnap()
    store.set(SHEET, "30001", { row: rowB, nickname: "过期的名字" })
    await store.save()
    const r4 = await say(`#插队 ${TARGET_NICK}`)
    check("那一行的归属对不上账时宁可不动：不调 move-row，回话点明", () => {
      assert.equal(calls.length, before4, `不该调 move-row：${JSON.stringify(calls.slice(before4))}`)
      assert.ok(said(r4).includes("没有动"), said(r4))
      assert.ok(said(r4).includes("归属"), said(r4))
    })
    check("被拒的那一条同样一个字没写表", async () => assert.equal(await tableSnap(), beforeStale))
    store.set(SHEET, "30001", { row: rowA, nickname: TARGET_NICK })
    await store.save()
  }
  console.log("\n【5】没在排队的榜 / 不是「排队中」：不调 move-row、回话点明")
  {
    // 单独造一行「等待开启」，并**按绑定认他**（行上的昵称与绑定一致）
    const store = await liveStore()
    const waitingRow = rowC + 1
    const soloWaiting = `${WAITING_NICK}（状态用例）`
    await new Table({ file: fixture, backup: false }).mutate(ctx => {
      ctx.setCell(SHEET, waitingRow, "nickname", soloWaiting)
      ctx.setCell(SHEET, waitingRow, "gameName", `${soloWaiting}的游戏名`)
      ctx.setCell(SHEET, waitingRow, "status", WAITING)
    })
    store.set(SHEET, "30005", { row: waitingRow, nickname: soloWaiting })
    await store.save()
    const beforeWaiting = await tableSnap()
    const before = calls.length
    const r = await say(`#插队 ${soloWaiting}`)
    check("「等待开启」的人不能插队：不调 move-row，回话点明状态", () => {
      assert.equal(calls.length, before, `不该调 move-row：${JSON.stringify(calls.slice(before))}`)
      assert.ok(said(r).includes("不是「排队中」"), `实际回复：${JSON.stringify(said(r))}`)
    })
    check("状态不对这一条也没写表", async () => assert.equal(await tableSnap(), beforeWaiting))
    {/** 管理员自己换到第一个榜（没排别的榜这条单独验） */}
    const before2 = calls.length
    const r2 = await say(`#插队 ${OTHER}`)
    check("本人没排那个榜：不调 move-row，回话点明", () => {
      assert.equal(calls.length, before2, `不该调 move-row：${JSON.stringify(calls.slice(before2))}`)
      assert.ok(said(r2).includes(OTHER), said(r2))
    })
  }
  console.log("\n【6】规则表：一条 #插队，不抢别的命令")
  {
    check("规则表里只有一条 #插队（不抢别人的命令空间）", () => {
      const hits = APPS.flatMap(C => rulesOf(new C())).filter(r => r.reg.test("#插队") || r.reg.test("#插队 甲"))
      assert.equal(hits.length, 1, `命中 ${hits.length} 条规则`)
      assert.equal(hits[0].fnc, "insert")
    })
    check("裸榜名 / #排队 不受影响（#插队 规则不吞别的命令）", () => {
      assert.ok(APPS.some(C => rulesOf(new C()).some(r => r.reg.test("#排队"))), "#排队 应当照旧命中")
      assert.ok(!APPS.some(C => rulesOf(new C()).some(r => r.reg.test("#幽境危战"))), "裸榜名不该被本插件接管")
    })
  }
  await fs.rm(ENV.dir, { recursive: true, force: true }).catch(() => {})
  await finish()
  resetEditorService()
})()

await (async () => {
  const ENV = await ensureEnv({ prefix: "abyss-queue-leave-row-", cloud: false })
  installFrameworkStubs()
  const { leaveRow, tidySheet } = await import("../model/editor-commands.js")
  const { check, finish } = createChecker("退队直调")
  const saves = []
  const tidies = []
  /** 挂假 service（`overrides` 用来演"编辑器那边失败"）；`resetEditorService()` 之后就是未挂载 */
  const mount = (overrides = {}) =>
    registerEditorService({
      save: async (caller, body) => {
        saves.push({ caller, body })
        return { ok: true, updated: 1 }
      },
      tidy: async (caller, body) => {
        tidies.push({ caller, body })
        return { ok: true, moved: 0, tidied: [] }
      },
      ...overrides,
    })
  console.log("【1】已挂载：退队走 editor 的 save，只清发起者那一行")
  {
    mount()
    const before = saves.length
    const out = await leaveRow({ caller: { qq: "10001", nick: "小明" }, sheet: "深渊1", row: 7 })
    check("save 恰好调 1 次", () => assert.equal(saves.length, before + 1, `实际调了 ${saves.length - before} 次`))
    check("调用者是管理员身份：role=admin，QQ 与昵称原样带上", () => {
      const c = saves.at(-1)
      assert.ok(c, "save 没被调用")
      assert.equal(c.caller.role, "admin", JSON.stringify(c.caller))
      assert.equal(c.caller.identity?.qq, "10001", JSON.stringify(c.caller))
      assert.equal(c.caller.identity?.nick, "小明", JSON.stringify(c.caller))
    })
    check("只清这一行：sheet 透传、rows 一条、row=7、clear=true", () => {
      const c = saves.at(-1)
      assert.ok(c, "save 没被调用")
      assert.equal(c.body.sheet, "深渊1")
      assert.equal(c.body.rows?.length, 1, JSON.stringify(c.body))
      assert.equal(c.body.rows[0].row, 7)
      assert.equal(c.body.rows[0].clear, true)
    })
    check("整行字段全空（编辑器据此把这一行当删除处理）", () => {
      const values = saves.at(-1)?.body?.rows?.[0]?.values ?? {}
      const keys = Object.keys(values)
      assert.ok(keys.length, "values 一个键都没有，编辑器不知道要清哪些字段")
      for (const key of keys) assert.equal(values[key], "", `${key} 不是空串`)
    })
    check("回执把编辑器的结果并回来（ok=true）", () => assert.equal(out.ok, true, JSON.stringify(out)))
  }
  console.log("\n【2】未挂载：报错让调用方回话，不做 HTTP 兜底")
  {
    resetEditorService()
    const before = saves.length
    await check("抛「退队需要它」", async () => {
      await assert.rejects(
        () => leaveRow({ caller: { qq: "10001", nick: "小明" }, sheet: "深渊1", row: 7 }),
        /退队需要它/,
      )
    })
    check("一次都没调 save", () => assert.equal(saves.length, before, `实际调了 ${saves.length - before} 次`))
  }
  console.log("\n【3】整理：榜名透传给 editor，回执原样返回")
  {
    mount()
    const before = tidies.length
    const out = await tidySheet("深渊1")
    check("tidy 恰好调 1 次，带的是这个榜（不是全部榜）", () => {
      const c = tidies.at(-1)
      assert.ok(c, "tidy 没被调用")
      assert.equal(tidies.length, before + 1, `实际调了 ${tidies.length - before} 次`)
      assert.equal(c.body.sheet, "深渊1")
      assert.equal(c.caller.nick, "每日整理", JSON.stringify(c.caller))
    })
    check("回执说明整理完成（ok=true）", () => assert.equal(out.ok, true, JSON.stringify(out)))
  }
  console.log("\n【4】整理失败：只记日志、返回 null，不把退队带成失败")
  {
    mount({ tidy: async () => { throw new Error("模拟编辑器整理失败") } })
    await check("tidySheet 返回 null，不抛错", async () => {
      let out
      await assert.doesNotReject(async () => { out = await tidySheet("深渊1") })
      assert.equal(out, null)
    })
  }
  console.log("\n【5】未挂载时整理同样只返回 null")
  {
    resetEditorService()
    await check("「整理需要它」被吞掉：返回 null，不抛错", async () => {
      let out
      await assert.doesNotReject(async () => { out = await tidySheet("深渊1") })
      assert.equal(out, null)
    })
  }
  await ENV.cloud?.close()
  await fs.rm(ENV.dir, { recursive: true, force: true }).catch(() => {})
  await finish()
  resetEditorService()
})()

await (async () => {
  const ENV = await ensureEnv({ prefix: "abyss-queue-check-write-", cloud: false })
  installFrameworkStubs()
  const { markChecked } = await import("../model/editor-commands.js")
  const { ROSTER_QQ } = await import("../model/roster.js")
  const { check, finish } = createChecker("清榜核查落表")
  const VERSION = "a".repeat(64)
  const SHEET = "深渊1"
  const ROWS = [{ row: 7, nickname: "小明", goal: "第12层满星" }]
  const calls = []
  const mount = () =>
    registerEditorService({
      checkDone: async (caller, body) => {
        calls.push({ caller, body })
        return { ok: true, sheet: body.sheet, updated: body.rows.length, rows: body.rows.map(r => r.row) }
      },
    })
  console.log("【1】未挂载：直接报错，不做 HTTP 兜底")
  {
    resetEditorService()
    await check("抛「标记完成需要它」", async () => {
      await assert.rejects(() => markChecked({ sheet: SHEET, version: VERSION, rows: ROWS }), /标记完成需要它/)
    })
    check("一次都没调 checkDone", () => assert.equal(calls.length, 0, `实际调了 ${calls.length} 次`))
  }
  console.log("\n【2】版本串非法：抛错，且 editor 一次都不调")
  {
    mount()
    const bad = ["", "   ", "abc", "a".repeat(63), "a".repeat(65), "g".repeat(64)]
    await check("六种非法版本都抛「清榜核查缺少有效版本」", async () => {
      const before = calls.length
      for (const version of bad)
        await assert.rejects(
          () => markChecked({ sheet: SHEET, version, rows: ROWS }),
          /清榜核查缺少有效版本/,
          `version=${JSON.stringify(version)}`,
        )
      assert.equal(calls.length, before, `不该调 checkDone：${JSON.stringify(calls.slice(before))}`)
    })
    await check("不给 version（undefined）同样按缺失处理", async () => {
      await assert.rejects(() => markChecked({ sheet: SHEET, rows: ROWS }), /清榜核查缺少有效版本/)
    })
  }
  console.log("\n【3】rows 为空：早返回，不调 editor、不抛")
  {
    const before = calls.length
    await check("rows: [] → {updated:0, rows:[]}", async () => {
      const out = await markChecked({ sheet: SHEET, version: VERSION, rows: [] })
      assert.deepEqual(out, { updated: 0, rows: [] })
      assert.equal(calls.length, before, `不该调 checkDone：${JSON.stringify(calls.slice(before))}`)
    })
    await check("不给 rows（默认空）→ 同样早返回", async () => {
      const out = await markChecked({ sheet: SHEET, version: VERSION })
      assert.deepEqual(out, { updated: 0, rows: [] })
      assert.equal(calls.length, before, `不该调 checkDone：${JSON.stringify(calls.slice(before))}`)
    })
  }
  console.log("\n【4】正常路径：恰好调一次，参数逐个透传")
  {
    const before = calls.length
    const out = await markChecked({
      sheet: SHEET,
      version: VERSION,
      rows: [{ row: "7", nickname: "小明", goal: "第12层满星" }],
    })
    check("checkDone 恰好调 1 次", () => assert.equal(calls.length, before + 1, `实际调了 ${calls.length - before} 次`))
    check("body：榜名与版本原样透传", () => {
      const c = calls.at(-1)
      assert.ok(c, "checkDone 没被调用")
      assert.equal(c.body.sheet, SHEET)
      assert.equal(c.body.version, VERSION)
    })
    check("行号转成数字（输入字符串 \"7\" → 7），昵称与目标一起带上", () => {
      const rows = calls.at(-1)?.body?.rows ?? []
      assert.equal(rows.length, 1, JSON.stringify(rows))
      assert.strictEqual(rows[0].row, 7, `行号不是数字：${JSON.stringify(rows[0].row)}`)
      assert.equal(rows[0].nickname, "小明")
      assert.equal(rows[0].goal, "第12层满星")
    })
    check("调用者是机器人身份：ROSTER_QQ +「清榜核查」", () => {
      const caller = calls.at(-1)?.caller ?? {}
      assert.equal(String(caller.qq), ROSTER_QQ, JSON.stringify(caller))
      assert.equal(caller.nick, "清榜核查", JSON.stringify(caller))
    })
    check("回执把编辑器的结果并回来（ok=true）", () => assert.equal(out.ok, true, JSON.stringify(out)))
  }
  await ENV.cloud?.close()
  await fs.rm(ENV.dir, { recursive: true, force: true }).catch(() => {})
  await finish()
  resetEditorService()
})()

await (async () => {
  const { precheckEvents } = await import("../components/cycle.js")
  const { extraOf, judgeForGoal } = await import("../modules/check-done.js")
  const { evaluateGoal } = await import("../modules/check-done.js")
  const { resolvePlayer } = await import("../modules/check-done.js")
  const at = s => new Date(s)
  const event = (events, sheet, round) =>
    events.find(e => e.sheet === sheet && e.type === "verify" && e.round === round)
  check("剧诗按每一行选的模式与目标判定", () => {
    const full = { mode_id: 5, star_medal: 12, round_count: 10 }
    assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满星章", full), true)
    assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满原石", full), true)
    assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满原石", { ...full, round_count: 9 }), false)
    assert.equal(judgeForGoal("幻想真境剧诗", "卓越模式满星章", { mode_id: 4, star_medal: 10 }), true)
    assert.equal(judgeForGoal("幻想真境剧诗", "困难模式满星章", { mode_id: 3, star_medal: 8 }), true)
    assert.equal(judgeForGoal("幻想真境剧诗", "困难模式满星章", { mode_id: 3, star_medal: 7 }), false)
    /** 旧写法不再认 */
    assert.equal(judgeForGoal("幻想真境剧诗", "月谕满花", full), false)
    assert.equal(judgeForGoal("幻想真境剧诗", "月谕满原石", full), false)
  })
  check("危战按 N 数与 180s 目标判定", () => {
    assert.equal(judgeForGoal("幽境危战", "绝境(N6)", { difficulty: 6, time_second: 999 }), true)
    assert.equal(judgeForGoal("幽境危战", "绝境(N6)180s", { difficulty: 6, time_second: 180 }), true)
    assert.equal(judgeForGoal("幽境危战", "绝境(N6)180s", { difficulty: 6, time_second: 181 }), false)
    assert.equal(judgeForGoal("幽境危战", "无畏(N5)", { difficulty: 5, time_second: 999 }), true)
    assert.equal(judgeForGoal("幽境危战", "无畏(N5)", { difficulty: 6, time_second: 100 }), true)
    assert.equal(judgeForGoal("幽境危战", "绝境(N6)", { difficulty: 5, time_second: 100 }), false)
  })
  check("深渊按目标层数判定", () => {
    assert.equal(judgeForGoal("深境螺旋", "第12层满星", { total_star: 36 }), true)
    assert.equal(judgeForGoal("深境螺旋", "第12层满星", { max_floor: "12-3", max_floor_star: 9 }), true)
    assert.equal(judgeForGoal("深境螺旋", "第12层满星", { max_floor: "11-3", max_floor_star: 9 }), false)
    assert.equal(judgeForGoal("深境螺旋", "第11层满星", { max_floor: "11-3", max_floor_star: 9 }), true)
    /** 旧写法不再认 */
    assert.equal(judgeForGoal("深境螺旋", "12层满星", { total_star: 36 }), false)
  })
  check("部分达成只播报、不填表", () => {
    assert.equal(evaluateGoal("幽境危战", "绝境(N6)", { difficulty: 5, time_second: 100 }).status, "partial")
    assert.equal(evaluateGoal("幽境危战", "绝境(N6)180s", { difficulty: 6, time_second: 220 }).status, "partial")
    assert.equal(evaluateGoal("幻想真境剧诗", "月谕模式满星章", { mode_id: 5, star_medal: 11 }).status, "partial")
    assert.equal(evaluateGoal("深境螺旋", "第12层满星", { max_floor: "11-3", max_floor_star: 9 }).status, "partial")
    assert.equal(evaluateGoal("幽境危战", "绝境(N6)", { difficulty: 6, time_second: 200 }).status, "achieved")
  })
  check("原始接口字段映射", () => {
    const drama = extraOf(1, {
      stat: { difficulty_id: 5, get_medal_round_list: Array(12).fill(1) },
      detail: { rounds_data: Array(10).fill({}) },
    })
    assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满星章", drama), true)
    assert.equal(judgeForGoal("幻想真境剧诗", "月谕模式满原石", drama), true)
    const hard = extraOf(2, { single: { best: { difficulty: 6, second: 180 } } })
    assert.equal(judgeForGoal("幽境危战", "绝境(N6)180s", hard), true)
    const abyss = extraOf(0, {
      max_floor: "12-3",
      total_star: 36,
      floors: [{ index: 11, star: 9 }, { index: 12, star: 9 }],
    })
    assert.equal(judgeForGoal("深境螺旋", "第12层满星", abyss), true)
  })
  check("玩家解析：绑定优先、归一化昵称、主播不充玩家", () => {
    const model = { anchors: [{ name: "主播甲" }] }
    const store = {
      qqsOf: () => ["10001"],
      get: () => ({ nickname: "甲" }),
    }
    const dir = new Map([["甲", "10001"], ["主播甲", "99999"]])
    assert.equal(resolvePlayer({ model, store, dir, sheet: "深境螺旋", row: 10, nickname: "甲" }).qq, "10001")
    const noBind = { qqsOf: () => [], get: () => null }
    assert.equal(resolvePlayer({ model, store: noBind, dir: new Map([["甲 ", "10002"]]), sheet: "深境螺旋", row: 10, nickname: "甲" }).qq, "10002")
    assert.equal(resolvePlayer({ model, store: noBind, dir, sheet: "深境螺旋", row: 10, nickname: "主播甲" }).kind, "missing")
    assert.equal(resolvePlayer({ model, store: noBind, dir, sheet: "深境螺旋", row: 10, nickname: "乙" }).kind, "missing")
    assert.equal(resolvePlayer({ model, store, dir: new Map([["别人", "10003"]]), sheet: "深境螺旋", row: 10, nickname: "甲" }).kind, "left")
    /** Map 覆盖了完全同名的一人，但 playerEntries 仍保留；可靠绑定不能因此被判退群 */
    const dupDir = new Map([["同名", "10002"]])
    dupDir.playerEntries = [["同名", "10001"], ["同名", "10002"]]
    const dupStore = { qqsOf: () => ["10001"], get: () => ({ nickname: "同名" }) }
    assert.equal(resolvePlayer({ model, store: dupStore, dir: dupDir, sheet: "深境螺旋", row: 10, nickname: "同名" }).qq, "10001")
    assert.equal(resolvePlayer({ model, store: noBind, dir: dupDir, sheet: "深境螺旋", row: 10, nickname: "同名" }).kind, "ambiguous")
  })
  check("核查窗口：清榜提醒前 1 小时，三榜各一次；枪战不参与", () => {
    const drama = precheckEvents(at("2026-10-31T11:30:00+08:00"))
    assert.ok(event(drama, "幻想真境剧诗", "2026-10"))
    assert.equal(precheckEvents(at("2026-10-31T10:59:00+08:00")).length, 0)
    assert.equal(precheckEvents(at("2026-10-31T12:00:00+08:00")).length, 0)
    const abyss = precheckEvents(at("2026-11-15T11:30:00+08:00"))
    assert.ok(event(abyss, "深境螺旋", "2026-11"))
    const stygian = precheckEvents(at("2026-11-02T11:30:00+08:00"))
    assert.ok(event(stygian, "幽境危战", "2026-09-30"))
    assert.equal(precheckEvents(at("2026-11-04T09:30:00+08:00")).some(e => e.sheet === "绝境攻炼"), false)
  })
  await finish()
})()

finish()
