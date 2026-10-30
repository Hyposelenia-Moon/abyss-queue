/**
 * 压紧行时完成情况锁的迁移（AQ-08）
 *
 * 锁按 `榜#行号` 存。迁移时若"在同一个对象里读旧键、写新键、删旧键"：
 * 新键可能正好是还没迁移的另一条锁，于是**一条被覆盖、另一条落到错的行上**，
 * 被锁住的完成情况恢复成可编辑（锁错人／锁丢了）。
 *
 * 复现顺序很关键：先锁下面那一行、再锁上面那一行（JSON 里的键顺序变成 [下行, 上行]），
 * 然后让更上面的人退群触发整体上移。期望：每条锁都跟着自己的人走到新行号；
 * 归属对不上（锁上记的人 ≠ 那一行的人）的锁一律作废，而不是搬到别人头上。
 *
 * 这里用仓库里的空模板起步，不依赖真实表格。
 */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("压紧行与完成情况锁")

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
/** 四个人：甲在最上面（会被退群），乙丙在下面（有锁） */
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
  const anchor = (opts.anchor ?? [])[0] ?? "都可以"
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
  /**
   * 造锁用的值：必须是**完成人**（主播名 / 该行自己的群昵称）
   *
   * 2026-10-14 起「主播改成状态词（排队中 / 等待开启）不再上锁」，而这里原来取的是 `opts.status`
   * 里第一个不同的值（常常就是「等待开启」）⇒ 造不出锁、这条用例的前置直接失败。
   */
  const lockValue = async row => {
    const r = await rowOf(row)
    const mine = String(r.nickname ?? "").trim()
    const list = [...(opts.anchor ?? []).map(String), mine].filter(v => v && v !== r.status)
    if (!list.length) throw new Error(`造不出锁：第 ${row} 行没有可用的完成人`)
    return list[0]
  }
  /**
   * "试着改一下"用的值：必须是**普通人能填的那两档**之一（`排队中` / 自己的群昵称）
   *
   * 拿主播名去试会被"个人只能填两档"那条拦下（`ignored` 的原因也会变成配额那条），
   * 于是"丁（没锁）照常能改"就验成了别的东西。优先 `排队中`，已经是它就换成自己的群昵称。
   */
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
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在异步句柄收尾途中触发 libuv 断言崩溃 */
