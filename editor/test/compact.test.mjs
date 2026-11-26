/** 删行压紧：delete-compact / lock-compact 合并成一个套件（原文件见 git 历史） */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { createChecker } from "../../test/_helper.mjs"

const { check, finish } = createChecker("删行压紧")

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")
  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过删行压紧套件`)
    process.exit(0)
  }
  const ws = makeWorkspace("delete-compact")
  const TOKEN = "delete-compact-token"
  const SIGN_KEY = "delete-compact-sign-key"
  const OWNER = { qq: "424242", nick: "主人" }
  const adminsFile = ws.file("admins.json")
  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
  const SHEET = "幽境危战"
  const { Table } = await shared("model/table.js")
  const table = new Table({ file: ws.fixture, backup: false })
  const bootModel = await table.read(({ models }) => models.get(SHEET))
  const ds = bootModel.dataStart
  const anchor = (bootModel.options?.anchor ?? [])[0] ?? "公共队列"
  const goal = (bootModel.options?.goal ?? [])[0] ?? ""
  const people = [
    { row: ds, qq: "31001", nick: "甲" },
    { row: ds + 1, qq: "31002", nick: "乙" },
    { row: ds + 2, qq: "31003", nick: "丙" },
    { row: ds + 3, qq: "31004", nick: "丁" },
    { row: ds + 4, qq: "31005", nick: "戊" },
    { row: ds + 5, qq: "31006", nick: "己" },
  ]
  const LOCKED = people[3]
  await table.mutate(ctx => {
    for (const p of people) {
      ctx.setCell(SHEET, p.row, "nickname", p.nick)
      ctx.setCell(SHEET, p.row, "gameName", `${p.nick}的游戏名`)
      ctx.setCell(SHEET, p.row, "anchor", anchor)
      ctx.setCell(SHEET, p.row, "goal", goal)
      ctx.setCell(SHEET, p.row, "status", "排队中")
    }
  })
  const fp = await table.fingerprint()
  const binds = { [SHEET]: {} }
  for (const p of people) binds[SHEET][p.qq] = { row: p.row, nickname: p.nick, at: 0 }
  fs.writeFileSync(ws.bindingsFile, JSON.stringify({ version: 1, table: fp, binds }, null, 2), "utf8")
  fs.writeFileSync(
    ws.locksFile,
    JSON.stringify({ table: fp, rows: { [`${SHEET}#${LOCKED.row}`]: { nickname: LOCKED.nick, by: "主播甲", at: 0 } } }, null, 2),
    "utf8",
  )
  let editor = null
  try {
    editor = await startEditor({
      label: "删行压紧",
      token: TOKEN,
      signKey: SIGN_KEY,
      adminsFile,
      args: ["--file", ws.fixture],
      env: {
        ABYSS_QUEUE_CONFIG: ws.cfg,
        ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
        ABYSS_EDITOR_TEST_PATHS: "1",
      },
    })
    const versionsDir = ws.file("versions")
    const load = async () => (await editor.request("/api/data", { who: OWNER })).json
    const sheetOf = payload => payload.sheets.find(s => s.name === SHEET)
    /** 页面上那个序号：有 A 列的缓存值就用它，没有才按数据区起点算（与 `editor.html` 同一口径） */
    const shownSeq = (payload, row) => {
      const item = sheetOf(payload).rows.find(r => r.row === Number(row))
      if (!item) return ""
      return String(item.seq ?? "").trim() || String(item.row - sheetOf(payload).dataStart + 1)
    }
    const nickAt = (payload, row) => String(sheetOf(payload).rows.find(r => r.row === Number(row))?.nickname ?? "")
    const occupied = payload => sheetOf(payload).rows.map(r => r.row)
    const readBinds = () => JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8")).binds?.[SHEET] ?? {}
    const readLocks = () => JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows ?? {}
    const dirCount = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0)
    /** 清空整行：必填列也要显式给空串（漏传的字段按"不动"处理） */
    const clearRow = async row => {
      const payload = await load()
      const blanks = Object.fromEntries(payload.fields.map(f => [f.key, ""]))
      return editor.request("/api/save", { who: OWNER, body: { sheet: SHEET, rows: [{ row, values: blanks }] } })
    }
    const before = await load()
    /* ---------------------------- 前置 ---------------------------- */
    await check("前置：六个人连着坐好、序号 1..6、锁在丁那一行", () => {
      if (occupied(before).join(",") !== people.map(p => p.row).join(","))
        throw new Error(`行号不是连续的 ${people[0].row}..${people[5].row}：${JSON.stringify(occupied(before))}`)
      for (const p of people) {
        if (nickAt(before, p.row) !== p.nick) throw new Error(`第 ${p.row} 行是「${nickAt(before, p.row)}」，应当是「${p.nick}」`)
        if (shownSeq(before, p.row) !== String(p.row - ds + 1))
          throw new Error(`第 ${p.row} 行的序号是「${shownSeq(before, p.row)}」，应当是 ${p.row - ds + 1}`)
      }
      if (!readLocks()[`${SHEET}#${LOCKED.row}`]) throw new Error(`前置：丁那一行没有锁：${JSON.stringify(Object.keys(readLocks()))}`)
    })
    /* ----------------------- ① 删中间那一行 ----------------------- */
    const versionsBefore = dirCount(versionsDir)
    const deleted = people[2]
    const cut = await clearRow(deleted.row)
    const after = await load()
    const bindsAfter = readBinds()
    const locksAfter = readLocks()
    await check("清空中间一行：回执带 `compacted`（删了 1 行），`cleared` 照旧记账", () => {
      if (cut.status !== 200 || !cut.json.ok) throw new Error(`HTTP ${cut.status} ${JSON.stringify(cut.json)}`)
      if (cut.json.cleared !== 1) throw new Error(`cleared=${cut.json.cleared}，应当是 1：${JSON.stringify(cut.json)}`)
      if (!cut.json.compacted) throw new Error(`回执里没有 compacted（下面的行没被提上来）：${JSON.stringify(cut.json)}`)
      if (cut.json.compacted.removed !== 1) throw new Error(`compacted.removed=${cut.json.compacted.removed}，应当是 1`)
    })
    await check("空档合上了：页面上行号连续、序号 1..5，中间没有跳号", () => {
      const want = [ds, ds + 1, ds + 2, ds + 3, ds + 4]
      if (occupied(after).join(",") !== want.join(","))
        throw new Error(`行号不连续（空档还在）：${JSON.stringify(occupied(after))}，应当是 ${JSON.stringify(want)}`)
      for (const row of want) {
        const seq = shownSeq(after, row)
        if (seq !== String(row - ds + 1)) throw new Error(`第 ${row} 行的序号是「${seq}」，应当是 ${row - ds + 1}（序号跳号了）`)
      }
    })
    await check("下面的人整体上移一格，删掉的人不在表里了", () => {
      if (nickAt(after, ds + 2) !== LOCKED.nick)
        throw new Error(`第 ${ds + 2} 行应当是「${LOCKED.nick}」，实际「${nickAt(after, ds + 2)}」`)
      if (nickAt(after, ds + 3) !== people[4].nick)
        throw new Error(`第 ${ds + 3} 行应当是「${people[4].nick}」，实际「${nickAt(after, ds + 3)}」`)
      if (nickAt(after, ds + 4) !== people[5].nick)
        throw new Error(`第 ${ds + 4} 行应当是「${people[5].nick}」，实际「${nickAt(after, ds + 4)}」`)
      if (sheetOf(after).rows.some(r => r.nickname === deleted.nick)) throw new Error(`「${deleted.nick}」还在表里`)
    })
    await check("上移后的行显示的是它**现在**那一行的序号（A 列没过人手，序号 = 位置）", () => {
      const moved = sheetOf(after).rows.find(r => r.nickname === LOCKED.nick)
      if (!moved) throw new Error("找不到丁那一行")
      if (String(moved.seq ?? "").trim() !== String(ds + 2 - ds + 1))
        throw new Error(`丁的序号是「${moved.seq}」，应当是 ${ds + 2 - ds + 1}（他搬到了第 ${ds + 2} 行）`)
    })
    await check("归属跟搬：绑定与锁里的行号一起走，被删那一行的绑定作废", () => {
      const at = qq => Number(bindsAfter[qq]?.row ?? 0)
      if (at(LOCKED.qq) !== ds + 2) throw new Error(`丁的绑定没跟搬：${JSON.stringify(bindsAfter[LOCKED.qq])}`)
      for (const p of [people[4], people[5]])
        if (at(p.qq) !== p.row - 1) throw new Error(`${p.nick}的绑定没跟搬：${JSON.stringify(bindsAfter[p.qq])}`)
      for (const p of [people[0], people[1]])
        if (at(p.qq) !== p.row) throw new Error(`${p.nick}的绑定不该动：${JSON.stringify(bindsAfter[p.qq])}`)
      if (bindsAfter[deleted.qq]) throw new Error(`被删那一行的绑定还在：${JSON.stringify(bindsAfter[deleted.qq])}`)
      const lock = locksAfter[`${SHEET}#${ds + 2}`]
      if (!lock) throw new Error(`锁没跟搬：${JSON.stringify(Object.keys(locksAfter))}（丁的锁应当落在第 ${ds + 2} 行）`)
      if (String(lock.nickname ?? "") !== LOCKED.nick) throw new Error(`锁上记的名字不对：${JSON.stringify(lock)}`)
      if (locksAfter[`${SHEET}#${LOCKED.row}`]) throw new Error("锁还留在旧行号上（等于锁到别人头上）")
    })
    await check("删前留了底：多一份历史版本（可回退）", () => {
      if (dirCount(versionsDir) <= versionsBefore) throw new Error(`没有新增历史版本：${versionsBefore} → ${dirCount(versionsDir)}`)
    })
    /* ------------------- ② 清空本来就空的行：不压紧 ------------------- */
    const liveAfterFirst = occupied(after)
    const emptyRow = Number(sheetOf(after).dataEnd)
    const emptySave = await clearRow(emptyRow)
    const afterEmpty = await load()
    await check("清空一行本来就空的格子：不算删行，也不压紧、不白写一遍", () => {
      if (emptySave.status !== 200 || !emptySave.json.ok) throw new Error(`HTTP ${emptySave.status} ${JSON.stringify(emptySave.json)}`)
      if (emptySave.json.compacted) throw new Error(`空行被清空不该压紧：${JSON.stringify(emptySave.json.compacted)}`)
      if (occupied(afterEmpty).join(",") !== liveAfterFirst.join(","))
        throw new Error(`行号变了：${JSON.stringify(liveAfterFirst)} → ${JSON.stringify(occupied(afterEmpty))}`)
    })
    /* ------------------ ③ 清空最后一行：不压紧（没东西可提） ------------------ */
    const lastRow = occupied(afterEmpty).at(-1)
    const lastSave = await clearRow(lastRow)
    const afterLast = await load()
    await check("清空最后一行：不压紧（后面没有行要上移），其余行一号不动", () => {
      if (!lastSave.json.ok) throw new Error(lastSave.json.error || "清不掉")
      if (lastSave.json.compacted) throw new Error(`最后一行不该触发压紧：${JSON.stringify(lastSave.json.compacted)}`)
      if (occupied(afterLast).join(",") !== occupied(afterEmpty).slice(0, -1).join(","))
        throw new Error(`别的行被动过：${JSON.stringify(occupied(afterEmpty))} → ${JSON.stringify(occupied(afterLast))}`)
    })
    /* ---------------------- ④ 一次清两行：两个空档一起合上 ---------------------- */
    const liveBeforeTwo = occupied(afterLast)
    const two = [liveBeforeTwo[1], liveBeforeTwo[2]]
    const twoSave = await editor.request("/api/save", {
      who: OWNER,
      body: {
        sheet: SHEET,
        rows: two.map(row => ({ row, values: Object.fromEntries(before.fields.map(f => [f.key, ""])) })),
      },
    })
    const afterTwo = await load()
    await check("一次清两行：回执说删了 2 行，剩下的行号接着排、序号仍是 1..N", () => {
      if (!twoSave.json.ok) throw new Error(twoSave.json.error || "清不掉")
      if (twoSave.json.compacted?.removed !== 2) throw new Error(`compacted.removed=${twoSave.json.compacted?.removed}，应当是 2`)
      /** 活下来的人按原顺序从数据区起点重排：`survivors` 是"压紧之前"的行号，`want` 是压紧之后的 */
      const survivors = liveBeforeTwo.filter(row => !two.includes(row))
      const want = survivors.map((_, i) => ds + i)
      if (occupied(afterTwo).join(",") !== want.join(","))
        throw new Error(`行号不是连续的：${JSON.stringify(occupied(afterTwo))}，应当是 ${JSON.stringify(want)}`)
      for (const row of want)
        if (shownSeq(afterTwo, row) !== String(row - ds + 1))
          throw new Error(`第 ${row} 行的序号是「${shownSeq(afterTwo, row)}」，应当是 ${row - ds + 1}`)
    })
    /* ------------- ⑤ 表里已有"漏压紧"的空档：下一次删行把它一起合上 ------------- */
    // 并发删行的后果（2026-10-18 审核观察，未计入 P2）：两次几乎同时的删除可能这样交错——
    const base = Number(sheetOf(await load()).dataStart)
    await table.mutate(ctx => {
      for (let i = 0; i < 4; i++) {
        const row = base + i
        ctx.setCell(SHEET, row, "nickname", `空档${i}`)
        ctx.setCell(SHEET, row, "gameName", `空档${i}游戏名`)
        ctx.setCell(SHEET, row, "anchor", anchor)
        ctx.setCell(SHEET, row, "goal", goal)
        ctx.setCell(SHEET, row, "status", "排队中")
      }
    })
    /** 造空档：把第 2 行（base+1）直接清空，**不走接口** ⇒ 没有任何压紧发生 */
    await table.mutate(ctx => {
      for (const key of ["nickname", "gameName", "anchor", "goal", "note", "status"]) ctx.setCell(SHEET, base + 1, key, "")
    })
    const holed = await load()
    check("前置：表里确实留着一个空档（第 2 行空、下面还有活人）", () => {
      if (nickAt(holed, base + 1)) throw new Error(`第 ${base + 1} 行还有内容：${JSON.stringify(occupied(holed))}`)
      if (!occupied(holed).includes(base + 2)) throw new Error(`下面没有活人，测不出空档：${JSON.stringify(occupied(holed))}`)
      if (occupied(holed).join(",") === [base, base + 1, base + 2, base + 3].join(","))
        throw new Error("空档没造出来（行号还是连续的）")
    })
    const sweep = await clearRow(base + 2)
    const swept = await load()
    check("删一行 ⇒ 这个空档和这次删的那行一起合上（扫的是全部空档，不是只有这一行）", () => {
      if (!sweep.json.ok) throw new Error(sweep.json.error || "删不掉")
      const want = [base, base + 1]
      if (occupied(swept).join(",") !== want.join(","))
        throw new Error(`还剩空档：${JSON.stringify(occupied(swept))}，应当是 ${JSON.stringify(want)}（老实现会留下 ${JSON.stringify([base, base + 2])}）`)
      for (const row of want)
        if (shownSeq(swept, row) !== String(row - base + 1))
          throw new Error(`第 ${row} 行的序号是「${shownSeq(swept, row)}」，应当是 ${row - base + 1}`)
    })
  } catch (err) {
    await check("套件执行", async () => {
      throw err
    })
  } finally {
    if (editor) await editor.stop()
    ws.cleanup()
  }
  await finish()
})()

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")
  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过压紧行套件`)
    process.exit(0)
  }
  const ws = makeWorkspace("lock-compact")
  const TOKEN = "lock-compact-token"
  const SIGN_KEY = "lock-compact-sign-key"
  const OWNER = { qq: "424242", nick: "主人" }
  const BOT = { qq: "0", nick: "群名单" }
  const adminsFile = ws.file("admins.json")
  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
  const SHEET = "幽境危战"
  const MEMBERS = [
    { qq: "30008", nick: "名单甲" },
    { qq: "30009", nick: "名单乙" },
    { qq: "30010", nick: "名单丙" },
    { qq: "30011", nick: "名单丁" },
  ]
  const locksFile = () => JSON.parse(fs.readFileSync(ws.locksFile, "utf8"))
  const lockAt = row => locksFile().rows?.[`${SHEET}#${row}`]
  let editor = null
  try {
    editor = await startEditor({
      label: "压紧行锁迁移",
      token: TOKEN,
      signKey: SIGN_KEY,
      adminsFile,
      args: ["--file", ws.fixture],
      env: {
        ABYSS_QUEUE_CONFIG: ws.cfg,
        ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
        ABYSS_EDITOR_ROSTER_FILE: ws.file("roster.json"),
        /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
        ABYSS_EDITOR_TEST_PATHS: "1",
      },
    })
    const payload = await editor.request("/api/data", { who: OWNER })
    const sheet = payload.json.sheets.find(s => s.name === SHEET)
    const base = sheet.dataStart
    const rows = [base, base + 1, base + 2, base + 3]
    const [rA, rB, rC, rD] = rows
    const opts = sheet.options ?? {}
    const anchor = (opts.anchor ?? [])[0] ?? "公共队列"
    const goal = (opts.goal ?? [])[0] ?? "N5"
    const rowOf = async row => {
      const now = await editor.request("/api/data", { who: OWNER })
      return now.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
    }
    /** 完成情况一改会触发整理；锁测试一律按昵称现查，不拿旧行号 */
    const rowsOf = async () => {
      const now = await editor.request("/api/data", { who: OWNER })
      return now.json.sheets.find(s => s.name === SHEET).rows
    }
    const rowByNick = async nickname => {
      const hit = (await rowsOf()).find(row => String(row.nickname ?? "").trim() === nickname)
      if (!hit) throw new Error(`找不到「${nickname}」那一行：${JSON.stringify((await rowsOf()).map(r => r.nickname))}`)
      return hit
    }
    /** 每个成员各占一行（首次报名） */
    await check("准备：四个成员各占一行", async () => {
      for (let i = 0; i < MEMBERS.length; i++) {
        const who = MEMBERS[i]
        const saved = await editor.request("/api/save", {
          who,
          body: { sheet: SHEET, rows: [{ row: rows[i], values: { nickname: who.nick, gameName: "游戏", anchor, goal } }] },
        })
        if (!saved.json.ok) throw new Error(`${who.nick} 占第 ${rows[i]} 行失败：${saved.json.error}`)
      }
      /** 四行先各自落成自己的群昵称：都算已完成，但都不上锁；同组内按行号稳定 */
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const who = MEMBERS[i]
        const saved = await editor.request("/api/save", {
          who: OWNER,
          body: { sheet: SHEET, rows: [{ row, values: { status: who.nick } }] },
        })
        if (!saved.json.ok) throw new Error(`第 ${row} 行铺完成状态失败：${saved.json.error}`)
      }
      const now = await editor.request("/api/data", { who: OWNER })
      const got = now.json.sheets.find(s => s.name === SHEET).rows
      if (got.length !== 4) throw new Error(`应当有 4 行，实际 ${got.length}`)
    })
    /** 锁：先锁丙（下面那一行）、再锁乙（上面那一行）——键顺序就是触发错搬的那个顺序 */
    // 造锁用的值：必须是**完成人**（主播名 / 该行自己的群昵称）
    const lockValue = async row => {
      const r = await rowOf(row)
      const mine = String(r.nickname ?? "").trim()
      const list = [...(opts.anchor ?? []).map(String), mine].filter(v => v && v !== r.status)
      if (!list.length) throw new Error(`造不出锁：第 ${row} 行没有可用的完成人`)
      return list[0]
    }
    // "试着改一下"用的值：必须是**普通人能填的那两档**之一（`排队中` / 自己的群昵称）
    const tryValue = async row => {
      const r = await rowOf(row)
      const mine = String(r.nickname ?? "").trim()
      /** 优先用自己的昵称：仍是已完成组，不会因“改成排队中”把这一行搬到最后一组 */
      const list = [mine, "排队中"].filter(v => v && v !== r.status)
      if (!list.length) throw new Error(`第 ${row} 行没有可用来试探的完成情况`)
      return list[0]
    }
    await check("准备：先锁丙那一行、再锁乙那一行（键顺序 [下行, 上行]）", async () => {
      for (const who of [MEMBERS[2], MEMBERS[1]]) {
        const current = await rowByNick(who.nick)
        const row = current.row
        const r = await rowOf(row)
        const saved = await editor.request("/api/save", {
          who: OWNER,
          body: { sheet: SHEET, rows: [{ row, values: { ...r, status: await lockValue(row) } }] },
        })
        if (!saved.json.ok) throw new Error(`锁第 ${row} 行失败：${saved.json.error}`)
      }
      const bing = await rowByNick(MEMBERS[2].nick)
      const yi = await rowByNick(MEMBERS[1].nick)
      const keys = Object.keys(locksFile().rows ?? {})
      if (keys.length !== 2) throw new Error(`应当有两条锁：${JSON.stringify(keys)}`)
      /** 顺序断言：这条测试的价值就在于"先下后上"的键顺序 */
      if (keys[0] !== `${SHEET}#${bing.row}` || keys[1] !== `${SHEET}#${yi.row}`)
        throw new Error(`键顺序不是预期的 [丙, 乙]：${JSON.stringify(keys)}，当前行 ${JSON.stringify({ 丙: bing.row, 乙: yi.row })}`)
      if (lockAt(bing.row)?.nickname !== MEMBERS[2].nick || lockAt(yi.row)?.nickname !== MEMBERS[1].nick)
        throw new Error(`锁上没记下归属：${JSON.stringify(locksFile().rows)}`)
    })
    await check("准备：塞两条归属有问题的锁（老格式没记昵称 / 昵称与那一行对不上）", async () => {
      const fp = (await editor.request("/api/version")).json.version
      const cur = locksFile()
      const jia = await rowByNick(MEMBERS[0].nick)
      const ding = await rowByNick(MEMBERS[3].nick)
      /** 只记行号的锁（没有昵称）：那一行（甲）马上要退群 → 应当整条丢弃 */
      cur.rows[`${SHEET}#${jia.row}`] = { by: "旧版本", at: 1 }
      /** 记了人却与那一行对不上；那一行（丁）会被上移 → 应当丢弃，不能搬到别人头上 */
      cur.rows[`${SHEET}#${ding.row}`] = { by: "旧版本", at: 2, nickname: "查无此人" }
      /** table 用当前版本，免得被当成"外部改表"整体对账掉——这里要单独验迁移逻辑 */
      fs.writeFileSync(ws.locksFile, JSON.stringify({ table: fp, rows: cur.rows }, null, 2), "utf8")
      if (Object.keys(locksFile().rows).length !== 4) throw new Error("塞锁失败")
    })
    await check("退群压紧：两条锁各跟着自己的人走到新行号，一条都没丢", async () => {
      const pushed = await editor.request("/api/roster", {
        who: BOT,
        body: { group: "999888", members: MEMBERS.slice(1).map(m => ({ qq: m.qq, nick: m.nick })) },
      })
      if (!pushed.json.ok) throw new Error(pushed.json.error || "推名单失败")
      if (pushed.json.removed !== 1) throw new Error(`应当删掉 1 行：${JSON.stringify(pushed.json)}`)
      const yi = await rowByNick(MEMBERS[1].nick)
      const bing = await rowByNick(MEMBERS[2].nick)
      const keys = Object.keys(locksFile().rows ?? {}).sort()
      const want = [`${SHEET}#${yi.row}`, `${SHEET}#${bing.row}`].sort()
      if (JSON.stringify(keys) !== JSON.stringify(want))
        throw new Error(`锁应当正好落在 ${JSON.stringify(want)}，实际 ${JSON.stringify(keys)}`)
      if (lockAt(yi.row)?.nickname !== MEMBERS[1].nick) throw new Error(`乙那一行的锁不对：${JSON.stringify(lockAt(yi.row))}`)
      if (lockAt(bing.row)?.nickname !== MEMBERS[2].nick) throw new Error(`丙那一行的锁不对：${JSON.stringify(lockAt(bing.row))}`)
      /** 归属对不上的那条（丁那一行上的"查无此人"）必须消失，而不是被搬到别人头上 */
      const ding = await rowByNick(MEMBERS[3].nick)
      if (lockAt(ding.row)) throw new Error(`该丢的锁还在：${JSON.stringify(locksFile().rows)}`)
    })
    await check("压紧之后：乙/丙（被锁）改不动完成情况，丁（没锁）照常能改", async () => {
      for (const who of [MEMBERS[1], MEMBERS[2]]) {
        const got = await rowByNick(who.nick)
        const mine = await editor.request("/api/data", { who })
        if (!mine.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === got.row))
          throw new Error(`${who.nick} 拿不到自己那一行（压紧后绑定没跟上）`)
        const saved = await editor.request("/api/save", {
          who,
          body: { sheet: SHEET, rows: [{ row: got.row, values: { ...got, status: await tryValue(got.row) } }] },
        })
        if (!saved.json.ok) throw new Error(`${who.nick} 保存失败：${saved.json.error}`)
        if (!(saved.json.ignored ?? []).some(i => i.label === "帮帮完成情况"))
          throw new Error(`${who.nick} 那一行应当仍被锁着：${JSON.stringify(saved.json)}`)
      }
      const ding = MEMBERS[3]
      const got = await rowByNick(ding.nick)
      const saved = await editor.request("/api/save", {
        who: ding,
        body: { sheet: SHEET, rows: [{ row: got.row, values: { ...got, status: await tryValue(got.row) } }] },
      })
      if (!saved.json.ok) throw new Error(`丁保存失败：${saved.json.error}`)
      if ((saved.json.ignored ?? []).some(i => i.label === "帮帮完成情况"))
        throw new Error("丁那一行没有锁，不该被拦（这就是「锁错人」）")
    })
  } catch (err) {
    await check("套件执行", async () => {
      throw err
    })
  } finally {
    if (editor) await editor.stop()
    ws.cleanup()
  }
  await finish()
})()

finish()
