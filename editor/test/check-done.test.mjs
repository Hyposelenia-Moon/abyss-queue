/**
 * 清榜前核查写状态接口：
 * - 只把仍排队、昵称对得上的行改成该行群昵称；
 * - 等待/已完成/昵称不符不动；
 * - 版本过期整批 409，不覆盖别人。
 */
import fs from "node:fs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("清榜前核查写状态")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过清榜核查套件`)
  process.exit(0)
}

const ws = makeWorkspace("check-done")
const TOKEN = "check-done-token"
const SIGN_KEY = "check-done-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const SHEET = "幽境危战"
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

const { Table } = await shared("model/table.js")
const table = new Table({ file: ws.fixture, backup: false })
const model = await table.read(({ models }) => models.get(SHEET))
const ds = model.dataStart
const people = [
  ["排队甲", "排队中"],
  ["等待乙", "等待开启"],
  ["完成丙", "完成丙"],
]
await table.mutate(ctx => {
  people.forEach(([nick, status], i) => {
    ctx.setCell(SHEET, ds + i, "nickname", nick)
    ctx.setCell(SHEET, ds + i, "gameName", `${nick}游戏`)
    ctx.setCell(SHEET, ds + i, "anchor", "都可以")
    ctx.setCell(SHEET, ds + i, "goal", model.options.goal[0])
    ctx.setCell(SHEET, ds + i, "strength", "中配")
    ctx.setCell(SHEET, ds + i, "status", status)
  })
})

let editor = null
try {
  editor = await startEditor({
    label: "check-done",
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
  const version = async () => (await editor.request("/api/version", { who: OWNER })).json.version
  const rows = async () => (await editor.request("/api/data", { who: OWNER })).json.sheets.find(s => s.name === SHEET).rows

  await check("只改仍排队且昵称对得上的行", async () => {
    const v = await version()
    const out = await editor.request("/api/check-done", {
      who: OWNER,
      body: {
        sheet: SHEET,
        version: v,
        rows: [
          { row: ds, nickname: "排队甲" },
          { row: ds + 1, nickname: "等待乙" },
          { row: ds + 2, nickname: "完成丙" },
          { row: ds, nickname: "别人的名字" },
        ],
      },
    })
    if (!out.json.ok) throw new Error(out.json.error || "写状态失败")
    if (out.json.updated !== 1) throw new Error(`应只改 1 行：${JSON.stringify(out.json)}`)
    const got = await rows()
    const byNick = Object.fromEntries(got.map(r => [r.nickname, r.status]))
    if (byNick["排队甲"] !== "排队甲") throw new Error(`排队甲没落成群昵称：${JSON.stringify(byNick)}`)
    if (byNick["等待乙"] !== "等待开启") throw new Error(`等待乙被改了：${JSON.stringify(byNick)}`)
    if (byNick["完成丙"] !== "完成丙") throw new Error(`完成丙被改了：${JSON.stringify(byNick)}`)
  })

  await check("版本过期：409，整批不落表", async () => {
    const old = await version()
    await table.mutate(ctx => {
      ctx.setCell(SHEET, ds, "note", "别人刚改过")
    })
    const out = await editor.request("/api/check-done", {
      who: OWNER,
      body: { sheet: SHEET, version: old, rows: [{ row: ds, nickname: "排队甲" }] },
    })
    if (out.status !== 409 || !out.json.conflict) throw new Error(`过期版本没有 409：${out.status} ${JSON.stringify(out.json)}`)
  })
} finally {
  await editor?.stop()
}

await finish()
