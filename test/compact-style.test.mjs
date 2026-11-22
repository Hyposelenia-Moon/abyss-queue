/**
 * 压紧行（删中间一行、后面的行整体上移）时的数据保全
 *
 * 存储换成 JSON 之后，逐行样式不再进状态文档（2026-11-22 的决定：导出的 xlsx 是“简单工作簿”，
 * 只保数据 + 下拉 + 序号公式，不保合并 / 样式 / 条件格式 / 超链接）。所以这里验的是搬行本身：
 *   1. 在临时副本的数据区前四行填四个人
 *   2. 推一份少一个人的群名单 → reconcileRoster 删掉那一行并压紧
 *   3. 断言数据整体上移、尾行空出来、序号公式/下拉仍在，且镜像里没有任何布局残留
 *
 * 前置：仓库里的空模板（结构齐全、没人）。全程只动临时目录里的副本，绝不碰 resources/空模板.xlsx。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { createHash } from "node:crypto"
import { createChecker } from "./_helper.mjs"
import { makeWorkspace, startEditor } from "../editor/test/harness.mjs"
import { openWorkbook, parseSheet, setCellText } from "../model/xlsx.js"
import { buildModel } from "../model/schema.js"
import { importWorkbook } from "../model/doc-import.js"
import { writeDoc, docFileOf } from "../model/queue-doc.js"

const { check, finish } = createChecker("压紧行数据保全")

const SHEET = "幻想真境剧诗"
const COLUMNS = ["B", "C", "D", "E", "F", "G"]
/** 编辑器里那 6 个可写字段（= 数据列的 key） */
const KEYS = ["nickname", "gameName", "anchor", "goal", "note", "status"]
const TOKEN = "compact-style-token"
const SIGN_KEY = "compact-style-sign-key"
/** 群名单只有机器人（ROSTER_QQ 默认 0）或主人能推；这里用机器人身份 */
const BOT = { qq: "0", nick: "群名单" }
const OWNER = { qq: "424242", nick: "主人" }
const MEMBERS = [
  { qq: "31001", nick: "压紧甲" },
  { qq: "31002", nick: "压紧乙" },
  { qq: "31003", nick: "压紧丙" },
  { qq: "31004", nick: "压紧丁" },
]

const ws = makeWorkspace("compact-style")
const fixture = ws.fixture
const statePath = docFileOf(fixture)
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

const readSheet = async () => {
  const wb = await openWorkbook(await fsp.readFile(fixture))
  const xml = await wb.sheetXml(SHEET)
  return { xml, shared: wb.shared, sheet: parseSheet(xml, wb.shared) }
}
/** 结构类要素计数（简单工作簿：只有验证与公式） */
const features = xml => ({
  conditional: xml.split("<conditionalFormatting").length - 1,
  validation: xml.split("<dataValidation ").length - 1,
  formula: xml.split("<f").length - 1,
  merge: xml.split("<mergeCell").length - 1,
  link: xml.split("<hyperlink ").length - 1,
})

/** 1) 铺数据：前四行填上四个成员（样式不进状态文档，这里不再造样式） */
const before0 = await readSheet()
const model0 = buildModel({ name: SHEET, xml: before0.xml, shared: before0.shared })
const START = model0.dataStart
const END = model0.dataEnd
/** 被删掉的是第二个成员那一行：它是中间行，后面的行才真的会"整体上移" */
const DROP = START + 1

{
  const wb = await openWorkbook(await fsp.readFile(fixture))
  let xml = await wb.sheetXml(SHEET)
  for (const [i, m] of MEMBERS.entries()) {
    const row = START + i
    const values = {
      nickname: m.nick,
      gameName: `${m.nick}的游戏`,
      anchor: "阿修Axiu",
      goal: "险恶(N4)",
      note: `备注${i}`,
      status: "排队中",
    }
    for (const key of KEYS) xml = setCellText(xml, `${model0.col[key]}${row}`, values[key])
  }
  wb.setSheetXml(SHEET, xml)
  await fsp.writeFile(fixture, await wb.toBuffer())
}

/** 2) 绑定：群名单对账只对**有绑定**的人删行，所以先把这四个人绑到他们那一行上。
 *  表版本信的是状态文档（`queue.json`）的 sha256，所以先自举文档再写绑定文件。 */
{
  await writeDoc(statePath, await importWorkbook(fs.readFileSync(fixture)), { backup: false })
  const fp = createHash("sha256").update(fs.readFileSync(statePath)).digest("hex")
  const binds = { [SHEET]: {} }
  for (const [i, m] of MEMBERS.entries())
    binds[SHEET][m.qq] = { row: START + i, nickname: m.nick, at: 1 }
  await fsp.writeFile(ws.bindingsFile, JSON.stringify({ version: 1, table: fp, binds }, null, 2), "utf8")
}

const before = await readSheet()
const beforeModel = buildModel({ name: SHEET, xml: before.xml, shared: before.shared })

check("准备：四个人各占一行", () => {
  assert.equal(beforeModel.rows.length, MEMBERS.length, `应当有 ${MEMBERS.length} 行数据，实际 ${beforeModel.rows.length}`)
})

let editor = null
try {
  editor = await startEditor({
    label: "压紧行数据",
    token: TOKEN,
    signKey: SIGN_KEY,
    adminsFile,
    args: ["--file", fixture],
    env: {
      ABYSS_QUEUE_CONFIG: ws.cfg,
      ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
      ABYSS_EDITOR_ROSTER_FILE: ws.file("roster.json"),
      /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 editor/test/data-confinement.test.mjs） */
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
  })

  /** 3) 推一份"少了压紧乙"的群名单：reconcileRoster 删掉第 DROP 行并压紧 */
  const remaining = MEMBERS.filter(m => m.qq !== MEMBERS[1].qq).map(m => ({ qq: m.qq, nick: m.nick }))
  const pushed = await editor.request("/api/roster", { who: BOT, body: { group: "999888", members: remaining } })

  check("退群删行：删掉中间一行并压紧", () => {
    assert.ok(pushed.json?.ok, `推名单失败：${pushed.json?.error ?? pushed.text}`)
    assert.equal(pushed.json.removed, 1, `应当删掉 1 行：${JSON.stringify(pushed.json)}`)
  })

  const after = await readSheet()
  const afterModel = buildModel({ name: SHEET, xml: after.xml, shared: after.shared })

  check("上移后数据跟着走：甲/丙/丁 顺次落到前三行，下一行空出来", () => {
    const at = row => afterModel.rows.find(r => r.row === row)?.nickname
    assert.equal(afterModel.rows.length, MEMBERS.length - 1, `应当剩 3 行数据，实际 ${afterModel.rows.length}`)
    assert.equal(at(START), "压紧甲")
    assert.equal(at(START + 1), "压紧丙")
    assert.equal(at(START + 2), "压紧丁")
    assert.equal(at(START + 3), undefined, "第 4 行应当空出来")
  })

  check("简单工作簿：数据行不带逐行样式（样式不进状态文档）", () => {
    for (let t = START; t <= END; t++) {
      for (const col of COLUMNS) {
        const cell = after.sheet.rows.get(t)?.cells.get(col)
        assert.ok(!cell || cell.style == null, `第 ${t} 行 ${col} 列不该有样式号：${cell?.style}`)
      }
    }
  })

  check("上移没有引入合并 / 条件格式 / 超链接；下拉与序号公式仍在", () => {
    const f = features(after.xml)
    assert.equal(f.merge, 0, `不该有合并格：${f.merge}`)
    assert.equal(f.conditional, 0, `不该有条件格式：${f.conditional}`)
    assert.equal(f.link, 0, `不该有超链接：${f.link}`)
    assert.equal(f.validation, 3, `下拉数量不对：${f.validation}`)
    for (let r = START; r <= END; r++) {
      const a = after.sheet.rows.get(r)?.cells.get("A")
      assert.ok(a && a.formula, `A${r} 的序号公式丢了`)
    }
  })

  check("下拉选项解析结果不变（数据验证没被破坏）", () =>
    assert.deepEqual(afterModel.options, beforeModel.options, "下拉选项变了"),
  )

  check("尾行被清空", () => {
    for (const col of COLUMNS) {
      const cell = after.sheet.rows.get(END)?.cells.get(col)
      assert.ok(!cell || !cell.value, `${col}${END} 还有值「${cell?.value}」`)
    }
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
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
