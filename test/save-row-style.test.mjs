/**
 * **普通保存**（`/api/save` → `applySave`）写入已存在的数据行时，逐行样式不能被抹平（AQ-15 再延伸）
 *
 * 另外两条路的样式保全分别见 clearrow-style.test.mjs（`removeCells` 保住"清空同一行再填回来"的样式）
 * 与 compact-style.test.mjs（`compactSheet` 搬行时把源行每格的 s 显式带上）。
 * 编辑器普通保存走的是 `ctx.setCell(sheet, row, key, value)`，样式默认取 `model.styles[key]`
 * ——那是"同列第一个有样式的格子"采样出来的**一个**样式号，于是**与采样行底色不同的行会被抹平**。
 *
 * 空模板里正好有这个现场（三张表的数据区都是隔行配色）：
 *   剧诗第 8 行 B–H 的 s = 37/37/39/40/41/56/54（= 整列采样样式），第 9 行 = 30/30/31/59/33/51/52。
 * 所以第 9 行是天然的探针：普通保存写在它上面，一旦套用整列采样样式，B9 的 s 就会从 30 变成 37（套上第 8 行的底色）。
 *
 * 覆盖三件事：
 *   1. 普通保存一行"底色与采样行不同"的记录 → 保存后该行 B–H 的样式号与保存前完全一致；
 *   2. 再走一次「点本人已完成 → 落成群昵称」这类写入 → 样式仍不变；
 *   3. 真正的新行（空行）写入时仍拿到合理的列采样样式（不能退化成"没有样式"）。
 *
 * 全程只动临时目录里的副本，绝不碰 resources/空模板.xlsx。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { createChecker } from "./_helper.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "../editor/test/harness.mjs"
import { openWorkbook, parseSheet } from "../model/xlsx.js"
import { buildModel } from "../model/schema.js"
import { Table } from "../model/table.js"
import { firstEmptyRow } from "../modules/queue.js"

const { check, finish } = createChecker("普通保存逐行样式保全")

const SHEET = "幻想真境剧诗"
const COLUMNS = ["B", "C", "D", "E", "F", "G", "H"]
const KEYS = ["nickname", "gameName", "anchor", "goal", "strength", "note", "status"]
const SELF_DONE = "本人已完成"
const TOKEN = "save-row-style-token"
const SIGN_KEY = "save-row-style-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const PROBE = { nick: "探针主播", game: "探针的游戏" }

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过普通保存样式套件`)
  process.exit(0)
}

const ws = makeWorkspace("save-row-style")
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
const modelOf = s => buildModel({ name: SHEET, xml: s.xml, shared: s.shared })

/**
 * 选探针行：**样式与"整列采样样式"不同的第一个数据行**
 *
 * 不写死行号（模板以后可能换版），而是拿模型给出的采样样式去比——采样样式正是普通保存
 * 默认取的那一份，所以"和它不同"的行才是会被抹平的那种。
 */
const base = await readSheet()
const baseModel = modelOf(base)
const sample = Object.fromEntries(COLUMNS.map((col, i) => [col, baseModel.styles[KEYS[i]] ?? null]))
const sampleTuple = tupleOf(sample)
let probeRow = 0
for (let r = baseModel.dataStart; r <= baseModel.dataEnd; r++) {
  const st = stylesOf(base.sheet, r)
  if (COLUMNS.some(col => st[col] != null) && tupleOf(st) !== sampleTuple) {
    probeRow = r
    break
  }
}
const probeStyles = stylesOf(base.sheet, probeRow)

check("前置：模板里找得到「样式 ≠ 整列采样样式」的数据行（否则这条缺陷抓不出来）", () => {
  assert.ok(probeRow, `数据区里没有底色与采样样式不同的行（采样样式 ${sampleTuple}）`)
  assert.ok(!sameStyles(probeStyles, sample), `选中的第 ${probeRow} 行样式竟然与采样样式相同：${sampleTuple}`)
  for (const col of COLUMNS) assert.notEqual(probeStyles[col], null, `第 ${probeRow} 行 ${col} 列没有样式`)
})
console.log(`探针行：第 ${probeRow} 行（${tupleOf(probeStyles)}），整列采样样式：${sampleTuple}\n`)

let editor = null
try {
  editor = await startEditor({
    label: "普通保存样式",
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

  const data = async () => (await editor.request("/api/data", { who: OWNER })).json.sheets.find(s => s.name === SHEET)
  const rowOf = async row => (await data()).rows.find(r => r.row === row)

  /** 从表自己的下拉里取一个合法值：空模板与真实表格的选项不同，写死会让套件在换版时报假红 */
  const firstOption = (list, fallback) => (list ?? []).find(v => v && !["等待开启", "排队中", SELF_DONE].includes(v)) ?? fallback
  const sheetNow = await data()
  const VALUES = {
    nickname: PROBE.nick,
    gameName: PROBE.game,
    anchor: firstOption(sheetNow.options?.anchor, "阿修Axiu"),
    goal: firstOption(sheetNow.options?.goal, "无畏(N5)"),
    strength: (sheetNow.options?.strength ?? [])[0] ?? "低配",
    note: "保存样式探针",
    status: "排队中",
  }
  console.log(`写入用的合法值：${JSON.stringify(VALUES)}\n`)

  /** 1) 普通保存：只改一行的值（走 /api/save → applySave → ctx.setCell） */
  await check(`普通保存第 ${probeRow} 行：保存成功`, async () => {
    const saved = await editor.request("/api/save", {
      who: OWNER,
      body: { sheet: SHEET, rows: [{ row: probeRow, values: { ...VALUES } }] },
    })
    if (!saved.json.ok) throw new Error(`保存失败：${saved.json.error ?? saved.text}`)
  })

  const afterSave = await readSheet()
  await check(`普通保存后第 ${probeRow} 行 B–H 的样式号与保存前完全一致（缺陷核心）`, () =>
    assert.ok(
      sameStyles(stylesOf(afterSave.sheet, probeRow), probeStyles),
      `保存把这一行的样式改了：${diffOf(stylesOf(afterSave.sheet, probeRow), probeStyles)}`,
    ),
  )
  await check("普通保存后值确实落表了（不是为了保样式而没写进去）", () => {
    const row = modelOf(afterSave).rows.find(r => r.row === probeRow)
    assert.ok(row, `第 ${probeRow} 行没有数据`)
    assert.equal(row.nickname, PROBE.nick)
    assert.equal(row.note, "保存样式探针")
  })
  /** 与"套上采样样式"要能区分开：这一条才真正盯住被抹平的现场 */
  await check("普通保存后没有套上整列采样样式", () =>
    assert.notEqual(tupleOf(stylesOf(afterSave.sheet, probeRow)), sampleTuple, "这一行被抹成了同列采样样式（第 8 行的底色）"),
  )

  /** 2) 「点本人已完成 → 落成群昵称」：applySave 里第二次改写同一格 */
  await check("界面点「本人已完成」：保存成功且落成群昵称", async () => {
    const before = await rowOf(probeRow)
    const saved = await editor.request("/api/save", {
      who: OWNER,
      body: { sheet: SHEET, rows: [{ row: probeRow, values: { ...before, status: SELF_DONE } }] },
    })
    if (!saved.json.ok) throw new Error(`保存失败：${saved.json.error ?? saved.text}`)
    const now = await rowOf(probeRow)
    if (now.status !== PROBE.nick) throw new Error(`完成情况应为群昵称「${PROBE.nick}」，实际「${now.status}」`)
  })

  const afterSelfDone = await readSheet()
  await check(`「本人已完成」落成群昵称后，第 ${probeRow} 行样式仍不变`, () =>
    assert.ok(
      sameStyles(stylesOf(afterSelfDone.sheet, probeRow), probeStyles),
      `这一次写入把样式改了：${diffOf(stylesOf(afterSelfDone.sheet, probeRow), probeStyles)}`,
    ),
  )

  /** 3) 真正的新行：空行写入仍要拿到合理的列采样样式（不能变成"没有样式"） */
  const beforeNew = await readSheet()
  const emptyRow = firstEmptyRow(modelOf(beforeNew))
  check("准备：清掉探针行后能定位到第一个空行", () => assert.ok(emptyRow > 0, "没有找到空行"))

  await check(`新行（第 ${emptyRow} 行）写入：保存成功`, async () => {
    const saved = await editor.request("/api/save", {
      who: OWNER,
      body: {
        sheet: SHEET,
        rows: [
          {
            row: emptyRow,
            values: {
              nickname: "新行样式",
              gameName: "新行样式游戏",
              anchor: VALUES.anchor,
              goal: VALUES.goal,
              strength: VALUES.strength,
            },
          },
        ],
      },
    })
    if (!saved.json.ok) throw new Error(`保存失败：${saved.json.error ?? saved.text}`)
  })

  const afterNew = await readSheet()
  await check("新行的 B–H 拿到整列采样样式（不是无样式的裸格）", () => {
    const got = stylesOf(afterNew.sheet, emptyRow)
    for (const col of COLUMNS) assert.notEqual(got[col], null, `${col}${emptyRow} 没有样式（新行被写成裸格）`)
    assert.ok(sameStyles(got, sample), `新行样式与列采样不符：${diffOf(got, sample)}`)
  })
  await check("新行确实被当成数据行读出来了", () => {
    const row = modelOf(afterNew).rows.find(r => r.row === emptyRow)
    assert.ok(row, `第 ${emptyRow} 行没有数据`)
    assert.equal(row.nickname, "新行样式")
  })

  /**
   * 4) 表里**连这一行都没有**（数据区之外的新行）时，必须按列采样样式新建格子
   *
   * 3) 走的是"空模板里预置的空行"：那些行本来就有 s，所以还不能证明"新格也套得上采样样式"。
   * 这一条直接往数据区末尾之后写——`setCellText` 会新建整行与整格，样式只能来自采样。
   * 不过 API 只认数据区内的行，所以这里用表格层自己的 ctx.setCell 来覆盖这条路径。
   */
  {
    const beyondRow = modelOf(afterNew).dataEnd + 1
    const table = new Table({ file: fixture, backup: false })
    await check(`数据区之外的新行（第 ${beyondRow} 行）：写入成功`, async () => {
      await table.mutate(async ctx => {
        ctx.setCell(SHEET, beyondRow, "nickname", "区域外新行")
        ctx.setCell(SHEET, beyondRow, "note", "区域外新行")
      })
    })
    const afterBeyond = await readSheet()
    await check("数据区之外的新格拿到整列采样样式（不是无样式的裸格）", () => {
      const got = stylesOf(afterBeyond.sheet, beyondRow)
      for (const col of ["B", "G"]) assert.notEqual(got[col], null, `${col}${beyondRow} 没有样式（新格被写成裸格）`)
      assert.equal(got.B, sample.B, `昵称列新格样式应为采样 ${sample.B}，实际 ${got.B}`)
      assert.equal(got.G, sample.G, `备注列新格样式应为采样 ${sample.G}，实际 ${got.G}`)
    })
  }
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
