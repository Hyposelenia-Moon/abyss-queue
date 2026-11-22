/**
 * **普通保存**（`/api/save` → `applySave`）写入数据行时的数据契约
 *
 * 存储换成 JSON 之后，逐行样式不再进状态文档（2026-11-22 的决定：导出的 xlsx 是“简单工作簿”，
 * 只保数据 + 下拉 + 序号公式，不保合并 / 样式 / 条件格式 / 超链接）。所以这里验的是：
 *   1. 普通保存一行记录 → 值确实落表；
 *   2. 再走一次「点本人已完成 → 落成群昵称」这类写入 → 值按契约变成群昵称；
 *   3. 真正的新行（空行）写入 → 读得出来；
 *   4. 镜像里没有逐行样式 / 合并 / 条件格式残留。
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
import { firstEmptyRow } from "../modules/queue.js"

const { check, finish } = createChecker("普通保存数据契约")

const SHEET = "幻想真境剧诗"
const COLUMNS = ["B", "C", "D", "E", "F", "G"]
const SELF_DONE = "本人已完成"
const TOKEN = "save-row-style-token"
const SIGN_KEY = "save-row-style-sign-key"
const OWNER = { qq: "424242", nick: "主人" }
const PROBE = { nick: "探针主播", game: "探针的游戏" }

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过普通保存数据套件`)
  process.exit(0)
}

const ws = makeWorkspace("save-row-style")
const fixture = ws.fixture
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

const readSheet = async () => {
  const wb = await openWorkbook(await fsp.readFile(fixture))
  const xml = await wb.sheetXml(SHEET)
  return { xml, shared: wb.shared, sheet: parseSheet(xml, wb.shared) }
}
const modelOf = s => buildModel({ name: SHEET, xml: s.xml, shared: s.shared })
const stylesOf = (sheet, row) => {
  const out = {}
  for (const col of COLUMNS) out[col] = sheet.rows.get(row)?.cells.get(col)?.style ?? null
  return out
}

const base = await readSheet()
const baseModel = modelOf(base)
/** 探针行取数据区第一行（空模板里它本来就是空的） */
const probeRow = baseModel.dataStart

let editor = null
try {
  editor = await startEditor({
    label: "普通保存数据",
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
    note: "保存样式探针",
    status: "排队中",
  }

  /** 1) 普通保存：只改一行的值（走 /api/save → applySave → ctx.setCell） */
  await check(`普通保存第 ${probeRow} 行：保存成功`, async () => {
    const saved = await editor.request("/api/save", {
      who: OWNER,
      body: { sheet: SHEET, rows: [{ row: probeRow, values: { ...VALUES } }] },
    })
    if (!saved.json.ok) throw new Error(`保存失败：${saved.json.error ?? saved.text}`)
  })

  const afterSave = await readSheet()
  await check("普通保存后值确实落表了", () => {
    const row = modelOf(afterSave).rows.find(r => r.row === probeRow)
    assert.ok(row, `第 ${probeRow} 行没有数据`)
    assert.equal(row.nickname, PROBE.nick)
    assert.equal(row.note, "保存样式探针")
  })

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

  /** 3) 真正的新行：空行写入仍要读得出来 */
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
            },
          },
        ],
      },
    })
    if (!saved.json.ok) throw new Error(`保存失败：${saved.json.error ?? saved.text}`)
  })

  const afterNew = await readSheet()
  await check("新行确实被当成数据行读出来了", () => {
    const row = modelOf(afterNew).rows.find(r => r.row === emptyRow)
    assert.ok(row, `第 ${emptyRow} 行没有数据`)
    assert.equal(row.nickname, "新行样式")
  })

  /** 4) 简单工作簿契约：镜像里不该有逐行样式 / 合并 / 条件格式 */
  await check("简单工作簿：数据行不带逐行样式，也没有合并 / 条件格式", () => {
    for (let r = baseModel.dataStart; r <= baseModel.dataEnd; r++) {
      for (const col of COLUMNS) {
        const cell = afterNew.sheet.rows.get(r)?.cells.get(col)
        assert.ok(!cell || cell.style == null, `第 ${r} 行 ${col} 列不该有样式号：${cell?.style}`)
      }
    }
    assert.ok(!/<mergeCell /.test(afterNew.xml), "不该带合并格")
    assert.ok(!/<conditionalFormatting/.test(afterNew.xml), "不该带条件格式")
    assert.ok(!/<hyperlink /.test(afterNew.xml), "不该带超链接")
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
