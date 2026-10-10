/**
 * 删掉整行之后**立刻压紧**：序号列不留空档
 *
 * 现场（维护者截图）：页面上的序号读成 14、15、17 —— 撤掉的是那一行的**内容**，行号本身还占着。
 * 根因是两件事凑在一起：
 *   1. A 列序号是**按行算**的公式 `=ROW()-k`（一行一个行号，删掉的行不会自己让位）；
 *   2. 页面只画"表里还有内容的行"（`model/schema.js` 的 `rows` 不收整行空掉的行），
 *      空着的那一行从页面上消失，它下面的行号就跳号了。
 * 于是 `applySave` 清空整行之后要多做一件事：把下面的行整体提上来（`compactClearedRows`
 * → `dropRowsAndMigrate`，与"退群删行 / 主人确认删候选行"同一份实现）。
 *
 * 这个套件钉住的就是那一件事，以及它的**边界**：
 *   - 清空中间一行 ⇒ 下面的行整体上移一格，页面上的序号 1..N 连续、没有空档；
 *   - **A 列一格都不动**（序号本来就等于位置）：上移后的行显示的正是它现在那一行的序号；
 *   - 归属跟搬：绑定与完成情况锁的行号一起走，被删那一行的绑定作废（不能认到别人头上）；
 *   - 删前留底：历史版本多一份（可回退），`cleared` 计数照旧；
 *   - 清空**最后一行**、清空**本来就空的行** ⇒ 不压紧、不白写一遍（回执里压根没有 `compacted`）；
 *   - 一次清两行 ⇒ 两个空档一起合上。
 *
 * 用法：node editor/test/delete-compact.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("删行压紧（delete-compact）")

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
const anchor = (bootModel.options?.anchor ?? [])[0] ?? "都可以"
const goal = (bootModel.options?.goal ?? [])[0] ?? ""
const strength = (bootModel.options?.strength ?? [])[0] ?? "中配"

/** 六个连着坐好的成员；`r4` 那一行预先上一把锁（管理员改过完成情况才会锁），用来验"锁跟着人走" */
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
    ctx.setCell(SHEET, p.row, "strength", strength)
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
} catch (err) {
  await check("套件执行", async () => {
    throw err
  })
} finally {
  if (editor) await editor.stop()
  ws.cleanup()
}

await finish()
