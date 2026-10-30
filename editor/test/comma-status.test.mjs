/**
 * 完成人昵称里带中文逗号时，点「本人已完成」落表后不能再被拆成多个不存在的选项。
 * 现场：昵称「孩子们，记得多存档$」保存报「孩子们」「记得多存档$」不在下拉选项里。
 */
import fs from "node:fs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("逗号昵称完成状态")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过逗号昵称套件`)
  process.exit(0)
}

const ws = makeWorkspace("comma-status")
const TOKEN = "comma-status-token"
const SIGN_KEY = "comma-status-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const SHEET = "幽境危战"
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

const { Table } = await shared("model/table.js")
const table = new Table({ file: ws.fixture, backup: false })
const model = await table.read(({ models }) => models.get(SHEET))
const row = model.dataStart
const nickname = "孩子们，记得多存档$"
await table.mutate(ctx => {
  ctx.setCell(SHEET, row, "nickname", nickname)
  ctx.setCell(SHEET, row, "gameName", "游戏")
  ctx.setCell(SHEET, row, "anchor", "都可以")
  ctx.setCell(SHEET, row, "goal", model.options.goal[0])
  ctx.setCell(SHEET, row, "strength", "中配")
  ctx.setCell(SHEET, row, "status", "本人已完成")
})

let editor = null
try {
  editor = await startEditor({
    label: "comma-status",
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

  await check("带中文逗号的昵称落成完成人后，保存备注不再被拆词拒绝", async () => {
    const out = await editor.request("/api/save", {
      who: OWNER,
      body: { sheet: SHEET, rows: [{ row, values: { note: "改个备注" } }] },
    })
    if (!out.json.ok) throw new Error(out.json.error || "保存失败")
    const now = (await editor.request("/api/data", { who: OWNER })).json.sheets.find(s => s.name === SHEET)
    const got = now.rows.find(r => r.row === row)
    if (String(got?.status ?? "").trim() !== nickname)
      throw new Error(`完成状态没有落成完整昵称：${JSON.stringify(got?.status)}`)
    if (String(got?.note ?? "").trim() !== "改个备注") throw new Error("备注没保存")
  })
} finally {
  await editor?.stop()
}

await finish()
