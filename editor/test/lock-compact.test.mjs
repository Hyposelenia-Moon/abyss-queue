/**
 * 压紧行时完成情况锁的迁移（AQ-08）
 *
 * 锁按 `榜#行号` 存。以前迁压紧后的锁是"在同一个对象里读旧键、写新键、删旧键"：
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
import path from "node:path"
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
    ports: [7815, 7822, 7823],
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
    const now = await editor.request("/api/data", { who: OWNER })
    const got = now.json.sheets.find(s => s.name === SHEET).rows
    if (got.length !== 4) throw new Error(`应当有 4 行，实际 ${got.length}`)
  })

  /** 锁：先锁丙（下面那一行）、再锁乙（上面那一行）——键顺序就是触发老 bug 的那个顺序 */
  const altStatus = async row => {
    const r = await rowOf(row)
    const list = (opts.status ?? []).filter(v => v !== r.status)
    return list[0] ?? "排队中"
  }
  await check("准备：先锁丙那一行、再锁乙那一行（键顺序 [下行, 上行]）", async () => {
    for (const [row, who] of [
      [rC, MEMBERS[2]],
      [rB, MEMBERS[1]],
    ]) {
      const r = await rowOf(row)
      const saved = await editor.request("/api/save", {
        who: OWNER,
        body: { sheet: SHEET, rows: [{ row, values: { ...r, status: await altStatus(row) } }] },
      })
      if (!saved.json.ok) throw new Error(`锁第 ${row} 行失败：${saved.json.error}`)
    }
    const keys = Object.keys(locksFile().rows ?? {})
    if (keys.length !== 2) throw new Error(`应当有两条锁：${JSON.stringify(keys)}`)
    /** 顺序断言：这条测试的价值就在于"先下后上"的键顺序 */
    if (keys[0] !== `${SHEET}#${rC}` || keys[1] !== `${SHEET}#${rB}`)
      throw new Error(`键顺序不是预期的 [丙, 乙]：${JSON.stringify(keys)}`)
    if (lockAt(rC)?.nickname !== MEMBERS[2].nick || lockAt(rB)?.nickname !== MEMBERS[1].nick)
      throw new Error(`锁上没记下归属：${JSON.stringify(locksFile().rows)}`)
  })

  await check("准备：塞两条归属有问题的锁（老格式没记昵称 / 昵称与那一行对不上）", async () => {
    const fp = (await editor.request("/api/version")).json.version
    const cur = locksFile()
    /** 老格式：只记行号，不记人；那一行（甲）马上要退群 → 应当整条丢弃 */
    cur.rows[`${SHEET}#${rA}`] = { by: "旧版本", at: 1 }
    /** 记了人却与那一行对不上；那一行（丁）会被上移 → 应当丢弃，不能搬到别人头上 */
    cur.rows[`${SHEET}#${rD}`] = { by: "旧版本", at: 2, nickname: "查无此人" }
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

    const keys = Object.keys(locksFile().rows ?? {}).sort()
    const want = [`${SHEET}#${base}`, `${SHEET}#${base + 1}`].sort()
    if (JSON.stringify(keys) !== JSON.stringify(want))
      throw new Error(`锁应当正好落在 ${JSON.stringify(want)}，实际 ${JSON.stringify(keys)}`)
    if (lockAt(base)?.nickname !== MEMBERS[1].nick) throw new Error(`第 ${base} 行的锁不是乙的：${JSON.stringify(lockAt(base))}`)
    if (lockAt(base + 1)?.nickname !== MEMBERS[2].nick) throw new Error(`第 ${base + 1} 行的锁不是丙的：${JSON.stringify(lockAt(base + 1))}`)
    /** 归属对不上的那条（丁那一行上的"查无此人"）必须消失，而不是被搬到别人头上 */
    if (lockAt(rD)) throw new Error(`该丢的锁还在：${JSON.stringify(locksFile().rows)}`)
  })

  await check("压紧之后：乙/丙（被锁）改不动完成情况，丁（没锁）照常能改", async () => {
    /** 乙上移到第 base 行；丙在 base+1；丁在 base+2 */
    for (const [row, who] of [
      [base, MEMBERS[1]],
      [base + 1, MEMBERS[2]],
    ]) {
      const mine = await editor.request("/api/data", { who })
      const got = mine.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
      if (!got) throw new Error(`${who.nick} 拿不到第 ${row} 行（压紧后绑定没跟上）`)
      const saved = await editor.request("/api/save", {
        who,
        body: { sheet: SHEET, rows: [{ row, values: { ...got, status: await altStatus(row) } }] },
      })
      if (!saved.json.ok) throw new Error(`${who.nick} 保存失败：${saved.json.error}`)
      if (!(saved.json.ignored ?? []).some(i => i.label === "帮帮完成情况"))
        throw new Error(`${who.nick} 那一行应当仍被锁着：${JSON.stringify(saved.json)}`)
    }
    const ding = MEMBERS[3]
    const mine = await editor.request("/api/data", { who: ding })
    const got = mine.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === base + 2)
    if (!got) throw new Error("丁拿不到自己那一行")
    const saved = await editor.request("/api/save", {
      who: ding,
      body: { sheet: SHEET, rows: [{ row: base + 2, values: { ...got, status: await altStatus(base + 2) } }] },
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
process.exit(process.exitCode || 0)
