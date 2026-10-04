/**
 * 行归属：同名的两个 QQ 之间不许互相认领（AQ-02，走真实接口）
 *
 * 纯逻辑那一份在 test/locate-self.test.mjs；这里把同样的场景走一遍真接口，
 * 证明"读"和"写"两条路都拦住了：
 *   - 甲占住第 R 行之后，与甲同名的乙打开页面**拿不到**那一行（也不该拿来当"自己的行"去改）
 *   - 乙仍然可以在别的空行正常报名（拦的是越权，不是不让人排队）
 *   - 两人各自的绑定互不串行
 *
 * 用仓库里的空模板起步，不依赖真实表格。
 */
import fs from "node:fs"
import path from "node:path"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("同名者的行归属（HTTP）")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过行归属套件`)
  process.exit(0)
}

const ws = makeWorkspace("row-ownership")
const TOKEN = "row-own-token"
const SIGN_KEY = "row-own-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
/** 两个**不同 QQ**用同一个群昵称：这就是 AQ-02 的入口 */
const NICK = "同名者"
const A = { qq: "20001", nick: NICK }
const B = { qq: "20002", nick: NICK }
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

const SHEET = "幽境危战"
const bindsOf = () => JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8"))?.binds?.[SHEET] ?? {}

let editor = null
try {
  editor = await startEditor({
    label: "同名行归属",
    ports: [7816, 7824, 7825],
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
  const rowA = sheet.dataStart
  const rowB = sheet.dataStart + 1
  const opts = sheet.options ?? {}
  const anchor = (opts.anchor ?? [])[0] ?? "都可以"
  const goal = (opts.goal ?? [])[0] ?? "N5"

  const rowsFor = async who => {
    const r = await editor.request("/api/data", { who })
    return r.json.sheets.find(s => s.name === SHEET).rows
  }

  await check("准备：甲（QQ 20001）先占住第一行", async () => {
    const saved = await editor.request("/api/save", {
      who: A,
      body: { sheet: SHEET, rows: [{ row: rowA, values: { nickname: NICK, gameName: "游戏甲", anchor, goal } }] },
    })
    if (!saved.json.ok) throw new Error(saved.json.error || "报名失败")
    const mine = await rowsFor(A)
    if (!mine.some(r => r.row === rowA)) throw new Error(`甲没拿到自己那一行：${JSON.stringify(mine)}`)
  })

  await check("同名的乙（QQ 20002）：打不开页面也拿不到甲那一行", async () => {
    const mine = await rowsFor(B)
    if (mine.some(r => r.row === rowA)) throw new Error(`拿到了甲绑定的第 ${rowA} 行：${JSON.stringify(mine)}`)
    if (mine.length) throw new Error(`乙本该一行都没有：${JSON.stringify(mine)}`)
  })

  await check("同名的乙：直接提交甲那一行也会被拒（不是只靠前端不发）", async () => {
    const saved = await editor.request("/api/save", {
      who: B,
      body: { sheet: SHEET, rows: [{ row: rowA, values: { nickname: NICK, gameName: "抢来的", anchor, goal } }] },
    })
    if (saved.json.ok) throw new Error("竟然改成功了")
    if (!String(saved.json.error).includes("只能改自己那一行")) throw new Error(saved.json.error)
    const now = await rowsFor(OWNER)
    const got = now.find(r => r.row === rowA)
    if (got?.gameName !== "游戏甲") throw new Error(`甲那一行被改了：${JSON.stringify(got)}`)
  })

  await check("同名的乙：拿重复昵称再排一行会被业务规则拒绝，甲那一行不受影响", async () => {
    /** 表里已经有「同名者」了，同昵称的第二行会被既有业务规则拒绝——不是本次修复引入的 */
    const dup = await editor.request("/api/save", {
      who: B,
      body: { sheet: SHEET, rows: [{ row: rowB, values: { nickname: NICK, gameName: "游戏乙", anchor, goal } }] },
    })
    if (dup.json.ok) throw new Error("重名竟然写进去了")
    if (!/重复|不是你的记录/.test(String(dup.json.error))) throw new Error(dup.json.error)
    const now = await rowsFor(OWNER)
    if (now.find(r => r.row === rowA)?.gameName !== "游戏甲") throw new Error(`甲那一行被改了：${JSON.stringify(now)}`)
  })

  await check("身份里没有群名片（云端没收到群名单）：照样能新建一行，建完就绑给自己", async () => {
    /**
     * 现场问题：短链展开出来的身份 `n` 是空的（云端 roster=0），
     * 新建行被 "新行还必须昵称对得上" 判成 `第 8 行不是你的记录，只能改自己那一行`。
     * 空行本来没有主人，谁建都行；建完必须落到这个 QQ 名下，第二次改才不需要再靠"新行"。
     */
    const D = { qq: "20004", nick: "" }
    const rowD = rowB + 1
    if (rowD > sheet.dataEnd) throw new Error(`空模板行数不够（dataEnd=${sheet.dataEnd}），套件需要调整`)
    const save = values =>
      editor.request("/api/save", { who: D, body: { sheet: SHEET, rows: [{ row: rowD, values: { anchor, goal, ...values } }] } })
    const first = await save({ nickname: "没名片的人", gameName: "游戏丁" })
    if (!first.json.ok) throw new Error(`空群名片建新行被拒了：${first.json.error}`)
    const mine = await rowsFor(D)
    if (!mine.some(r => r.row === rowD)) throw new Error(`新建的行没绑给自己：${JSON.stringify(mine)}`)
    const again = await save({ nickname: "没名片的人", gameName: "游戏丁改" })
    if (!again.json.ok) throw new Error(`第二次改自己新建的那一行又被拒了：${again.json.error}`)
    const now = await rowsFor(D)
    if (now.find(r => r.row === rowD)?.gameName !== "游戏丁改") throw new Error(`第二次没写进去：${JSON.stringify(now)}`)
  })

  await check("重名状态下：甲照旧认自己那一行，同名的乙谁的行都拿不到（归属不明时不自动认领）", async () => {
    /** 人工维护的表里完全可能出现两个同名行——这时昵称兜底最容易认错人 */
    const { Table } = await shared("model/table.js")
    const table = new Table({ file: ws.fixture, backup: false })
    await table.mutate(ctx => ctx.setCell(SHEET, rowB, "nickname", NICK))
    const a = await rowsFor(A)
    if (a.length !== 1 || a[0].row !== rowA) throw new Error(`甲的行被重名搅乱了：${JSON.stringify(a)}`)
    const b = await rowsFor(B)
    if (b.length) throw new Error(`同名且归属不明时不该自动认领：${JSON.stringify(b)}`)
    /** 第三个 QQ 用同一个昵称：谁都别想认领 */
    const C = { qq: "20003", nick: NICK }
    const c = await rowsFor(C)
    if (c.length) throw new Error(`第三个同名的 QQ 竟然拿到了行：${JSON.stringify(c)}`)
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
