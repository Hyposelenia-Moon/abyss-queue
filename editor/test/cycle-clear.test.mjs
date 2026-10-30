/**
 * 周期清榜的服务端幂等与空状态兼容
 *
 * - 同一 eventKey 第二次调用必须 skipped，不能把第一次清榜后新报名的人再删一次；
 * - queued-done 要把**空状态**旧排队记录一起清掉，但保留「等待开启」并翻成排队中。
 */
import fs from "node:fs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("周期清榜幂等")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过周期清榜套件`)
  process.exit(0)
}

const ws = makeWorkspace("cycle-clear")
const TOKEN = "cycle-clear-token"
const SIGN_KEY = "cycle-clear-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const KEY = "幽境危战:clear:test-round"
const SHEET = "幽境危战"
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

const { Table } = await shared("model/table.js")
const table = new Table({ file: ws.fixture, backup: false })
const model = await table.read(({ models }) => models.get(SHEET))
const ds = model.dataStart
const seed = rows =>
  table.mutate(ctx => {
    rows.forEach(([nick, status], i) => {
      ctx.setCell(SHEET, ds + i, "nickname", nick)
      ctx.setCell(SHEET, ds + i, "gameName", `${nick}游戏`)
      ctx.setCell(SHEET, ds + i, "anchor", "都可以")
      ctx.setCell(SHEET, ds + i, "goal", model.options.goal[0])
      ctx.setCell(SHEET, ds + i, "strength", "中配")
      ctx.setCell(SHEET, ds + i, "status", status)
    })
  })
await seed([
  ["空状态", ""],
  ["排队", "排队中"],
  ["等待", "等待开启"],
  ["完成", "本人已完成"],
])

let editor = null
try {
  editor = await startEditor({
    label: "cycle-clear",
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

  const sheetNow = async () =>
    (await editor.request("/api/data", { who: OWNER })).json.sheets.find(s => s.name === SHEET).rows
  const currentVersion = async () => (await editor.request("/api/version", { who: OWNER })).json.version

  await check("第一次清榜：空状态/排队/完成被清，等待保留并翻排队中", async () => {
    const out = await editor.request("/api/cycle", {
      who: OWNER,
      body: {
        sheet: SHEET,
        mode: "queued-done",
        promote: "all",
        eventKey: KEY,
        version: await currentVersion(),
      },
    })
    if (!out.json.ok) throw new Error(out.json.error || "清榜失败")
    if (out.json.cleared !== 3) throw new Error(`应清 3 行，实际 ${out.json.cleared}`)
    if (out.json.promoted !== 1) throw new Error(`应翻 1 行，实际 ${out.json.promoted}`)
    const rows = await sheetNow()
    if (rows.length !== 1 || rows[0].nickname !== "等待" || rows[0].status !== "排队中")
      throw new Error(`等待行没有保留并翻排队中：${JSON.stringify(rows)}`)
  })

  await check("同一 eventKey 第二次：skipped，不清掉清榜后新报名", async () => {
    await seed([["新报名", "排队中"]])
    const out = await editor.request("/api/cycle", {
      who: OWNER,
      body: {
        sheet: SHEET,
        mode: "queued-done",
        promote: "all",
        eventKey: KEY,
        version: await currentVersion(),
      },
    })
    if (!out.json.ok || !out.json.skipped) throw new Error(`第二次没有 skipped：${JSON.stringify(out.json)}`)
    const rows = await sheetNow()
    if (!rows.some(r => r.nickname === "新报名")) throw new Error(`新报名被第二次清掉了：${JSON.stringify(rows)}`)
  })

  await check("归档版本过期：409 且不清表，intent 撤销", async () => {
    const oldVersion = await currentVersion()
    await seed([["版本冲突", "排队中"]])
    const out = await editor.request("/api/cycle", {
      who: OWNER,
      body: {
        sheet: SHEET,
        mode: "queued-done",
        promote: "all",
        eventKey: "幽境危战:clear:stale-version",
        version: oldVersion,
      },
    })
    if (out.status !== 409 || !out.json.conflict) throw new Error(`过期版本没有 409：${out.status} ${JSON.stringify(out.json)}`)
    const rows = await sheetNow()
    if (!rows.some(r => r.nickname === "版本冲突")) throw new Error(`版本冲突仍清了表：${JSON.stringify(rows)}`)
    const status = await editor.request("/api/cycle/status?eventKey=幽境危战%3Aclear%3Astale-version", { who: OWNER })
    if (status.json.pending) throw new Error(`写前冲突没有撤销 intent：${JSON.stringify(status.json)}`)
  })

  await check("status 查询同一 eventKey 返回 done，协议为 2", async () => {
    const out = await editor.request(`/api/cycle/status?eventKey=${encodeURIComponent(KEY)}`, { who: OWNER })
    if (!out.json.done) throw new Error(`status 没记 done：${JSON.stringify(out.json)}`)
    if (out.json.protocol !== 2) throw new Error(`status 协议不是 2：${JSON.stringify(out.json)}`)
  })
} finally {
  await editor?.stop()
}

await finish()
