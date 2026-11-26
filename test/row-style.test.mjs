/** 行样式：compact-style / clearrow-style / save-row-style 合并成一个套件（原文件见 git 历史） */
import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { createHash } from "node:crypto"
import { makeWorkspace, startEditor } from "../editor/test/harness.mjs"
import { openWorkbook, parseSheet, setCellText } from "../model/xlsx.js"
import { buildModel } from "../model/schema.js"
import { importWorkbook } from "../model/doc-import.js"
import { writeDoc, docFileOf } from "../model/queue-doc.js"
import fsP from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Paths } from "./_helper.mjs"
import { Table } from "../model/table.js"
import { TEMPLATE } from "../editor/test/harness.mjs"
import { firstEmptyRow } from "../modules/queue.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("行样式")

await (async () => {
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
})()

await (async () => {
  const TEMPLATE = path.join(Paths.root, "resources", "空模板.xlsx")
  if (!fs.existsSync(TEMPLATE)) {
    console.log(`⏭ 没有空模板（${TEMPLATE}）：它是随源码入库的（resources/空模板.xlsx），从仓库里取回来再跑`)
    process.exit(0)
  }

  /** 只在临时目录里改动：绝不碰 resources/空模板.xlsx */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-queue-clear-"))
  const file = path.join(dir, "queue.xlsx")
  await fsP.copyFile(TEMPLATE, file)

  const table = new Table({ file, backup: false })
  const COLUMNS = ["B", "C", "D", "E", "F", "G", "H"]

  /** 取一行 B–H 的样式号（格子在、但 s 为空也记成空串） */
  const stylesOf = (sheet, row) => {
    const out = {}
    for (const col of COLUMNS) out[col] = sheet.rows.get(row)?.cells.get(col)?.style ?? null
    return out
  }
  /** 同一行 B–H 的样式是否逐格一致 */
  const sameStyles = (a, b) => COLUMNS.every(col => a[col] === b[col])
  const diffOf = (a, b) => COLUMNS.filter(col => a[col] !== b[col]).map(col => `${col}:${a[col] ?? "无"}→${b[col] ?? "无"}`).join("、")

  /** 读取某一榜的原始 XML 与解析结果（shared 一并带出：表头等文本在 sharedStrings 里） */
  async function snapshot(sheetName) {
    const wb = await openWorkbook(await fsP.readFile(file))
    const xml = await wb.sheetXml(sheetName)
    return { xml, shared: wb.shared, sheet: parseSheet(xml, wb.shared) }
  }

  /** 结构类要素计数（清空/重填都不该动它们） */
  const features = xml => ({
    conditional: xml.split("<conditionalFormatting").length - 1,
    validation: xml.split("<dataValidation").length - 1,
    formula: xml.split("<f").length - 1,
    merge: xml.split("<mergeCell").length - 1,
  })

  /** 三个榜各自找一行「数据区里有样式的行」做用例（模板里 A 列序号公式 + B–H 有底色） */
  const targets = []
  {
    const wb = await openWorkbook(await fsP.readFile(file))
    for (const s of wb.sheets) {
      const xml = await wb.sheetXml(s.name)
      const sheet = parseSheet(xml, wb.shared)
      const model = buildModel({ name: s.name, xml, shared: wb.shared })
      let row = 0
      for (let r = model.dataStart; r <= model.dataEnd; r++) {
        const cells = sheet.rows.get(r)?.cells
        if (cells && COLUMNS.some(c => cells.get(c))) {
          row = r
          break
        }
      }
      if (!row) {
        console.log(`⏭ ${s.name} 数据区没有带样式的行，跳过该榜`)
        continue
      }
      targets.push({ name: s.name, row, before: features(xml), styles: stylesOf(sheet, row) })
    }
  }

  check("模板里选到了带样式的数据行（前置）", () => assert.ok(targets.length > 0, "三个榜都没找到带样式的数据行"))

  for (const t of targets) {
    console.log(`\n【${t.name} 第 ${t.row} 行】`)

    /** 1) 报名：写入必填四项（模拟编辑器的一次保存） */
    await table.mutate(ctx => {
      for (const [k, v] of Object.entries({
        nickname: "样式回归",
        gameName: "样式回归游戏",
        anchor: "样式主播",
        goal: "无畏(N5)",
        note: "样式回归备注",
        status: "排队中",
      }))
        ctx.setCell(t.name, t.row, k, v)
    })
    const afterJoin = await snapshot(t.name)
    check("报名后数据已落表", () => {
      const model = buildModel({ name: t.name, xml: afterJoin.xml, shared: afterJoin.shared })
      const row = model.rows.find(r => r.row === t.row)
      assert.ok(row, `第 ${t.row} 行没有数据`)
      assert.equal(row.nickname, "样式回归")
    })
    check("报名写入的样式 = 该行原有样式", () =>
      assert.ok(sameStyles(stylesOf(afterJoin.sheet, t.row), t.styles), diffOf(stylesOf(afterJoin.sheet, t.row), t.styles)),
    )

    /** 2) 退队：清空这一行 */
    await table.mutate(ctx => ctx.clearRow(t.name, t.row))
    const afterClear = await snapshot(t.name)
    const clearedStyles = stylesOf(afterClear.sheet, t.row)
    check("清空后这一行不再是数据行", () => {
      const model = buildModel({ name: t.name, xml: afterClear.xml, shared: afterClear.shared })
      assert.equal(model.rows.find(r => r.row === t.row), undefined, `第 ${t.row} 行仍被当成数据行`)
    })
    check("清空后 B–H 的值确实没了", () => {
      for (const col of COLUMNS) {
        const cell = afterClear.sheet.rows.get(t.row)?.cells.get(col)
        assert.ok(!cell || !cell.value, `${col}${t.row} 还有值「${cell?.value}」`)
      }
    })
    check("清空保留了原行的样式（AQ-15 核心）", () =>
      assert.ok(sameStyles(clearedStyles, t.styles), `样式被改成：${diffOf(clearedStyles, t.styles)}`),
    )
    check("清空没有动条件格式/验证/公式/合并单元格", () =>
      assert.deepEqual(features(afterClear.xml), t.before, "结构类要素数量变化"),
    )

    /** 3) 重新报名：同一行（firstEmptyRow 会回到这一行） */
    await table.mutate(ctx => {
      ctx.setCell(t.name, t.row, "nickname", "样式回归2")
      ctx.setCell(t.name, t.row, "goal", "险恶(N4)")
      ctx.setCell(t.name, t.row, "status", "排队中")
    })
    const afterRejoin = await snapshot(t.name)
    check("重新报名的样式仍等于原行样式（退队→再报名不丢格式）", () => {
      const now = stylesOf(afterRejoin.sheet, t.row)
      assert.ok(sameStyles(now, t.styles), `样式变了：${diffOf(now, t.styles)}`)
    })
    check("重新报名后可正常读取", () => {
      const model = buildModel({ name: t.name, xml: afterRejoin.xml, shared: afterRejoin.shared })
      const row = model.rows.find(r => r.row === t.row)
      assert.ok(row, `第 ${t.row} 行没有数据`)
      assert.equal(row.nickname, "样式回归2")
      assert.equal(row.goal, "险恶(N4)")
    })
    check("重新报名没有动结构类要素", () => assert.deepEqual(features(afterRejoin.xml), t.before))
  }

  /** 4) 「空行」的判定：清空后保留的空样式格不能被误当成数据（firstEmptyRow 要认它） */
  {
    const { firstEmptyRow } = await import("../modules/queue.js")
    const name = targets[0].name
    const row = targets[0].row

    const readModel = async () => {
      const wb = await openWorkbook(await fsP.readFile(file))
      return buildModel({ name, xml: await wb.sheetXml(name), shared: wb.shared })
    }

    await table.mutate(ctx => ctx.clearRow(name, row))
    const cleared = await readModel()
    check("清空后该行重新成为「第一个空行」（空样式格不算数据）", () => {
      assert.equal(firstEmptyRow(cleared), row, `预期第 ${row} 行，实际 ${firstEmptyRow(cleared)}`)
      assert.equal(cleared.rows.find(r => r.row === row), undefined, "清空的行不该出现在 rows 里")
    })

    await table.mutate(ctx => {
      ctx.setCell(name, row, "nickname", "空行判定")
      ctx.setCell(name, row, "goal", "无畏(N5)")
    })
    const rejoined = await readModel()
    check("重新报名后空行顺延到下一行", () =>
      assert.equal(firstEmptyRow(rejoined), row + 1, `预期第 ${row + 1} 行，实际 ${firstEmptyRow(rejoined)}`),
    )
  }

  console.log(`\n测试产物：${file}`)
  await finish()
})()

await (async () => {
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
})()

finish()
