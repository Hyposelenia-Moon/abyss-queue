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
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
import YAML from "yaml"
import { openWorkbook } from "../lib/xlsx.js"
import { Table } from "../model/table.js"
import { buildModel } from "../lib/schema.js"
import { findByNickname, firstEmptyRow, matchOption } from "../lib/queue.js"
import { DEFAULT_CONFIG } from "../components/config.js"
import { anchorsView, menuView, ownRowView, queueItemView, queueView, truncateWidth } from "../lib/render.js"
import { Paths, createChecker, pluginRoot, requireSource } from "./_helper.mjs"

const SOURCE = requireSource()
const { check, finish } = createChecker("表格层回归")

/** 配置模板内容（用于校验模板覆盖了全部默认键） */
const exampleConfig =
  YAML.parse(await fs.readFile(path.join(pluginRoot, "config", "config.yaml.example"), "utf8")) ?? {}

/** .gitignore 行（用于校验运行时文件都已被忽略） */
const gitignoreLines = (await fs.readFile(path.join(pluginRoot, ".gitignore"), "utf8")).split(/\r?\n/).map(i => i.trim())

/** .gitattributes 行（用于校验行尾策略） */
const gitattributesLines = (await fs.readFile(path.join(pluginRoot, ".gitattributes"), "utf8")).split(/\r?\n/).map(i => i.trim())

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
  check("名单行只保留序号/成员/完成情况，本人额外拿完整信息", () => {
    const item = { row: 11, seq: "1", nickname: "这是一个非常长的群昵称测试", gameName: "游戏名", anchor: "阿修Axiu", goal: "绝境(N6)180s", strength: "高配", status: "排队中", note: "很长的备注" }
    const view = queueItemView(item, { myRow: 11, nameMax: 8, statusMax: 6 })
    /** 名单只留三列，长内容按显示宽度截断 */
    assert.deepEqual(Object.keys(view).sort(), ["mine", "nickname", "seq", "status"])
    assert.ok(view.nickname.endsWith("…"), view.nickname)
    assert.equal(view.mine, true)
    assert.equal(view.status, "排队…")
    /** 本人完整信息走 ownRowView，不被截断 */
    const own = ownRowView(item)
    assert.equal(own.gameName, "游戏名")
    assert.equal(own.goal, "绝境(N6)180s")
    assert.equal(own.note, "很长的备注")
    assert.equal(own.row, 11)
    assert.equal(ownRowView(undefined), null)
  })
  check("队列视图带总数、限行与本人信息", () => {
    const m = originals.get("幽境危战").model
    const v = queueView(m, { limit: 5, myRow: 0, nameMax: 12, statusMax: 10 })
    assert.equal(v.name, "幽境危战")
    assert.equal(v.total, 16)
    assert.equal(v.rows.length, 5)
    assert.equal(v.more, 11)
    assert.equal(v.rows[0].seq, "1")
    assert.equal(v.own, null, "未报名时没有本人信息")
    /** 传入本人行号时应带出完整信息 */
    const my = queueView(m, { limit: 5, myRow: m.rows[0].row })
    assert.equal(my.own.seq, m.rows[0].seq)
    assert.ok(my.own.gameName)
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

  console.log("\n【1.6】配置模板与忽略规则（更新不冲突的前提）")
  check("config.yaml.example 覆盖全部配置键", () => {
    /** 模板是新增配置的唯一来源（运行时 config.yaml 由它生成，老部署不会自动多出键） */
    const keys = Object.keys(DEFAULT_CONFIG)
    const missing = keys.filter(k => !(k in exampleConfig))
    assert.deepEqual(missing, [], `模板缺少键：${missing.join(", ")}`)
  })
  check("运行时配置与绑定数据都在 .gitignore 内", () => {
    for (const need of ["config/config.yaml", "data/", "node_modules/", "test/.test-tmp/"])
      assert.ok(gitignoreLines.includes(need), `.gitignore 缺少：${need}`)
  })
  check("行尾策略固定为 LF（否则部署目录会因 CRLF 被判为有本地改动）", () => {
    assert.ok(
      gitattributesLines.some(l => /^\*\s+text=auto\s+eol=lf$/.test(l)),
      "`.gitattributes` 必须包含 `* text=auto eol=lf`：Windows 上 core.autocrlf=true 会把工作区写成 CRLF，与工具产出的 LF 不一致，导致 #更新 快进被拒",
    )
  })
  check("运行时配置与绑定数据被 git 忽略（强制对齐不会丢用户数据）", () => {
    const check = target => {
      try {
        execFileSync("git", ["check-ignore", "-q", target], { cwd: pluginRoot })
        return true
      } catch {
        return false
      }
    }
    assert.ok(check("config/config.yaml"), "config/config.yaml 必须被忽略：#强制更新 才不会覆盖用户配置")
    assert.ok(check("data/bindings.json"), "data/ 必须被忽略：#强制更新 才不会清掉绑定数据")
  })

  console.log("\n【1.7】更新指令归属（由框架提供，插件不再自带）")
  check("插件不再注册任何更新指令（避免与框架 update.js 重复接管）", () => {
    /** 用子进程检查：顶层 await 的 index.js 在 CJS 测试环境里会被拒绝 */
    const probe = `
      globalThis.plugin = class { constructor(o = {}) { Object.assign(this, o) } }
      const { apps } = await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)})
      const classes = Object.values(apps)
      const out = []
      for (const C of classes) {
        const inst = new C()
        for (const r of inst.rule ?? []) if (String(r.fnc) === "update" || /更新/.test(String(r.reg))) out.push(String(r.reg))
      }
      console.log(JSON.stringify(out))
    `
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" })
    const hits = JSON.parse(stdout.trim() || "[]")
    assert.deepEqual(hits, [], `插件仍注册了更新规则：${hits.join(", ")}`)
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
