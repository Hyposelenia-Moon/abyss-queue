/**
 * 压紧行（删中间一行、后面的行整体上移）时的**逐行样式保全**（AQ-15 延伸）
 *
 * 「清空同一行再填回来」已经保住了行样式（见 test/clearrow-style.test.mjs）；搬行是另一条路：
 * 编辑器里删行、群名单对账发现退群之后，`compactSheet` 会把后面的行整体上移（B–H 搬一行、尾行清空）。
 * 逐格写入若吃 `ctx.setCell` 的整列采样样式（`model.styles[key]`，即"同列第一个格子的样式"），
 * **逐行样式差别就会被抹平**：上移后的行会套上别人那一行的底色/边框。
 *
 * 这里用真的编辑器进程走一遍「退群删行 → 压紧」：
 *   1. 在临时副本的数据区前四行铺上**四种互不相同**的样式（不这么铺，整列采样样式也能蒙对）
 *   2. 推一份少一个人的群名单 → reconcileRoster 删掉那一行并压紧
 *   3. 逐格比对"上移后每一行的 B–H 样式号"与"它搬走前那一行"，并检查尾行与结构类要素
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
import { firstEmptyRow } from "../modules/queue.js"

const { check, finish } = createChecker("压紧行样式保全")

const SHEET = "幻想真境剧诗"
const COLUMNS = ["B", "C", "D", "E", "F", "G", "H"]
/** 编辑器里那 7 个可写字段（= 数据列的 key） */
const KEYS = ["nickname", "gameName", "anchor", "goal", "strength", "note", "status"]
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
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

/** 取一行 B–H 的样式号（格子在、但 s 为空也算 null） */
const stylesOf = (sheet, row) => {
  const out = {}
  for (const col of COLUMNS) out[col] = sheet.rows.get(row)?.cells.get(col)?.style ?? null
  return out
}
const sameStyles = (a, b) => COLUMNS.every(col => a[col] === b[col])
const tupleOf = s => COLUMNS.map(col => s[col] ?? "无").join("/")
const diffOf = (a, b) =>
  COLUMNS.filter(col => a[col] !== b[col])
    .map(col => `${col}:${a[col] ?? "无"}→${b[col] ?? "无"}`)
    .join("、")

const readSheet = async () => {
  const wb = await openWorkbook(await fsp.readFile(fixture))
  const xml = await wb.sheetXml(SHEET)
  return { xml, shared: wb.shared, sheet: parseSheet(xml, wb.shared) }
}
/** 结构类要素计数（搬行不该动它们） */
const features = xml => ({
  conditional: xml.split("<conditionalFormatting").length - 1,
  validation: xml.split("<dataValidation").length - 1,
  formula: xml.split("<f").length - 1,
  merge: xml.split("<mergeCell").length - 1,
})

/** 1) 铺数据：前四行各用一套**互不相同**的样式（都取自模板自己用过的样式号，文件仍然合规） */
const before0 = await readSheet()
const model0 = buildModel({ name: SHEET, xml: before0.xml, shared: before0.shared })
const START = model0.dataStart
const END = model0.dataEnd
/** 被删掉的是第二个成员那一行：它是中间行，后面的行才真的会"整体上移" */
const DROP = START + 1

/** 模板里出现过的逐行样式（按行去重），用来当"数据行的样式" */
const seen = new Map()
for (let r = START; r <= END; r++) {
  const t = tupleOf(stylesOf(before0.sheet, r))
  if (!seen.has(t)) seen.set(t, stylesOf(before0.sheet, r))
}
const sampleTuple = tupleOf(Object.fromEntries(COLUMNS.map((col, i) => [col, model0.styles[KEYS[i]] ?? null])))
const tailTuple = tupleOf(stylesOf(before0.sheet, END))
/** 挑四套与「整列采样样式」「尾行空行样式」都不同的样式，抹平式实现才会被这条用例抓出来 */
const seeds = [...seen.values()].filter(s => ![sampleTuple, tailTuple].includes(tupleOf(s))).slice(0, MEMBERS.length)

check("前置：模板里凑得出四套互不相同的行样式", () =>
  assert.equal(seeds.length, MEMBERS.length, `只找到 ${seeds.length} 套可用样式：${[...seen.keys()].join(" ")}`),
)
check("前置：数据区每一行 B–H 都有样式（否则「样式跟着行走」无从比对）", () => {
  for (let r = START; r <= END; r++)
    for (const col of COLUMNS)
      assert.ok(stylesOf(before0.sheet, r)[col] != null, `第 ${r} 行 ${col} 列没有样式`)
})

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
      strength: "低配",
      note: `备注${i}`,
      status: "排队中",
    }
    for (const key of KEYS) xml = setCellText(xml, `${model0.col[key]}${row}`, values[key], seeds[i][model0.col[key]])
  }
  wb.setSheetXml(SHEET, xml)
  await fsp.writeFile(fixture, await wb.toBuffer())
}

/** 2) 绑定：群名单对账只对**有绑定**的人删行，所以先把这四个人绑到他们那一行上 */
{
  const fp = createHash("sha256").update(await fsp.readFile(fixture)).digest("hex")
  const binds = { [SHEET]: {} }
  for (const [i, m] of MEMBERS.entries())
    binds[SHEET][m.qq] = { row: START + i, nickname: m.nick, at: 1 }
  await fsp.writeFile(ws.bindingsFile, JSON.stringify({ version: 1, table: fp, binds }, null, 2), "utf8")
}

/** 搬行之前的现场：逐行样式 + 数据行 + 结构类要素（"每条断言都要看它移动前的那一行"） */
const before = await readSheet()
const beforeModel = buildModel({ name: SHEET, xml: before.xml, shared: before.shared })
const beforeStyles = new Map()
for (let r = START; r <= END; r++) beforeStyles.set(r, stylesOf(before.sheet, r))
const beforeFeatures = features(before.xml)

check("准备：四个人各占一行、各带一套样式", () => {
  assert.equal(beforeModel.rows.length, MEMBERS.length, `应当有 ${MEMBERS.length} 行数据，实际 ${beforeModel.rows.length}`)
  const tuples = MEMBERS.map((_, i) => tupleOf(beforeStyles.get(START + i)))
  assert.equal(new Set(tuples).size, MEMBERS.length, `四行样式应当互不相同：${tuples.join(" ")}`)
})

let editor = null
try {
  editor = await startEditor({
    label: "压紧行样式",
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
  const afterStyles = new Map()
  for (let r = START; r <= END; r++) afterStyles.set(r, stylesOf(after.sheet, r))
  /** 某一行搬走之前在的那一行：上移发生在删除点之后 */
  const sourceOf = t => (t < DROP ? t : t + 1)

  check("上移后数据跟着走：甲/丙/丁 顺次落到前三行，下一行空出来", () => {
    const at = row => afterModel.rows.find(r => r.row === row)?.nickname
    assert.equal(afterModel.rows.length, MEMBERS.length - 1, `应当剩 3 行数据，实际 ${afterModel.rows.length}`)
    assert.equal(at(START), "压紧甲")
    assert.equal(at(START + 1), "压紧丙")
    assert.equal(at(START + 2), "压紧丁")
    assert.equal(firstEmptyRow(afterModel), START + 3, "空行应当顺延到第 4 行")
  })

  /** 核心：整片数据区逐行比对——每一行拿到的必须是"它搬走前那一行"的样式 */
  check("上移后每一行的 B–H 样式号 == 它搬走前那一行的样式（AQ-15 延伸）", () => {
    for (let t = START; t < END; t++) {
      const src = sourceOf(t)
      const got = afterStyles.get(t)
      const want = beforeStyles.get(src)
      assert.ok(
        sameStyles(got, want),
        `第 ${t} 行（搬自第 ${src} 行，${tupleOf(want)}）样式对不上：${diffOf(got, want)}`,
      )
    }
  })

  check("尾行被清空，样式回到空行口径（不是被抹成同列采样样式）", () => {
    const tail = END
    for (const col of COLUMNS) {
      const cell = after.sheet.rows.get(tail)?.cells.get(col)
      assert.ok(!cell || !cell.value, `${col}${tail} 还有值「${cell?.value}」`)
    }
    assert.ok(
      sameStyles(afterStyles.get(tail), beforeStyles.get(tail)),
      `尾行样式被改了：${diffOf(afterStyles.get(tail), beforeStyles.get(tail))}`,
    )
    const tailNow = tupleOf(afterStyles.get(tail))
    assert.notEqual(tailNow, sampleTuple, "尾行套上了整列采样样式（那一份属于同列第一个数据行）")
    for (const s of seeds) assert.notEqual(tailNow, tupleOf(s), `尾行套上了别人那一行的样式：${tailNow}`)
  })

  check("上移没有动条件格式 / 数据验证 / 公式 / 合并单元格", () =>
    assert.deepEqual(features(after.xml), beforeFeatures, "结构类要素数量变化"),
  )
  check("下拉选项解析结果不变（数据验证没被破坏）", () =>
    assert.deepEqual(afterModel.options, beforeModel.options, "下拉选项变了"),
  )
  check("序号公式仍在数据区每一行上（A 列不受搬行影响）", () => {
    for (let r = START; r <= END; r++) {
      const a = after.sheet.rows.get(r)?.cells.get("A")
      assert.ok(a && a.formula, `A${r} 的序号公式丢了`)
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
