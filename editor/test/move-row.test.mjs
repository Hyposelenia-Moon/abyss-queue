/**
 * `POST /api/move-row`：插队（把已排队的某个人挪到他前面最近那一位「排队中」的前面）
 *
 * 验收的是"挪完之后表还是那张表"：
 *   - **无空行 / 无缺行**：数据区里摆过人的行号一根轴连到底（读原始 XML 核，不只信模型），
 *     每一行原有的列一个不缺；行数一个字不变；
 *   - **排队区序号仍是 1..N**：A 列 `=ROW()-k` 的缓存值逐行不变（插队不插行、不删行）；
 *   - **数据逐行一致、只是顺序变了**：整榜内容与挪之前同一个多重集合，且只有这两位换了位置；
 *   - **绑定与完成情况锁的行号跟搬**：绑定文件里两个人的行号互换、锁键跟着人走，
 *     锁上记的昵称 → 那一行现在的昵称仍然对得上（"版本戳对得上、人却被认到别人的行上"的反面）；
 *   - **失败即整表不动**：前面没有「排队中」的人 / 两边本来相邻（没有可越过的位置），
 *     都原样回话且表、绑定、锁一个字节不变；
 *   - **权限**：本人与访客一律 403，白名单管理员与主人放行。
 *
 * 用仓库里的空模板起步（结构齐全、没有成员），不依赖真实表格。
 */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, openWorkbook, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("插队（move-row）")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过插队套件`)
  process.exit(0)
}

const ws = makeWorkspace("move-row")
const TOKEN = "move-row-token"
const SIGN_KEY = "move-row-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const ADMIN = { qq: "424243", nick: "白名单管理员" }
const MEMBER = { qq: "20001", nick: "插队的人" }
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [ADMIN.qq] }), "utf8")

const SHEET = "幽境危战"
const QUEUED = "排队中"
/** A 列序号、B–H 数据列：挪行时这几列要跟着人走 */
const COLUMNS = ["A", "B", "C", "D", "E", "F", "G", "H"]
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"))

/** 原始 XML 里的行号 → 这一行有哪些列（只看有没有 `<c r="…">`，与模型无关） */
const rowShape = async sheet => {
  const wb = await openWorkbook(fs.readFileSync(ws.fixture))
  const xml = await wb.sheetXml(sheet)
  const rows = new Map()
  for (const m of xml.matchAll(/<row r="(\d+)"|<c r="([A-Z]+)(\d+)"/g)) {
    if (m[1] !== undefined) {
      if (!rows.has(Number(m[1]))) rows.set(Number(m[1]), new Set())
      continue
    }
    const at = Number(m[3])
    if (!rows.has(at)) rows.set(at, new Set())
    rows.get(at).add(m[2])
  }
  return rows
}

/**
 * ① 先摆数据 + 写绑定与锁，**再起编辑器**
 *
 * 绑定 / 锁 / 表必须"同一版"：编辑器每个写入口都会拿 `table` 对一次版本，对不上就按群昵称重建
 * （那是 AQ-03 的保护）。所以顺序只能是「改表 → 用改完后的指纹落绑定与锁 → 起编辑器」——
 * 反过来的话，编辑器一进来就把这份对不上账的绑定当作废处理，后面的断言全成了空转。
 */
const { Table } = await shared("model/table.js")
const table = new Table({ file: ws.fixture, backup: false })
const bootModel = await table.read(({ models }) => models.get(SHEET))
const dataStart = bootModel.dataStart
const [rA, rB, rC, rD, rE] = [dataStart, dataStart + 1, dataStart + 2, dataStart + 3, dataStart + 4]
const people = {
  [rA]: { qq: "30001", nick: "甲的候", status: QUEUED },
  [rB]: { qq: "30002", nick: "乙的候", status: QUEUED },
  [rC]: { qq: "30003", nick: "丙的候", status: QUEUED },
  [rD]: { qq: "30004", nick: "丁的候", status: QUEUED },
  [rE]: { qq: "30005", nick: "戊的候", status: "等待开启" },
}
/** 必填列（选择主播 / 难度及目标 / 账号强度）照模板里已有的下拉选项填上，否则后面改完成情况会被校验拒掉 */
const anchor = (bootModel.options?.anchor ?? [])[0] ?? "都可以"
const goal = (bootModel.options?.goal ?? [])[0] ?? ""
const strength = (bootModel.options?.strength ?? [])[0] ?? "中配"
await table.mutate(ctx => {
  for (const [row, p] of Object.entries(people)) {
    ctx.setCell(SHEET, Number(row), "nickname", p.nick)
    ctx.setCell(SHEET, Number(row), "gameName", `${p.nick}的游戏名`)
    ctx.setCell(SHEET, Number(row), "anchor", anchor)
    ctx.setCell(SHEET, Number(row), "goal", goal)
    ctx.setCell(SHEET, Number(row), "strength", strength)
    ctx.setCell(SHEET, Number(row), "status", p.status)
    ctx.setCell(SHEET, Number(row), "note", `${p.nick}的备注`)
  }
})
const fp = await table.fingerprint()
const binds = { [SHEET]: {} }
for (const [row, p] of Object.entries(people)) binds[SHEET][p.qq] = { row: Number(row), nickname: p.nick, at: 0 }
fs.writeFileSync(ws.bindingsFile, JSON.stringify({ version: 1, table: fp, binds }, null, 2), "utf8")
fs.writeFileSync(
  ws.locksFile,
  JSON.stringify({ table: fp, rows: { [`${SHEET}#${rB}`]: { nickname: people[rB].nick, by: "主播甲", at: 0 } } }, null, 2),
  "utf8",
)

let editor = null
try {
  editor = await startEditor({
    label: "插队",
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

  const sheetOf = payload => payload.sheets.find(s => s.name === SHEET)
  const load = async who => (await editor.request("/api/data", { who })).json
  const rowOf = (payload, row) => sheetOf(payload).rows.find(r => r.row === Number(row))
  const nickAt = (payload, row) => rowOf(payload, row)?.nickname ?? ""
  const move = (body, who = OWNER) => editor.request("/api/move-row", { who, body })
  const version = async () => (await editor.request("/api/version")).json.version

  /* ---------- 摆数据：甲的后面排着乙、丙、丁与「等待开启」的戊 ---------- */

  const before = await load(OWNER)
  const seqBefore = sheetOf(before).rows.map(r => String(r.seq))
  const shapeBefore = await rowShape(SHEET)
  const rowCountBefore = sheetOf(before).rows.length
  /** 前置自检：这一段用例要有意义，得真有五行数据、且两两之间隔着别人 */
  check("前置：数据区里有「甲..戊」五行、第一行是「排队中」、乙丙丁戊各不相同", () => {
    if (sheetOf(before).dataStart !== dataStart)
      throw new Error(`两边认出来的数据区起点不一致：表=${dataStart} 接口=${sheetOf(before).dataStart}`)
    if (String(rowOf(before, rA)?.seq) !== "1") throw new Error(`第一行序号不是 1：${JSON.stringify(rowOf(before, rA))}`)
    for (const [row, p] of Object.entries(people)) if (nickAt(before, row) !== p.nick) throw new Error(`第 ${row} 行是「${nickAt(before, row)}」`)
  })

  /* ------------------------------ ① 挪得动 ------------------------------ */

  /**
   * 先把「丙」那一行的完成情况锁上（管理员改过**完成情况**才会给本人上锁，见 applySave 里那一段）
   *
   * 锁按 `榜#行号` 存，挪行之后它必须跟着人走——这条断言是"行号跟搬"最硬的那一面：
   * 锁错了位置，被锁住的那一格会退回成可编辑（锁丢了 / 锁到别人头上）。
   * 换成一个**仍在队列里**的状态：丙要留在队列里才有后面的插队可言。
   */
  const statusAlt = QUEUED === "排队中" ? "等待开启" : "排队中"
  const locked = await editor.request("/api/save", {
    who: OWNER,
    body: { sheet: SHEET, rows: [{ row: rC, values: { ...rowOf(before, rC), status: statusAlt } }] },
  })
  if (!locked.json.ok) throw new Error(`前置：制造锁失败：${JSON.stringify(locked.json)}`)
  /** 这样插队就没了意义（丙不再是「排队中」）：把状态还回去，锁仍然留在那一行 */
  const restore = await editor.request("/api/save", {
    who: OWNER,
    body: { sheet: SHEET, rows: [{ row: rC, values: { ...rowOf(await load(OWNER), rC), status: QUEUED } }] },
  })
  if (!restore.json.ok) throw new Error(`前置：恢复状态失败：${JSON.stringify(restore.json)}`)
  /** 锁改动过表：重新取一次基线 */
  const beforeLocked = await load(OWNER)
  if (String(rowOf(beforeLocked, rC)?.status ?? "") !== QUEUED) throw new Error("前置：丙不是「排队中」了")
  if (!JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows?.[`${SHEET}#${rC}`])
    throw new Error("前置：丙那一行没有上锁（这条用例也就没验到东西）")

  const out1 = await move({ sheet: SHEET, row: rD, mode: "before-last-queued" }, ADMIN)
  /**
   * **挪完立刻同步取数**（绑定与锁直接读文件，不经过任何接口）
   *
   * 别的请求都可能顺带做一遍归属对账 / 同步，异步断言若排在它们后面就读不到这一刻的状态了；
   * 而"绑定与锁跟搬"正是这一次挪动最该钉住的那一面。
   */
  const binds1 = JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8")).binds?.[SHEET] ?? {}
  const locks1 = JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows ?? {}
  const after1 = await load(OWNER)
  /** 丁自己打开页面（本人视角）：这是**会触发归属对账**的请求，放在最后，免得它把刚取到的快照盖掉 */
  const mineDing = await load({ qq: people[rD].qq, nick: people[rD].nick })

  await check("白名单管理员插队：把「丁」挪到「丙」前面（越过一位）", () => {
    if (out1.status !== 200 || !out1.json.ok) throw new Error(`HTTP ${out1.status} ${JSON.stringify(out1.json)}`)
    if (out1.json.moved !== true) throw new Error(`没有挪动：${JSON.stringify(out1.json)}`)
    if (Number(out1.json.from) !== rD || Number(out1.json.to) !== rC)
      throw new Error(`挪到了别的地方：${JSON.stringify(out1.json)}`)
    if (out1.json.nickname !== people[rD].nick || out1.json.crossed !== people[rC].nick)
      throw new Error(`回执里的人名不对：${JSON.stringify(out1.json)}`)
    if (nickAt(after1, rC) !== people[rD].nick) throw new Error(`第 ${rC} 行现在是「${nickAt(after1, rC)}」`)
    if (nickAt(after1, rD) !== people[rC].nick) throw new Error(`第 ${rD} 行现在是「${nickAt(after1, rD)}」`)
  })

  await check("挪行之后：无空行 / 无缺行（数据区的行号与列一个不缺）", async () => {
    const sheet = sheetOf(after1)
    if (sheet.rows.length !== rowCountBefore) throw new Error(`行数变了：${rowCountBefore} → ${sheet.rows.length}`)
    /** 一根行号轴：从 dataStart 到"最后一行有数据的行"逐行都在（中间不许缺） */
    const shape = await rowShape(SHEET)
    const filled = sheet.rows.map(r => r.row)
    const last = Math.max(...filled)
    for (let row = sheet.dataStart; row <= last; row++) if (!shape.has(row)) throw new Error(`第 ${row} 行整条不见了（缺行）`)
    /** 每一行原有的列一个都不能少（只有一边有值的格子被清空时最容易"挖掉列"） */
    for (const [row, cols] of shapeBefore) {
      if (row < sheet.dataStart || row > last) continue
      const now = shape.get(row) ?? new Set()
      const lost = [...cols].filter(c => !now.has(c))
      if (lost.length) throw new Error(`第 ${row} 行少了 ${lost.join("、")} 列（出现空格）`)
    }
    /** 摆过人的那几行，一行都不许空着（空行 = 人不知去向） */
    const empty = filled.map(row => ({ row, nick: nickAt(after1, row) })).filter(x => !x.nick)
    if (empty.length) throw new Error(`排队区出现了空行：第 ${empty.map(x => x.row).join("、")} 行`)
  })

  await check("挪行之后：排队区序号仍是 1..N（A 列缓存值逐行没动）", () => {
    const seqAfter = sheetOf(after1).rows.map(r => String(r.seq))
    if (JSON.stringify(seqAfter) !== JSON.stringify(seqBefore))
      throw new Error(`序号变了：${JSON.stringify(seqBefore)} → ${JSON.stringify(seqAfter)}`)
    if (!seqAfter.every((s, i) => s === String(i + 1))) throw new Error(`序号不是 1..N：${JSON.stringify(seqAfter)}`)
  })

  await check("挪行之后：内容逐行一致（只是顺序变了，一个字段都没丢）", () => {
    const lineOf = r => JSON.stringify([r.nickname, r.gameName, r.anchor, r.goal, r.strength, r.note, r.status])
    /** 每个人那一整行（昵称 → 其余各列）挪前挪后必须逐字相同（完成情况那格被锁过，以锁后的基线为准） */
    const base = new Map(sheetOf(beforeLocked).rows.map(r => [r.nickname, lineOf(r)]))
    const now = new Map(sheetOf(after1).rows.map(r => [r.nickname, lineOf(r)]))
    if (base.size !== now.size) throw new Error(`人数变了：${base.size} → ${now.size}`)
    for (const [nick, line] of base)
      if (now.get(nick) !== line) throw new Error(`「${nick}」那一行的内容变了：\n前 ${line}\n后 ${now.get(nick)}`)
    /** 除了被挪的那两位，其余行按行号逐个相同 */
    const beforeAt = new Map(sheetOf(beforeLocked).rows.map(r => [r.row, JSON.stringify(r)]))
    const afterAt = new Map(sheetOf(after1).rows.map(r => [r.row, JSON.stringify(r)]))
    for (const row of [rA, rB, rE]) if (beforeAt.get(row) !== afterAt.get(row)) throw new Error(`不该被动的第 ${row} 行变了`)
  })

  await check("挪行之后：绑定与锁的行号跟搬（锁上记的人与那一行现在的人仍然对得上）", () => {
    /**
     * 判据：**界面上哪一行显示谁** → 那个人的绑定就在那一行、锁也在那一行（锁上记的昵称与那一行一致）。
     *
     * 不写死"丁在第几行"：这一步的意义是"界面看到的人 ↔ 绑定/锁指向的人"一致，
     * 而不是某个具体行号——写死行号的话，将来挪行的实现一改（或先挪别人一次），这里就会误报。
     * 位置上真正要钉的两条单独写：这次挪动**确实往前了**、而且**恰好越过一位**。
     */
    const rowNum = people[rD].qq in binds1 ? Number(binds1[people[rD].qq].row) : 0
    if (!rowNum) throw new Error(`丁没有绑定了：${JSON.stringify(binds1)}`)
    if (!(rowNum < rD)) throw new Error(`丁没有往前挪：第 ${rD} 行 → 第 ${rowNum} 行`)
    if (nickAt(after1, rowNum) !== people[rD].nick) throw new Error(`第 ${rowNum} 行不是丁：${nickAt(after1, rowNum)}`)
    if (Number(binds1[people[rC].qq]?.row) !== rD) throw new Error(`丙的绑定没跟搬：${JSON.stringify(binds1[people[rC].qq])}`)
    if (nickAt(after1, rD) !== people[rC].nick) throw new Error(`第 ${rD} 行不是丙：${nickAt(after1, rD)}`)

    /** 每个人：界面显示谁，绑定就该指向谁（5 个人一个不落） */
    const rowByNick = new Map(sheetOf(after1).rows.map(r => [r.nickname, r.row]))
    for (const [row, p] of Object.entries(people)) {
      void row
      const got = Number(binds1[p.qq]?.row)
      if (got !== rowByNick.get(p.nick)) throw new Error(`「${p.nick}」的绑定指向第 ${got} 行，界面在第 ${rowByNick.get(p.nick)} 行`)
    }

    /** 丙的完成情况锁跟着丙走到 rD；被锁的那一格内容不变 */
    if (String(locks1[`${SHEET}#${rD}`]?.nickname ?? "") !== people[rC].nick)
      throw new Error(`锁没跟着丙走：${JSON.stringify(locks1)}`)
    /** 锁一把都没多、一把都没少（挪行只是把行号换掉，不该凭空多出/丢掉锁） */
    const lockCountBefore = Object.keys(JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows ?? {}).length
    if (Object.keys(locks1).length !== lockCountBefore)
      throw new Error(`锁的条数变了：${lockCountBefore} → ${Object.keys(locks1).length}：${JSON.stringify(locks1)}`)
    if (String(rowOf(after1, rD)?.status ?? "") !== QUEUED) throw new Error(`丙那一行的完成情况变了：${rowOf(after1, rD)?.status}`)
    /** 丁自己打开页面时，拿到的就是新位置那一行 */
    if (mineDing.perm.role !== "self") throw new Error(`丁的身份不对：${JSON.stringify(mineDing.perm)}`)
    if (Number(rowOf(mineDing, rowNum)?.row) !== rowNum)
      throw new Error(`丁自己打开页面时拿不到新位置那一行：${JSON.stringify(sheetOf(mineDing).rows)}`)
  })

  await check("再来一次：把「乙」挪到第一位（相邻两行也要换得动）", async () => {
    const out = await move({ sheet: SHEET, row: rB, mode: "before-last-queued" }, OWNER)
    if (out.status !== 200 || out.json.moved !== true) throw new Error(`相邻行没挪动：${out.status} ${JSON.stringify(out.json)}`)
    if (Number(out.json.to) !== rA) throw new Error(`没挪到第一位：${JSON.stringify(out.json)}`)
    const after = await load(OWNER)
    if (nickAt(after, rA) !== people[rB].nick) throw new Error(`第一位现在是「${nickAt(after, rA)}」`)
    if (nickAt(after, rB) !== people[rA].nick) throw new Error(`第二位现在是「${nickAt(after, rB)}」`)
    /** 行号轴与序号照旧 */
    const seqAfter = sheetOf(after).rows.map(r => String(r.seq))
    if (JSON.stringify(seqAfter) !== JSON.stringify(seqBefore)) throw new Error(`相邻互换把序号弄乱了：${JSON.stringify(seqAfter)}`)
  })

  /* ------------------------- ② 挪不动 / 拒绝：整表不动 ------------------------- */

  await check("前面没有「排队中」的人：原样回话、一个字节都不写", async () => {
    const after = await load(OWNER)
    const first = sheetOf(after).rows.find(r => String(r.status).trim() === QUEUED)
    const versionAt = await version()
    const out = await move({ sheet: SHEET, row: first.row, mode: "before-last-queued" }, OWNER)
    if (out.status !== 200 || out.json.ok !== true) throw new Error(`HTTP ${out.status} ${JSON.stringify(out.json)}`)
    if (out.json.moved !== false) throw new Error(`最前面那一行不该挪动：${JSON.stringify(out.json)}`)
    if (!String(out.json.reason ?? "").includes(QUEUED)) throw new Error(`没说清为什么没动：${JSON.stringify(out.json)}`)
    if ((await version()) !== versionAt) throw new Error("被拒的插队却改动了表")
  })

  await check("「等待开启」的人不能插队（不是排队中）：回 400 且表不动", async () => {
    const versionAt = await version()
    const out = await move({ sheet: SHEET, row: rE, mode: "before-last-queued" }, OWNER)
    if (out.status !== 400) throw new Error(`HTTP ${out.status} ${JSON.stringify(out.json)}`)
    if (!String(out.json.error ?? "").includes(QUEUED)) throw new Error(`报错没点明状态：${JSON.stringify(out.json)}`)
    if ((await version()) !== versionAt) throw new Error("被拒的插队却改动了表")
  })

  await check("行号不对 / 模式不对：400，且表不动", async () => {
    const versionAt = await version()
    for (const body of [
      { sheet: SHEET, row: 99999, mode: "before-last-queued" },
      { sheet: SHEET, row: rC, mode: "somewhere" },
      { sheet: "不存在的榜", row: rC, mode: "before-last-queued" },
    ]) {
      const out = await move(body, OWNER)
      if (out.status !== 400) throw new Error(`${JSON.stringify(body)} 应当 400，实际 ${out.status} ${JSON.stringify(out.json)}`)
      if (!out.json.error) throw new Error(`400 却没给原因：${JSON.stringify(out.json)}`)
    }
    if ((await version()) !== versionAt) throw new Error("被拒的插队却改动了表")
  })

  await check("权限：本人（有签名身份）与访客（只有口令）一律 403", async () => {
    const outMember = await move({ sheet: SHEET, row: rC, mode: "before-last-queued" }, people[rD].qq)
    if (outMember.status !== 403) throw new Error(`本人应当 403，实际 ${outMember.status} ${JSON.stringify(outMember.json)}`)
    /** 访客 = 没有身份签名（只有口令） */
    const outGuest = await editor.request("/api/move-row", {
      body: { sheet: SHEET, row: rC, mode: "before-last-queued" },
      cookies: false,
    })
    if (outGuest.status !== 403) throw new Error(`访客应当 403，实际 ${outGuest.status} ${JSON.stringify(outGuest.json)}`)
    /** 反面证据：白名单管理员与主人都进得去（上面两条用例已经成功，这里再确认角色判定不是"谁都被拒"） */
    const admin = await load(ADMIN)
    if (admin.perm.role !== "admin") throw new Error(`白名单管理员的角色不对：${JSON.stringify(admin.perm)}`)
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
