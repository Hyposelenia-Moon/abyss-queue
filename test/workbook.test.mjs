/**
 * 表格层回归：对真实表格的副本做「结构解析 → 报名写入 → 格式保全 → 改备注 → 退队」
 *
 * 不依赖 Yunzai，直接 node test/workbook.test.mjs 运行。
 * 全程只操作副本，绝不碰原表格。
 *
 * 用法：
 *   node test/workbook.test.mjs                    # 默认表格（可用 XLSX_PATH 覆盖）
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { openWorkbook } from "../lib/xlsx.js"
import { Table } from "../model/table.js"
import { buildModel } from "../lib/schema.js"
import { findByNickname, firstEmptyRow, matchOption } from "../lib/queue.js"
import { anchorsView, menuView, queueItemView, queueView, truncateWidth } from "../lib/render.js"
import {
  countStatusEntries,
  formatUpdateReply,
  parseCommitLine,
  parsePullResult,
  parseTrackLine,
} from "../lib/git.js"
import { Paths, createChecker, requireSource } from "./_helper.mjs"

const SOURCE = requireSource()
const { check, finish } = createChecker("表格层回归")

const zipEntries = async buffer => {
  const zip = await JSZip.loadAsync(buffer)
  const out = new Map()
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    out.set(name, await file.async("nodebuffer"))
  }
  return out
}

const countOf = (text, needle) => text.split(needle).length - 1

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "abyss-queue-test-"))
  const fixture = path.join(tmpDir, "queue.xlsx")
  await fs.copyFile(SOURCE, fixture)
  console.log(`源表格：${SOURCE}`)
  console.log(`测试副本：${fixture}\n`)

  const originalBuffer = await fs.readFile(fixture)
  const originalEntries = await zipEntries(originalBuffer)
  const wb0 = await openWorkbook(originalBuffer)
  const originals = new Map()
  for (const sheet of wb0.sheets) {
    const xml = await wb0.sheetXml(sheet.name)
    originals.set(sheet.name, {
      xml,
      model: buildModel({ name: sheet.name, xml, shared: wb0.shared }),
      merges: countOf(xml, "<mergeCell "),
      validations: countOf(xml, "<dataValidation "),
      conditional: countOf(xml, "<conditionalFormatting "),
      formulas: countOf(xml, "<f>"),
    })
  }

  console.log("【1】结构解析")
  check("识别到 3 个工作表", () => assert.equal(originals.size, 3))
  check("表头行 = 7 / 10 / 7", () => {
    assert.equal(originals.get("幻想真境剧诗").model.headerRow, 7)
    assert.equal(originals.get("幽境危战").model.headerRow, 10)
    assert.equal(originals.get("深境螺旋").model.headerRow, 7)
  })
  check("列映射 A–H 正确", () => {
    const col = originals.get("幽境危战").model.col
    assert.deepEqual(col, {
      seq: "A",
      nickname: "B",
      gameName: "C",
      anchor: "D",
      goal: "E",
      strength: "F",
      note: "G",
      status: "H",
    })
  })
  check("下拉选项解析正确", () => {
    const m = originals.get("幽境危战").model
    assert.deepEqual(m.options.goal, ["险恶(N4)", "无畏(N5)", "绝境(N6)", "绝境(N6)180s"])
    assert.deepEqual(m.options.strength, ["高配", "中配", "低配"])
    assert.deepEqual(originals.get("深境螺旋").model.options.goal, ["11层满星", "12层满星"])
  })
  check("主播区解析：3 / 6 / 3 位", () => {
    assert.equal(originals.get("幻想真境剧诗").model.anchors.length, 3)
    assert.equal(originals.get("幽境危战").model.anchors.length, 6)
    assert.equal(originals.get("深境螺旋").model.anchors.length, 3)
    assert.equal(originals.get("幽境危战").model.anchors[0].name, "阿修Axiu")
    assert.equal(originals.get("幽境危战").model.anchors[0].recommend, "强烈推荐")
  })
  check("已在排队人数：10 / 16 / 6", () => {
    assert.equal(originals.get("幻想真境剧诗").model.rows.length, 10)
    assert.equal(originals.get("幽境危战").model.rows.length, 16)
    assert.equal(originals.get("深境螺旋").model.rows.length, 6)
  })
  check("数据区末日行：107 / 110 / 107", () => {
    assert.equal(originals.get("幻想真境剧诗").model.dataEnd, 107)
    assert.equal(originals.get("幽境危战").model.dataEnd, 110)
    assert.equal(originals.get("深境螺旋").model.dataEnd, 107)
  })
  check("选项模糊匹配可用", () => {
    const m = originals.get("幽境危战").model
    assert.equal(matchOption("无畏", m.options.goal), "无畏(N5)")
    assert.equal(matchOption("3", m.options.strength), "低配")
    assert.equal(matchOption("不存在", m.options.strength), null)
  })

  console.log("\n【1.5】图片渲染的视图数据（纯函数）")
  check("显示宽度截断：中文按 2 计", () => {
    assert.equal(truncateWidth("一二三四五", 6), "一二…")
    assert.equal(truncateWidth("abcdefgh", 4), "abc…")
    assert.equal(truncateWidth("短", 10), "短")
    assert.equal(truncateWidth("任意长度", 0), "任意长度")
  })
  check("单行视图按列截断，且不丢关键列", () => {
    const item = { row: 11, seq: "1", nickname: "这是一个非常长的群昵称测试", gameName: "游戏名", anchor: "阿修Axiu", goal: "绝境(N6)180s", strength: "高配", status: "排队中", note: "很长的备注" }
    const view = queueItemView(item, { myRow: 11, nameMax: 8, bodyMax: 6 })
    assert.ok(view.nickname.endsWith("…"), view.nickname)
    assert.ok(view.goal.endsWith("…"), view.goal)
    assert.equal(view.mine, true)
    assert.equal(view.status, "", "默认不显示状态列")
    assert.equal(view.note, "", "默认不显示备注列")
    assert.equal(view.anchor, "阿修A…")
  })
  check("队列视图带总数、限行与剩余人数", () => {
    const m = originals.get("幽境危战").model
    const v = queueView(m, { limit: 5, myRow: 0, nameMax: 12, bodyMax: 10 })
    assert.equal(v.name, "幽境危战")
    assert.equal(v.total, 16)
    assert.equal(v.rows.length, 5)
    assert.equal(v.more, 11)
    assert.equal(v.rows[0].seq, "1")
  })
  check("全部模式（limit=0）不截断行数", () => {
    const m = originals.get("幽境危战").model
    const v = queueView(m, { limit: 0 })
    assert.equal(v.rows.length, 16)
    assert.equal(v.more, 0)
  })
  check("主播/菜单视图数据完整", () => {
    const m = originals.get("幽境危战").model
    const a = anchorsView(m)
    assert.equal(a.total, 6)
    assert.equal(a.anchors[0].name, "阿修Axiu")
    assert.ok(a.anchors[0].recommend)
    const menu = menuView([m], { defaultSheet: "幽境危战", version: "v1.0.0" })
    assert.equal(menu.sheets.length, 1)
    assert.equal(menu.sheets[0].count, 16)
    assert.equal(menu.defaultSheet, "幽境危战")
    assert.equal(menu.version, "v1.0.0")
  })

  console.log("\n【1.6】更新指令的 git 输出解析（纯函数）")
  check("解析分支跟踪行（落后/领先/无上游）", () => {
    assert.deepEqual(parseTrackLine("## main...origin/main [behind 2]"), {
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 2,
      hasUpstream: true,
    })
    assert.deepEqual(parseTrackLine("## main...origin/main [ahead 1, behind 3]"), {
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 3,
      hasUpstream: true,
    })
    assert.equal(parseTrackLine("## main").hasUpstream, false)
    assert.equal(parseTrackLine("").branch, "")
  })
  check("统计本地改动条数", () => {
    assert.equal(countStatusEntries(" M a.js\n?? b.js\n"), 2)
    assert.equal(countStatusEntries(""), 0)
  })
  check("解析提交摘要行", () => {
    assert.deepEqual(parseCommitLine("e6666c9|fix: 报名选项归一化"), {
      hash: "e6666c9",
      subject: "fix: 报名选项归一化",
    })
    assert.equal(parseCommitLine("不是提交行").hash, "")
    /** git 把 warning 混进 stdout 时，仍要找到真正的提交行 */
    assert.deepEqual(
      parseCommitLine("warning: in the working copy of 'x.js' LF will be replaced by CRLF\n9a0732d|feat: 新增更新指令"),
      { hash: "9a0732d", subject: "feat: 新增更新指令" },
    )
  })
  check("判定 git pull 结果", () => {
    assert.equal(parsePullResult({ stdout: "Already up to date." }).status, "uptodate")
    assert.equal(parsePullResult({ stdout: "Updating e6666c9..94941e0\nFast-forward" }).status, "updated")
    assert.equal(
      parsePullResult({ error: new Error("Your local changes would be overwritten by merge"), stderr: "" }).status,
      "conflict",
    )
    assert.equal(parsePullResult({ error: new Error("fatal: unable to access") }).status, "error")
  })
  check("更新结果文案覆盖四种状态", () => {
    assert.ok(formatUpdateReply({ status: "uptodate", before: { hash: "abc" }, repo: "x" }).includes("已是最新（abc）"))
    /** 拿不到哈希时不显示"未知"占位 */
    const noHash = formatUpdateReply({ status: "uptodate", before: { hash: "" }, repo: "x" })
    assert.equal(noHash, "x 已是最新")
    assert.ok(!noHash.includes("未知"))
    assert.ok(formatUpdateReply({ status: "conflict", repo: "x" }).includes("无法直接更新"))
    assert.ok(formatUpdateReply({ status: "error", error: "网络错误", repo: "x" }).includes("网络错误"))
    const ok = formatUpdateReply({
      status: "updated",
      before: { hash: "aaa", subject: "旧" },
      after: { hash: "bbb", subject: "新" },
      repo: "x",
    })
    assert.ok(ok.includes("更新成功") && ok.includes("aaa → bbb") && ok.includes("旧 → 新"))
  })

  const table = new Table({ file: fixture, backup: false })
  const SHEET = "幽境危战"
  const QQ = "123456789"
  const NICK = "测试报名者"

  console.log("\n【2】报名写入")
  let joined
  await table.mutate(ctx => {
    const model = ctx.model(SHEET)
    assert.equal(firstEmptyRow(model), 27, "空行应为第 27 行")
    joined = { row: 27, model }
    const cells = {
      nickname: NICK,
      gameName: "测试游戏名",
      anchor: "阿修Axiu",
      goal: "无畏(N5)",
      strength: "低配",
      note: "自动化测试写入",
      status: "排队中",
    }
    for (const [k, v] of Object.entries(cells)) ctx.setCell(SHEET, 27, k, v)
  })
  const afterJoin = await fs.readFile(fixture)
  const wb1 = await openWorkbook(afterJoin)
  const model1 = buildModel({ name: SHEET, xml: await wb1.sheetXml(SHEET), shared: wb1.shared })
  const row27 = model1.rows.find(i => i.row === 27)
  check("第 27 行已落表", () => assert.ok(row27, "第 27 行没有数据"))
  check("B–H 内容正确", () => {
    assert.equal(row27.nickname, NICK)
    assert.equal(row27.gameName, "测试游戏名")
    assert.equal(row27.anchor, "阿修Axiu")
    assert.equal(row27.goal, "无畏(N5)")
    assert.equal(row27.strength, "低配")
    assert.equal(row27.note, "自动化测试写入")
    assert.equal(row27.status, "排队中")
  })
  check("序号公式仍在（A27 有公式）", () => {
    const xml = originals.get(SHEET).xml
    assert.ok(countOf(xml, "<f>") > 0)
  })
  check("人数 +1（16 → 17）", () => assert.equal(model1.rows.length, 17))
  check("空行顺延到第 28 行", () => assert.equal(firstEmptyRow(model1), 28))

  console.log("\n【3】人工维护要素未被破坏")
  const entries1 = await zipEntries(afterJoin)
  check("zip 条目数量不变", () => assert.equal(entries1.size, originalEntries.size))
  check("未改动的工作表 XML 完全一致", () => {
    for (const name of ["幻想真境剧诗", "深境螺旋"]) {
      const entry = wb1.sheets.find(s => s.name === name)
      const before = originalEntries.get(entry.path)
      const after = entries1.get(entry.path)
      assert.ok(before.equals(after), `工作表「${name}」的 XML 被改动了`)
    }
  })
  check("sharedStrings / styles / 关系文件一致", () => {
    for (const name of ["xl/sharedStrings.xml", "xl/styles.xml", "xl/_rels/workbook.xml.rels", "[Content_Types].xml"])
      assert.ok(originalEntries.get(name).equals(entries1.get(name)), `${name} 被改动了`)
  })
  const xml1 = await wb1.sheetXml(SHEET)
  check("合并单元格数不变", () =>
    assert.equal(countOf(xml1, "<mergeCell "), originals.get(SHEET).merges),
  )
  check("下拉验证数不变", () =>
    assert.equal(countOf(xml1, "<dataValidation "), originals.get(SHEET).validations),
  )
  check("条件格式仍在", () => {
    assert.equal(countOf(xml1, "<conditionalFormatting "), originals.get(SHEET).conditional)
    assert.ok(xml1.includes("排队中"), "条件格式规则「排队中」丢失")
  })
  check("序号公式数不变（100 条）", () => assert.equal(countOf(xml1, "<f>"), originals.get(SHEET).formulas))
  check("冻结窗格仍在", () => assert.ok(xml1.includes("<pane ")))
  check("超链接仍在", () => assert.ok(xml1.includes("<hyperlink ")))

  console.log("\n【4】改备注 / 退队")
  await table.mutate(ctx => ctx.setCell(SHEET, 27, "note", "改过的备注"))
  const wb2 = await openWorkbook(await fs.readFile(fixture))
  const model2 = buildModel({ name: SHEET, xml: await wb2.sheetXml(SHEET), shared: wb2.shared })
  check("备注已更新", () =>
    assert.equal(model2.rows.find(i => i.row === 27)?.note, "改过的备注"),
  )
  check("其他列未被误改", () => {
    const row = model2.rows.find(i => i.row === 27)
    assert.equal(row.nickname, NICK)
    assert.equal(row.gameName, "测试游戏名")
    assert.equal(row.goal, "无畏(N5)")
  })

  await table.mutate(ctx => ctx.clearRow(SHEET, 27))
  const afterLeave = await fs.readFile(fixture)
  const wb3 = await openWorkbook(afterLeave)
  const xml3 = await wb3.sheetXml(SHEET)
  const model3 = buildModel({ name: SHEET, xml: xml3, shared: wb3.shared })
  check("退队后人数恢复 16", () => assert.equal(model3.rows.length, 16))
  check("第 27 行已无数据", () => assert.equal(model3.rows.find(i => i.row === 27), undefined))
  check("B–H 单元格被移除（与原始空行同形）", () => {
    const rowBlock = /<row r="27"[^>]*>([\s\S]*?)<\/row>/.exec(xml3)?.[1] ?? ""
    assert.ok(rowBlock.includes('r="A27"'), "A27 公式应保留")
    for (const col of ["B", "C", "D", "E", "F", "G", "H"])
      assert.ok(!rowBlock.includes(`r="${col}27"`), `${col}27 应被移除`)
  })
  check("退队后空行回到第 27 行", () => assert.equal(firstEmptyRow(model3), 27))

  console.log("\n【5】重复报名与特殊字符")
  await table.mutate(ctx => ctx.setCell(SHEET, 27, "nickname", "重名测试"))
  const wb4 = await openWorkbook(await fs.readFile(fixture))
  const model4 = buildModel({ name: SHEET, xml: await wb4.sheetXml(SHEET), shared: wb4.shared })
  check("按昵称可查到行", () =>
    assert.equal(findByNickname(model4, "重名测试")[0].row, 27),
  )

  const tricky = `A&B <tag> "双引号" '单引' 🐍🐍 【推荐】\n第二行`
  await table.mutate(ctx => ctx.setCell(SHEET, 27, "note", tricky))
  const wb5 = await openWorkbook(await fs.readFile(fixture))
  const model5 = buildModel({ name: SHEET, xml: await wb5.sheetXml(SHEET), shared: wb5.shared })
  check("XML 特殊字符 / emoji / 换行 原样往返", () =>
    assert.equal(model5.rows.find(i => i.row === 27)?.note, tricky),
  )
  check("写入后文件仍完整（3 个工作表）", () => assert.equal(wb5.sheets.length, 3))
  const entries5 = await zipEntries(await fs.readFile(fixture))
  check("其他工作表的条件格式未受影响", () => {
    for (const name of ["幻想真境剧诗", "深境螺旋"]) {
      const entry = wb5.sheets.find(s => s.name === name)
      const before = countOf(originalEntries.get(entry.path).toString(), "<conditionalFormatting ")
      const after = countOf(entries5.get(entry.path).toString(), "<conditionalFormatting ")
      assert.equal(after, before, `「${name}」条件格式数量变化`)
    }
  })
  check("未改动工作表仍逐字节一致", () => {
    for (const name of ["幻想真境剧诗", "深境螺旋"]) {
      const entry = wb5.sheets.find(s => s.name === name)
      assert.ok(originalEntries.get(entry.path).equals(entries5.get(entry.path)), `「${name}」被改动`)
    }
  })

  console.log("\n【6】原文件未被触碰")
  const stillOriginal = await fs.readFile(SOURCE)
  check("源表格哈希未变", () => assert.ok(stillOriginal.equals(originalBuffer)))

  finish()
  console.log(`测试产物（可手动用 Excel 打开确认）：${fixture}`)
}

main().catch(err => {
  if (err?.message === "__CHECK_FAILED__") process.exit(1)
  console.error(`\n❌ 表格层回归异常终止：${err?.message ?? err}`)
  process.exit(1)
})
