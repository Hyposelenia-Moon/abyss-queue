/**
 * 群昵称变更 → 「帮帮完成情况」里记着旧昵称的 token 跟着换（三条路径，走真实接口）
 *
 * 这一列存的是**人**（主播名，或点「本人已完成」落成的该行群昵称），逗号分隔多值；
 * 群昵称改了而这里没跟着改，表里就留下一个查无此人的名字。三条路都要覆盖：
 *   ① 成员自己在编辑器里改（`/api/save`，本人身份）
 *   ② 管理员改某一行（`/api/save`，白名单身份；这一行的主人是别人）
 *   ③ 群名单同步改名（`POST /api/roster`，机器人身份）
 * 两个方向都要断言：**旧名变成新名**，以及**别人 / 主播名 / 固定状态词一个字不动**。
 *
 * 还有两条"宁可不动"：榜里有两行同名时整榜不动（只在日志里说明）、
 * 这一行没有可依据的 QQ 绑定时只动它本人那一格。
 *
 * 用仓库里的空模板起步，不依赖真实表格。
 */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("昵称变更同步完成情况（HTTP）")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过昵称变更套件`)
  process.exit(0)
}

const ws = makeWorkspace("status-rename")
const TOKEN = "status-rename-token"
const SIGN_KEY = "status-rename-sign-key"
const OWNER = { qq: "1000000001", nick: "主人" }
const BOT = { qq: "0", nick: "群成员名单" }
/** 三位群友（甲的名字是乙/丙那些名字的前缀，用来看住"别做子串替换"） */
const JIA = { qq: "30001", nick: "甲旧名" }
const YI = { qq: "30002", nick: "乙名" }
const BING = { qq: "30003", nick: "甲旧名后缀" }
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

const SHEET = "幽境危战"

let editor = null
try {
  editor = await startEditor({
    label: "昵称变更",
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
  const R1 = sheet.dataStart
  const R2 = R1 + 1
  const R3 = R1 + 2
  const R4 = R1 + 3
  const R5 = R1 + 4
  const R6 = R1 + 5
  if (R6 > sheet.dataEnd) throw new Error(`空模板行数不够（dataEnd=${sheet.dataEnd}），套件需要调整`)
  const opts = sheet.options ?? {}
  const anchor = (opts.anchor ?? [])[0] ?? "都可以"
  const goal = (opts.goal ?? [])[0] ?? "N5"

  const rowsOf = async (who = OWNER) => (await editor.request("/api/data", { who })).json.sheets.find(s => s.name === SHEET).rows
  const rowAt = async (row, who = OWNER) => (await rowsOf(who)).find(x => x.row === row)
  const save = (who, rows) => editor.request("/api/save", { who, body: { sheet: SHEET, rows } })
  /** 推一份群成员名单（机器人身份） */
  const pushRoster = members => editor.request("/api/roster", { who: BOT, body: { group: "999888", members } })

  /* -------------------- 准备：三个人各建一行，各绑到自己名下 -------------------- */
  await check("准备：三位群友各建一行（按 QQ 绑定）", async () => {
    const made = [
      [BING, R3, "甲旧名后缀", "游戏丙"],
      [YI, R2, "乙名", "游戏乙"],
      [JIA, R1, "甲旧名", "游戏甲"],
    ]
    for (const [who, row, nickname, gameName] of made) {
      const out = await save(who, [{ row, values: { nickname, gameName, anchor, goal } }])
      if (!out.json.ok) throw new Error(`${nickname} 建行失败：${out.json.error}`)
    }
    /** 完成情况里写上"谁完成的"：甲自己、甲+乙、丙自己（都必须是 0 行还没有的昵称之外的值，见 validateRows） */
    const setStatus = [
      [JIA, R1, "甲旧名"],
      [YI, R2, "甲旧名,乙名,甲旧名后缀"],
      [BING, R3, "甲旧名后缀"],
    ]
    for (const [who, row, status] of setStatus) {
      const out = await save(who, [{ row, values: { status } }])
      if (!out.json.ok) throw new Error(`第 ${row} 行写完成情况失败：${out.json.error}`)
    }
  })

  /* -------------------- ① 成员自己保存改名 -------------------- */
  await check("① 本人改名：本人那一格与「别人那一行」里记着他的 token 都换成新名", async () => {
    const out = await save(JIA, [{ row: R1, values: { nickname: "甲新名" } }])
    if (!out.json.ok) throw new Error(out.json.error)
    const r1 = await rowAt(R1)
    const r2 = await rowAt(R2)
    if (r1.nickname !== "甲新名") throw new Error(`表里昵称没改：${r1.nickname}`)
    if (r1.status !== "甲新名") throw new Error(`本人那一格没跟着改：${r1.status}`)
    if (r2.status !== "甲新名,乙名,甲旧名后缀") throw new Error(`别人那一行没跟着改（或改坏了）：${r2.status}`)
  })

  await check("① 不误伤：前缀相同的别人的名字（甲旧名后缀）一个字没动", async () => {
    const r3 = await rowAt(R3)
    if (r3.status !== "甲旧名后缀") throw new Error(`被当子串替换了：${r3.status}`)
    if (r3.nickname !== "甲旧名后缀") throw new Error(`别人那一行的昵称被动过：${r3.nickname}`)
  })

  /* -------------------- ② 管理员改某行昵称 -------------------- */
  await check("② 管理员改名：旧名换成新名（含别人那一行里的 token）", async () => {
    /** 丙的绑定在改名之后会被"昵称对不上"清掉，所以归属要在这一轮之前就已经在（下面 ⑤ 会用到这一点） */
    const out = await save(OWNER, [{ row: R3, values: { nickname: "丙新名" } }])
    if (!out.json.ok) throw new Error(out.json.error)
    const r3 = await rowAt(R3)
    const r2 = await rowAt(R2)
    if (r3.nickname !== "丙新名") throw new Error(`表里昵称没改：${r3.nickname}`)
    if (r3.status !== "丙新名") throw new Error(`本人那一格没跟着改：${r3.status}`)
    if (r2.status !== "甲新名,乙名,丙新名") throw new Error(`别人那一行没跟着改（或改坏了）：${r2.status}`)
  })

  await check("② 不误伤：别人的名字与已经改好的新名都没动", async () => {
    const r1 = await rowAt(R1)
    if (r1.status !== "甲新名") throw new Error(`甲那一格被动过：${r1.status}`)
    const r2 = await rowAt(R2)
    if (!r2.status.includes("乙名")) throw new Error(`乙的名字被动了：${r2.status}`)
  })

  /* -------------------- ③ 群名单同步改名 -------------------- */
  await check("③ 群名单改名：旧名换成新名（含别人那一行里的 token）", async () => {
    const out = await pushRoster([
      { qq: JIA.qq, nick: "甲新名" },
      { qq: YI.qq, nick: "乙新名" },
    ])
    if (!out.json.ok) throw new Error(out.json.error)
    if (out.json.renamed !== 1) throw new Error(`改名行数不对：${JSON.stringify(out.json)}`)
    const r2 = await rowAt(R2)
    if (r2.nickname !== "乙新名") throw new Error(`表里昵称没改：${r2.nickname}`)
    if (r2.status !== "甲新名,乙新名,丙新名") throw new Error(`完成情况没跟着改：${r2.status}`)
  })

  await check("③ 不误伤：别的行与主播名没动", async () => {
    const r1 = await rowAt(R1)
    const r3 = await rowAt(R3)
    if (r1.status !== "甲新名") throw new Error(`甲那一格被动过：${r1.status}`)
    if (r3.status !== "丙新名") throw new Error(`丙那一格被动过：${r3.status}`)
  })

  await check("③′ 本人打开页面时按新名片同步（syncIdentity）：完成情况一起改", async () => {
    /** 甲又改了一次名片，链接身份里带的正是新名片（`locateSelf` 会报 `renamedFrom`） */
    const data = await editor.request("/api/data", { who: { qq: JIA.qq, nick: "甲再改" } })
    if (data.status !== 200 || !Array.isArray(data.json.sheets)) throw new Error(JSON.stringify(data.json).slice(0, 300))
    if (data.json.sync?.renamed !== 1) throw new Error(`没按名片同步：${JSON.stringify(data.json.sync)}`)
    const r1 = await rowAt(R1)
    if (r1.nickname !== "甲再改") throw new Error(`表里昵称没跟着名片改：${r1.nickname}`)
    if (r1.status !== "甲再改") throw new Error(`完成情况没跟着改：${r1.status}`)
  })

  /* -------------------- ④ 榜里有两行同名：整榜不动，只说明 -------------------- */
  await check("④ 有两行同名：完成情况一个字不动，并在日志里说明", async () => {
    /** 人工改表就能造出重名（编辑器自己的保存会拒），这正是"分不清这一格写的是哪一位"那种场景 */
    const { Table } = await shared("model/table.js")
    await new Table({ file: ws.fixture, backup: false }).mutate(ctx => ctx.setCell(SHEET, R3, "nickname", "乙新名"))

    const mark = editor.log().length
    const out = await pushRoster([
      { qq: JIA.qq, nick: "甲再改" },
      { qq: YI.qq, nick: "乙再改" },
    ])
    if (!out.json.ok) throw new Error(out.json.error)
    const r2 = await rowAt(R2)
    if (r2.status !== "甲再改,乙新名,丙新名") throw new Error(`重名时不该改完成情况：${r2.status}`)
    const logged = editor.log().slice(mark)
    if (!/分不清完成情况里写的是哪一位/.test(logged)) throw new Error(`没在日志里说明：\n${logged}`)
  })

  /* -------------------- ⑤ 这一行没有可依据的绑定：只动本人那一格 -------------------- */
  await check("⑤ 没有绑定：只改本人那一格，别的行里同样的名字不动、并在回执里说明", async () => {
    /** 主人新建一行（主人身份不会建绑定），另把"无主旧名"先写进乙那一行的完成情况 */
    const made = await save(OWNER, [{ row: R4, values: { nickname: "无主旧名", gameName: "游戏丁", anchor, goal } }])
    if (!made.json.ok) throw new Error(made.json.error)
    const pretag = await save(OWNER, [{ row: R2, values: { status: "甲再改,乙新名,丙新名,无主旧名" } }])
    if (!pretag.json.ok) throw new Error(pretag.json.error)

    const out = await save(OWNER, [{ row: R4, values: { nickname: "无主新名", status: "无主旧名" } }])
    if (!out.json.ok) throw new Error(out.json.error)
    const notices = JSON.stringify(out.json.notices ?? [])
    if (!/没有可依据的 QQ 绑定/.test(notices)) throw new Error(`回执里没说明：${notices}`)
    const r4 = await rowAt(R4)
    if (r4.status !== "无主新名") throw new Error(`本人那一格没跟着改：${r4.status}`)
    const r2 = await rowAt(R2)
    if (r2.status !== "甲再改,乙新名,丙新名,无主旧名") throw new Error(`没有绑定时不该动别人的行：${r2.status}`)
  })

  /* -------------------- ⑥ 群昵称本身就是状态词：不动（那是状态，不是人） -------------------- */
  await check("⑥ 旧昵称是固定状态词：完成情况里的那个字面值不动", async () => {
    const made = await save(OWNER, [{ row: R5, values: { nickname: "排队中", gameName: "游戏戊", anchor, goal, status: "排队中" } }])
    if (!made.json.ok) throw new Error(made.json.error)
    const out = await save(OWNER, [{ row: R5, values: { nickname: "改过名的排队中" } }])
    if (!out.json.ok) throw new Error(out.json.error)
    const r5 = await rowAt(R5)
    if (r5.nickname !== "改过名的排队中") throw new Error(`表里昵称没改：${r5.nickname}`)
    if (r5.status !== "排队中") throw new Error(`把状态词当成人改了：${r5.status}`)
  })

  /* -------------------- ⑦ 旧昵称就是主播名：不动（那是主播，不是这位群友） -------------------- */
  await check(
    "⑦ 旧昵称是主播名：完成情况里的那个 token 不动",
    async () => {
      const made = await save(OWNER, [{ row: R6, values: { nickname: anchor, gameName: "游戏己", anchor, goal, status: anchor } }])
      if (!made.json.ok) throw new Error(made.json.error)
      const out = await save(OWNER, [{ row: R6, values: { nickname: "换过名字的行" } }])
      if (!out.json.ok) throw new Error(out.json.error)
      const r6 = await rowAt(R6)
      if (r6.nickname !== "换过名字的行") throw new Error(`表里昵称没改：${r6.nickname}`)
      if (r6.status !== anchor) throw new Error(`把主播名当成人改了：${r6.status}`)
    },
    /** 模板里没有主播区时这一条没得验：明确报"没验到"，不当成通过 */
    (opts.anchor ?? []).length ? "" : "空模板里没有主播名可用",
  )
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
