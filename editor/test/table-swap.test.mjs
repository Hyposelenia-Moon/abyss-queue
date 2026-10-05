/**
 * 整表替换：表、绑定、完成情况锁作为同一次状态转换（AQ-03）+ 替换前的结构校验（AQ-07）
 *
 * **AQ-03**：上传/回退只替换 xlsx 字节的话，旧行号会指到新表里的另一个人——
 * 成员甲原来绑在第 R 行，新表的第 R 行已经是"新成员丁"，甲一打开页面，
 * 接口就把丁的昵称改成甲（旧行号被当成"他改了名片"）。这里的验收是：
 *   换表之后甲**拿不到**那一行，表里丁的昵称原样不动，旧绑定被作废。
 *   回退到"甲还在表里"的版本时，按群昵称重新对账，甲又能拿到自己那一行。
 *
 * **AQ-07**：只比工作表名字不够——名字对得上、内容却是空表壳的文件也会被接收，
 * 于是"上传成功"但业务读出来什么都没有。这里验收：空表壳被拒（并说清缺什么）、
 * 当前文件不受影响；结构齐全的空模板允许。
 *
 * 用仓库里的空模板当起点（结构齐全、没有成员），不依赖真实表格。
 */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, openWorkbook, Table, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("整表替换与结构校验")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过整表替换套件`)
  process.exit(0)
}

const ws = makeWorkspace("table-swap")
const TOKEN = "table-swap-token"
const SIGN_KEY = "table-swap-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const MEMBER = { qq: "20001", nick: "成员甲" }
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

const SHEET = "幽境危战"
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"))
const bindOf = qq => readJson(ws.bindingsFile)?.binds?.[SHEET]?.[qq]

/** 复制一份当前表并改掉某几格的文本（模拟"主人换了一份新表"） */
const mutateCopy = async (srcFile, outFile, edits) => {
  fs.copyFileSync(srcFile, outFile)
  const table = new Table({ file: outFile, backup: false })
  await table.mutate(ctx => {
    for (const e of edits) ctx.setCell(e.sheet, e.row, e.key, e.value)
  })
  return fs.readFileSync(outFile)
}

/** 保留工作表名、把每张表的内容清成空 sheetData（结构壳：连表头都没有） */
const shellBytes = async srcFile => {
  const wb = await openWorkbook(fs.readFileSync(srcFile))
  const empty = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`
  for (const sheet of wb.sheets) wb.setSheetXml(sheet.name, empty)
  return wb.toBuffer()
}

let editor = null
try {
  editor = await startEditor({
    label: "整表替换",
    ports: [7813, 7818, 7819],
    token: TOKEN,
    signKey: SIGN_KEY,
    adminsFile,
    args: ["--file", ws.fixture],
    env: {
      ABYSS_QUEUE_CONFIG: ws.cfg,
      ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
      /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
  })

  const payload = await editor.request("/api/data", { who: OWNER })
  const sheet = payload.json.sheets.find(s => s.name === SHEET)
  const row = sheet.dataStart
  const opts = sheet.options ?? {}
  const anchor = (opts.anchor ?? [])[0] ?? "都可以"
  const goal = (opts.goal ?? [])[0] ?? "N5"

  /** 成员甲先"首次报名"占住第 R 行：这一步会写下 QQ→行 绑定 */
  await check("准备：成员甲新增一行并记下绑定", async () => {
    const saved = await editor.request("/api/save", {
      who: MEMBER,
      body: { sheet: SHEET, rows: [{ row, values: { nickname: MEMBER.nick, gameName: "游戏甲", anchor, goal } }] },
    })
    if (!saved.json.ok) throw new Error(saved.json.error || "新增失败")
    const mine = await editor.request("/api/data", { who: MEMBER })
    const rows = mine.json.sheets.find(s => s.name === SHEET).rows
    if (!rows.some(r => r.row === row && r.nickname === MEMBER.nick)) throw new Error(`没拿到自己那一行：${JSON.stringify(rows)}`)
    const bind = bindOf(MEMBER.qq)
    if (!bind || Number(bind.row) !== row) throw new Error(`绑定不对：${JSON.stringify(bind)}`)
  })

  /** 新表：同一个行号换成了另一个人 */
  const swapped = await mutateCopy(ws.fixture, ws.file("swapped.xlsx"), [
    { sheet: SHEET, row, key: "nickname", value: "新成员丁" },
    { sheet: SHEET, row, key: "gameName", value: "游戏丁" },
  ])

  await check("换表：上传成功后绑定被重新对账（过期文件里的行号不算数）", async () => {
    const up = await editor.request("/api/upload", { who: OWNER, raw: swapped })
    if (!up.json.ok) throw new Error(up.json.error || "上传失败")
    if ((up.json.bindings?.dropped ?? 0) < 1) throw new Error(`没有作废任何绑定：${JSON.stringify(up.json.bindings)}`)
  })

  await check("换表：原绑定的人拿不到新成员那一行（AQ-03 的核心）", async () => {
    const mine = await editor.request("/api/data", { who: MEMBER })
    const rows = mine.json.sheets.find(s => s.name === SHEET).rows
    if (rows.some(r => r.row === row)) throw new Error(`仍然拿到第 ${row} 行：${JSON.stringify(rows)}`)
    if (rows.length) throw new Error(`不该拿到任何行：${JSON.stringify(rows)}`)
    if ((mine.json.sync?.renamed ?? 0) !== 0) throw new Error(`不该发生任何"改名同步"：${JSON.stringify(mine.json.sync)}`)
  })

  await check("换表：表里新成员的昵称没有被旧人覆盖", async () => {
    const now = await editor.request("/api/data", { who: OWNER })
    const got = now.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
    if (got?.nickname !== "新成员丁") throw new Error(`第 ${row} 行现在是 ${JSON.stringify(got?.nickname)}`)
    if (got?.gameName !== "游戏丁") throw new Error(`游戏名被改了：${JSON.stringify(got?.gameName)}`)
  })

  await check("换表：绑定文件里没有「原 QQ → 那一行」", async () => {
    const bind = bindOf(MEMBER.qq)
    if (bind && Number(bind.row) === row) throw new Error(`旧绑定还在：${JSON.stringify(bind)}`)
  })

  await check("回退到旧版本：按群昵称重新对账，甲又拿回自己那一行", async () => {
    const list = await editor.request("/api/versions", { who: OWNER })
    const newest = list.json.versions?.[0]
    if (!newest) throw new Error("没有可回退的版本（写表前应当自动存一份）")
    const back = await editor.request("/api/restore", { who: OWNER, body: { id: newest.id } })
    if (!back.json.ok) throw new Error(back.json.error || "回退失败")
    const mine = await editor.request("/api/data", { who: MEMBER })
    const got = mine.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
    if (got?.nickname !== MEMBER.nick) throw new Error(`回退后没拿回自己那一行：${JSON.stringify(mine.json.sheets.find(s => s.name === SHEET).rows)}`)
    const bind = bindOf(MEMBER.qq)
    if (!bind || Number(bind.row) !== row) throw new Error(`回退后没有重新绑定：${JSON.stringify(bind)}`)
  })

  await check("换表：人还在表里的那些锁要跟着走，不能因为换表就全清掉", async () => {
    /** 先让主播（管理员）锁住甲那一行的完成情况 */
    const before = (await editor.request("/api/data", { who: OWNER })).json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
    const alt = (opts.status ?? []).find(v => v !== before.status) ?? "排队中"
    const locked = await editor.request("/api/save", { who: OWNER, body: { sheet: SHEET, rows: [{ row, values: { ...before, status: alt } }] } })
    if (!locked.json.ok) throw new Error(locked.json.error || "制造锁失败")
    const lock = JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows?.[`${SHEET}#${row}`]
    if (!lock) throw new Error("主播改过完成情况后应当上锁")
    if (lock.nickname !== MEMBER.nick) throw new Error(`锁上没记下归属：${JSON.stringify(lock)}`)

    /** 换一份表：甲原样留在第 R 行，另外多一个人 —— 锁必须跟着甲走到新表的同一行 */
    const keep = await mutateCopy(ws.fixture, ws.file("keep.xlsx"), [
      { sheet: SHEET, row: row + 5, key: "nickname", value: "陪跑的人" },
      { sheet: SHEET, row: row + 5, key: "gameName", value: "陪跑游戏名" },
    ])
    const up = await editor.request("/api/upload", { who: OWNER, raw: keep })
    if (!up.json.ok) throw new Error(up.json.error || "上传失败")
    const after = JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows?.[`${SHEET}#${row}`]
    if (!after) throw new Error(`换表后锁丢了：${JSON.stringify(JSON.parse(fs.readFileSync(ws.locksFile, "utf8")).rows)}`)
    if (after.nickname !== MEMBER.nick) throw new Error(`锁跑到别人头上了：${JSON.stringify(after)}`)
    /** 锁要真的还在生效：本人改不动这一格 */
    const mine = (await editor.request("/api/data", { who: MEMBER })).json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
    const other = (opts.status ?? []).find(v => v !== mine.status) ?? (mine.status === "排队中" ? "等待开启" : "排队中")
    const blocked = await editor.request("/api/save", {
      who: MEMBER,
      body: { sheet: SHEET, rows: [{ row, values: { ...mine, status: other } }] },
    })
    if (!blocked.json.ok) throw new Error(blocked.json.error || "保存失败")
    if (!(blocked.json.ignored ?? []).some(i => i.label === "帮帮完成情况")) throw new Error("锁没生效（换表把人家的锁弄丢了）")
  })

  await check("结构校验：名字对得上、但没有表头的空壳表被拒绝，并说清缺什么（AQ-07）", async () => {
    const versionBefore = (await editor.request("/api/version")).json.version
    const up = await editor.request("/api/upload", { who: OWNER, raw: await shellBytes(ws.fixture) })
    if (up.json.ok) throw new Error("空壳表竟然上传成功了")
    const msg = String(up.json.error ?? "")
    if (!msg.includes("表头")) throw new Error(`报错没说清缺什么：${msg}`)
    if (!payload.json.sheets.some(s => msg.includes(s.name))) throw new Error(`报错没指出是哪张表：${msg}`)
    if (!msg.includes("拒绝替换")) throw new Error(`没说这是拒绝替换：${msg}`)
    const versionAfter = (await editor.request("/api/version")).json.version
    if (versionAfter !== versionBefore) throw new Error("被拒的上传却改动了当前表")
    const now = await editor.request("/api/data", { who: OWNER })
    const got = now.json.sheets.find(s => s.name === SHEET).rows.find(r => r.row === row)
    if (got?.nickname !== MEMBER.nick) throw new Error("当前表被拒绝了的上传弄坏了")
  })

  await check("结构校验：每张表都要能建出模型（有一张解析不出来就拒绝）", async () => {
    const wb = await openWorkbook(fs.readFileSync(ws.fixture))
    for (const s of wb.sheets.slice(1)) wb.setSheetXml(s.name, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`)
    const up = await editor.request("/api/upload", { who: OWNER, raw: await wb.toBuffer() })
    if (up.json.ok) throw new Error("解析不出结构的表竟然上传成功了")
  })

  await check("空模板（结构齐全、没有成员）允许上传", async () => {
    const up = await editor.request("/api/upload", { who: OWNER, raw: fs.readFileSync(TEMPLATE) })
    if (!up.json.ok) throw new Error(up.json.error || "空模板被拒了（应当允许）")
    const now = await editor.request("/api/data", { who: OWNER })
    const left = now.json.sheets.find(s => s.name === SHEET).rows
    if (left.length) throw new Error(`换成空模板后还有行：${JSON.stringify(left)}`)
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
