/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行，
   在本文件里 setenv 是无效的，config.js 会按仓库 config.yaml 读（会动到真实表格） */
import { ensureEnv } from "./env.mjs"
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
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
import YAML from "yaml"
import { openWorkbook, setCellText, setValidationList } from "../lib/xlsx.js"
import { Table } from "../model/table.js"
import { buildModel } from "../lib/schema.js"
import { findByNickname, firstEmptyRow, locateSelf, matchOption, myRowOf } from "../lib/queue.js"
import { resolveSheet } from "../lib/router.js"
import { DEFAULT_CONFIG } from "../components/config.js"
import { checkPatches, patchNotice } from "../lib/patches.js"
import { anchorDetailView, anchorsAllView, anchorsView, menuView, ownRowView, queueItemView, queueView, renderAnchorDetail, renderAnchorsAll, renderMenu, sheetStatus, truncateWidth } from "../lib/render.js"
import { Paths, createChecker, pluginRoot, requireSource } from "./_helper.mjs"

/** 被测表格：`requireSource()` 是异步的（缺真实表时现生成合成样本，见 test/_helper.mjs），必须 await */
const SOURCE = await requireSource()
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
  const ENV = await ensureEnv({ prefix: "abyss-queue-test-", cloud: false })
  const fixture = ENV.fixture
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
  /** 表格是用户随时在用的真实数据：行数只做「与解析结果一致」的断言，不写死人数 */
  const baseRows = Object.fromEntries([...originals].map(([n, o]) => [n, o.model.rows.length]))
  const baseAnchors = Object.fromEntries([...originals].map(([n, o]) => [n, o.model.anchors.length]))
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
  check("主播区每位榜都有主播", () => {
    assert.equal(originals.get("幻想真境剧诗").model.anchors.length, baseAnchors["幻想真境剧诗"])
    assert.equal(originals.get("幽境危战").model.anchors.length, baseAnchors["幽境危战"])
    assert.equal(originals.get("深境螺旋").model.anchors.length, baseAnchors["深境螺旋"])
    assert.ok(baseAnchors["幽境危战"] > 0, "幽境危战应当有主播")
    assert.equal(originals.get("幽境危战").model.anchors[0].name, "阿修Axiu")
    assert.equal(originals.get("幽境危战").model.anchors[0].recommend, "强烈推荐")
  })
  check("已在排队人数与解析结果一致", () => {
    for (const [name, count] of Object.entries(baseRows))
      assert.equal(originals.get(name).model.rows.length, count, `${name} 行数应与解析一致`)
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
  check("队列视图带总数、限行与本人信息", () => {    const m = originals.get("幽境危战").model
    const v = queueView(m, { limit: 5, myRow: 0, nameMax: 12, statusMax: 10 })
    assert.equal(v.name, "幽境危战")
    assert.equal(v.total, baseRows["幽境危战"])
    assert.equal(v.rows.length, 5)
    assert.equal(v.more, Math.max(0, baseRows["幽境危战"] - 5))
    assert.equal(v.rows[0].seq, "1")
    assert.equal(v.own, null, "未报名时没有本人信息")
    const my = queueView(m, { limit: 5, myRow: m.rows[0].row })
    assert.equal(my.own.seq, m.rows[0].seq)
    assert.ok(my.own.gameName)
  })
  check("列表与本人视图：「本人已完成」按该行群昵称显示", () => {
    const row = { row: 9, seq: "2", nickname: "长昵称测试", status: "本人已完成" }
    assert.equal(queueItemView(row).status, "长昵称测试")
    assert.equal(ownRowView(row).status, "长昵称测试")
    assert.equal(queueItemView({ ...row, status: "排队中" }).status, "排队中", "其它状态不动")
  })
  check("榜名简称可解析（#危战排队/#剧诗排队/#深渊排队）", () => {
    const models = new Map([...originals].map(([name, o]) => [name, o.model]))
    assert.equal(resolveSheet("危战", models), "幽境危战")
    assert.equal(resolveSheet("剧诗", models), "幻想真境剧诗")
    assert.equal(resolveSheet("深渊", models), "深境螺旋")
    assert.equal(resolveSheet("幻想", models), "幻想真境剧诗")
    assert.equal(resolveSheet("螺旋", models), "深境螺旋")
    /** 全名与序号仍然可用 */
    assert.equal(resolveSheet("幽境危战", models), "幽境危战")
    assert.equal(resolveSheet("1", models), "幻想真境剧诗")
    assert.equal(resolveSheet("不存在", models), null)
  })
  await check("命令表精简且不误吞裸榜名", async () => {
    globalThis.plugin = class {
      constructor(o = {}) {
        Object.assign(this, o)
      }
    }
    globalThis.Bot = undefined
    const { apps } = await import("../index.js")
    const rules = Object.values(apps).flatMap(C => new C().rule ?? []).map(r => ({ reg: String(r.reg), fnc: r.fnc }))
    const hit = msg => rules.find(r => new RegExp(r.reg).test(msg))?.fnc ?? null

    /** 命令表：2 条规则（menu / anchors）——#我的 已并入 #排队，#清空 已移除 */
    assert.equal(rules.length, 2, `规则条数应为 2，当前 ${rules.length} 条`)
    for (const fnc of ["menu", "anchors"])
      assert.ok(rules.some(r => r.fnc === fnc), `缺少 ${fnc} 规则`)

    /** 参数化入口：#排队 <榜> 与旧后缀写法 */
    for (const m of [
      "#排队", "#排队 危战", "#排队 剧诗 全部", "#排队 3", "#排队 幽境危战",
      "#危战排队", "#剧诗排队", "#深渊排队", "#螺旋列表", "#幽境危战排队",
    ])
      assert.equal(hit(m), "menu", `${m} 应命中 menu`)
    for (const m of ["#主播", "#主播 危战"])
      assert.ok(hit(m), `${m} 未命中任何规则`)
    /** 裸榜名必须不命中：这些命令归 Axiu-Plugin 等（优先级更低）所有 */
    for (const m of ["#幽境危战", "#幻想真境剧诗", "#深境螺旋", "#深渊", "#危战", "#剧诗", "#螺旋全部"])
      assert.equal(hit(m), null, `${m} 不该命中本插件规则`)
    /** 填表在云端编辑器里做、插件只读：这些写表类指令都不注册 */
    for (const m of ["#清空", "#清空 深境螺旋", "#报名", "#退队", "#改备注 内容", "#我的", "#深渊报名", "#深渊退队", "#深渊我的", "#深渊主播", "#深渊改备注"])
      assert.equal(hit(m), null, `${m} 应已移除（插件只读，#我的 并入 #排队）`)
  })
  await check("部署补丁自检只跑一次且不因 Bot 未就绪报错", async () => {
    /** 复用上一条用例建好的 stub；Bot 为 undefined，自检只能记日志，不该抛错 */
    const { apps } = await import("../index.js")
    const { patchesCheckCount } = await import("../apps/_base.js")
    const before = patchesCheckCount()
    for (const C of Object.values(apps)) new C()
    for (const C of Object.values(apps)) new C()
    assert.equal(patchesCheckCount(), before, "自检应当只跑一次（构造多个 app 不应重复执行）")
    assert.equal(before, 1, "自检在本次进程里应当正好执行过一次")
  })
  check("全部模式（limit=0）不截断行数", () => {
    const m = originals.get("幽境危战").model
    const v = queueView(m, { limit: 0 })
    assert.equal(v.rows.length, baseRows["幽境危战"])
    assert.equal(v.more, 0)
  })
  check("主播合并视图：三个榜去重、专职列有值", () => {
    const models = [...originals.values()].map(o => o.model)
    const v = anchorsAllView(models)
    const raw = models.reduce((n, m) => n + m.anchors.length, 0)

    /** 同一个主播在多个榜各有一行，合并后必须少于原始行数 */
    assert.ok(v.anchors.length > 0, "没有解析出主播")
    assert.ok(v.anchors.length <= raw, `合并后 ${v.anchors.length} 位不应多于原始 ${raw} 行`)
    const names = v.anchors.map(a => a.name)
    assert.equal(new Set(names).size, names.length, "合并后不应有重复主播")
    /** 阿修Axiu 三个榜都在，必须只出现一次且专职覆盖三个榜 */
    const axiu = v.anchors.find(a => a.name === "阿修Axiu")
    assert.ok(axiu, "缺少 阿修Axiu")
    assert.equal(names.filter(n => n === "阿修Axiu").length, 1)
    for (const sheet of ["幻想真境剧诗", "幽境危战", "深境螺旋"])
      assert.ok(Array.isArray(axiu.duty) && axiu.duty.includes(sheet), `专职缺少 ${sheet}：${JSON.stringify(axiu.duty)}`)
    /** 每位都要有专职（手填或按所在榜推断） */
    for (const a of v.anchors) assert.ok(a.duty.length, `${a.name} 没有专职`)
    assert.ok(renderAnchorsAll(v).includes("专职："), "文本回退缺少专职")
  })
  check("主播合并视图的排版约定：专职最多三行、强项只取幽境危战、入口分行", () => {
    const models = [...originals.values()].map(o => o.model)
    const v = anchorsAllView(models)

    /** 专职：数组、最多三项（表格里最多显示三行） */
    for (const a of v.anchors) {
      assert.ok(Array.isArray(a.duty), `${a.name} 的专职应为数组`)
      assert.ok(a.duty.length <= 3, `${a.name} 专职超过三行：${a.duty.length}`)
      for (const d of a.duty) assert.ok(d && !/[/、,，]/.test(d), `${a.name} 的专职项未拆分：${d}`)
    }

    /** 核心强项只取幽境危战那一行 */
    const yw = originals.get("幽境危战").model
    const inYw = new Map(yw.anchors.map(a => [a.name, a.skills]))
    for (const a of v.anchors) {
      const want = inYw.get(a.name)
      if (want) assert.equal(a.skills, want, `${a.name} 的强项不是幽境危战的`)
      else
        assert.ok(
          models.some(m => m.anchors.some(x => x.name === a.name && x.skills === a.skills)),
          `${a.name} 不在幽境危战，强项应退回其它榜的原值`,
        )
    }

    /**
     * 直播入口：一项一行（数组）。分隔符是「、」「,」「，」或分格；
     * 斜杠 `/` 现在是普通字符（「B站/抖音」就是同一行的一项），所以不参与这条断言。
     */
    for (const a of v.anchors) {
      assert.ok(Array.isArray(a.entry), `${a.name} 的入口应为数组`)
      for (const e of a.entry) assert.ok(!/[、,，\n]/.test(e), `${a.name} 的入口未拆开：${e}`)
      assert.equal(new Set(a.entry).size, a.entry.length, `${a.name} 的入口有重复项`)
    }
    /** 表里 G/H 两列都填了入口的主播，必须拆成两项（各占一行） */
    const multi = v.anchors.find(a => a.entry.length >= 2)
    if (multi) assert.ok(multi.entry.length >= 2, "多入口应拆成多项")
  })
  check("单个主播详情：跨榜汇总专职与入口", () => {
    const models = [...originals.values()].map(o => o.model)
    const d = anchorDetailView(models, "阿修Axiu")
    assert.ok(d, "没找到 阿修Axiu")
    assert.equal(d.name, "阿修Axiu")
    assert.ok(d.duties.length >= 1, "专职为空")
    assert.ok(d.skills.length >= 1, "强项为空")
    assert.ok(d.entries.length >= 1, "入口为空")
    for (const s of d.skills) assert.ok(s.sheet && s.skills, "强项条目缺少榜名或内容")
    for (const e of d.entries) assert.ok(typeof e === "string" && e, "入口条目为空")
    /** 入口不再按榜分组：去重后的平台列表 */
    assert.equal(new Set(d.entries).size, d.entries.length, "入口有重复项")
    for (const e of d.entries) assert.ok(!/\n/.test(e), `入口项不应换行：${e}`)
    /** 文本输出包含关键信息 */
    const text = renderAnchorDetail(d)
    assert.ok(text.includes("阿修Axiu"), text)
    assert.ok(text.includes("专职："), text)
    assert.ok(text.includes("直播入口"), text)
    assert.equal(anchorDetailView(models, "查无此主播"), null)
  })
  check("主播区「专职」列（D 列）可被解析", () => {
    const m = originals.get("幽境危战").model
    assert.ok(m.anchors.length > 0)
    for (const a of m.anchors) assert.ok("duty" in a, "主播对象应带 duty 字段")
  })
  check("直播入口：G/H 两列各算一项，链接贴到上一个入口", () => {
    const src = originals.get("幽境危战")
    const anchor = src.model.anchors[0]
    const LINK = "https://live.bilibili.com/1960956034"
    /** 只在内存里改 XML，不落盘：模拟管理员后续在 G/H 列补内容 */
    const viewOf = (g, h, name = anchor.name) => {
      let xml = setCellText(src.xml, `G${anchor.row}`, g)
      xml = setCellText(xml, `H${anchor.row}`, h)
      return anchorsAllView([buildModel({ name: "幽境危战", xml, shared: wb0.shared })]).anchors.find(a => a.name === name)
    }

    /** 1) 真实表里的写法：G=平台、H=另一个入口 → 两项（渲染时各占一行，不会挤成一行） */
    assert.deepEqual(viewOf("群语音通话（屏幕共享）", "腾讯会议370-976-3227").entry, [
      "群语音通话（屏幕共享）",
      "腾讯会议370-976-3227",
    ])
    assert.deepEqual(viewOf("B站", "抖音（付费）").entry, ["B站", "抖音（付费）"])
    /** 2) 斜杠是普通字符：一格写「B站/抖音」算一项（渲染同一行），想拆行就用「、」 */
    assert.deepEqual(viewOf("B站/抖音", "").entry, ["B站/抖音"])
    assert.deepEqual(viewOf("B站、抖音", "").entry, ["B站", "抖音"])
    assert.deepEqual(viewOf("B站,抖音", "").entry, ["B站", "抖音"])
    /** 3) H 是链接时拼到平台上：只有一项，就是「平台+链接」 */
    assert.deepEqual(viewOf("B站", LINK).entry, [`B站${LINK}`])
    /** 4) 链接贴到前面最近一个还没有链接的入口，不会变成孤立的链接行 */
    assert.deepEqual(viewOf("B站、抖音", LINK).entry, ["B站", `抖音${LINK}`])
    /** 5) 只有平台时不会多出空行 */
    assert.deepEqual(viewOf("B站", "").entry, ["B站"])
    /** 6) 详情文本不带榜名分组，直接给「平台+链接」 */
    const model = buildModel({
      name: "幽境危战",
      xml: setCellText(setCellText(src.xml, `G${anchor.row}`, "B站"), `H${anchor.row}`, LINK),
      shared: wb0.shared,
    })
    const text = renderAnchorDetail(anchorDetailView([model], anchor.name))
    assert.ok(text.includes(`直播入口：\nB站${LINK}`), text)
    assert.ok(!/直播入口：\n\s*·/.test(text), "详情里的入口仍按榜分组")
  })
  check("下拉列表可改写：只动指定列，其它验证原样", () => {
    const src = originals.get("幽境危战").xml
    const model = originals.get("幽境危战").model
    const anchorCol = model.col.anchor
    const strengthOf = xml => new RegExp(`<formula1>([^<]*${model.options.strength[0]}[^<]*)</formula1>`).exec(xml)?.[1]
    const listOf = xml =>
      new RegExp(`sqref="${anchorCol}[^"]*"[^>]*>[\\s\\S]*?<formula1>([\\s\\S]*?)</formula1>`).exec(xml)?.[1] ?? ""

    const r = setValidationList(src, anchorCol, ["甲主播", "乙主播"])
    assert.equal(r.updated, 1, "应当正好改掉一条验证")
    assert.equal(countOf(r.xml, "<dataValidation "), countOf(src, "<dataValidation "), "验证条数不该变")
    assert.ok(listOf(r.xml).includes("甲主播") && listOf(r.xml).includes("乙主播"), `新名单没写进去：${listOf(r.xml)}`)
    /** 别的列（账号强度）一个字都不该动 */
    assert.equal(strengthOf(r.xml), strengthOf(src))
    /** 除这条验证之外，整份 XML 完全一致 */
    const strip = xml => xml.replace(/<dataValidation(?=[\s/>])([^>]*?)(?:\/>|>[\s\S]*?<\/dataValidation>)/g, "")
    assert.equal(strip(r.xml), strip(src), "改验证不该动到别处")
    /** 引用单元格区域的列表（$Z$1:$Z$9）不动 */
    const anchorListRe = new RegExp(`(sqref="${anchorCol}[^"]*"[^>]*>[\\s\\S]*?<formula1>)[\\s\\S]*?(</formula1>)`)
    const withRange = src.replace(anchorListRe, "$1$Z$1:$Z$9$2")
    assert.ok(withRange !== src, "构造区域引用失败")
    assert.equal(setValidationList(withRange, anchorCol, ["甲"]).updated, 0, "区域引用式的列表不该被改写")
  })
  check("整榜同一状态时菜单显示该状态而非人数", () => {
    const models = [...originals.values()].map(o => o.model)
    /** 深境螺旋当前整榜都是「等待开启」，菜单应同步显示它 */
    const deep = models.find(m => m.name === "深境螺旋")
    const st = sheetStatus(deep)
    if (!st) {
      console.log(`     ⏭ 深境螺旋当前状态不唯一（${[...new Set(deep.rows.map(r => r.status))].join("/")}），跳过`)
      return
    }
    assert.equal(st, "等待开启")
    const entry = menuView(models).sheets.find(s => s.name === "深境螺旋")
    assert.equal(entry.status, "等待开启")
    assert.equal(entry.queued, 0, "显示整榜状态时不应再计入排队人数")
    /** 文本菜单同样显示状态 */
    assert.ok(renderMenu(models).includes(`深境螺旋：${st}`))
    /** 状态混合的榜仍按人数显示 */
    const mixed = menuView(models).sheets.find(s => s.name === "幽境危战")
    assert.equal(mixed.status, "")
    assert.ok(mixed.count > 0)
  })
  check("主播/菜单视图数据完整", () => {
    const m = originals.get("幽境危战").model
    const a = anchorsView(m)
    assert.equal(a.total, baseAnchors["幽境危战"])
    assert.equal(a.anchors[0].name, "阿修Axiu")
    assert.ok(a.anchors[0].recommend)
    const menu = menuView([m], { defaultSheet: "幽境危战", version: "v1.0.0" })
    assert.equal(menu.sheets.length, 1)
    assert.equal(menu.sheets[0].count, baseRows["幽境危战"])
    assert.equal(menu.sheets[0].status, "", "状态混合的榜不该给出整榜状态")
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
    /** 用子进程检查：顶层 await 的 index.js 在 CJS 测试环境里会被拒绝。
     *  结果用标记包住，避免启动日志（如部署补丁自检）混进 stdout 影响解析。 */
    const probe = `
      globalThis.plugin = class { constructor(o = {}) { Object.assign(this, o) } }
      const { apps } = await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)})
      const classes = Object.values(apps)
      const out = []
      for (const C of classes) {
        const inst = new C()
        for (const r of inst.rule ?? []) if (String(r.fnc) === "update" || /更新/.test(String(r.reg))) out.push(String(r.reg))
      }
      console.log("__RULES__" + JSON.stringify(out) + "__RULES__")
    `
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" })
    const marked = /__RULES__(.*?)__RULES__/s.exec(stdout)
    assert.ok(marked, `子进程未返回规则清单，stdout：${stdout.slice(0, 200)}`)
    const hits = JSON.parse(marked[1] || "[]")
    assert.deepEqual(hits, [], `插件仍注册了更新规则：${hits.join(", ")}`)
  })
  check("部署补丁自检可识别缺失（换机部署防漏）", () => {
    /** 缺失环境必须被识别出来（这条与插件放在哪里无关） */
    const none = checkPatches(path.join(os.tmpdir(), "abyss-nonexistent-bot"))
    assert.ok(none.missing.length >= 2, "缺失环境应报出补丁缺失")
    assert.ok(patchNotice(none.missing).includes("部署补丁缺失"))

    /** 若确实部署在 <bot根>/plugins/<名> 下，则要求当前补丁齐全 */
    const botRoot = path.dirname(pluginRoot)
    const updatePlugin = path.join(botRoot, "plugins", "other", "update.js")
    if (!fsSync.existsSync(updatePlugin)) {
      console.log("     ⏭ 未部署在框架内（插件不在 <bot根>/plugins 下），跳过补丁齐全校验")
      return
    }
    const okAll = checkPatches(botRoot)
    assert.deepEqual(okAll.missing, [], `当前部署被判为缺补丁：${okAll.missing.map(p => p.id).join(",")}`)
  })

  const table = new Table({ file: fixture, backup: false })
  const SHEET = "幽境危战"
  const QQ = "123456789"
  const NICK = "测试报名者"
  /** 插入行号同样从真实数据推导：用户可能在表里补过行，写死行号会误报 */
  const EMPTY = firstEmptyRow(originals.get(SHEET).model)

  console.log("\n【2】报名写入")
  let joined
  await table.mutate(ctx => {
    const model = ctx.model(SHEET)
    assert.equal(firstEmptyRow(model), EMPTY, `空行应为第 ${EMPTY} 行`)
    joined = { row: EMPTY, model }
    const cells = {
      nickname: NICK,
      gameName: "测试游戏名",
      anchor: "阿修Axiu",
      goal: "无畏(N5)",
      strength: "低配",
      note: "自动化测试写入",
      status: "排队中",
    }
    for (const [k, v] of Object.entries(cells)) ctx.setCell(SHEET, EMPTY, k, v)
  })
  const afterJoin = await fs.readFile(fixture)
  const wb1 = await openWorkbook(afterJoin)
  const model1 = buildModel({ name: SHEET, xml: await wb1.sheetXml(SHEET), shared: wb1.shared })
  const row27 = model1.rows.find(i => i.row === EMPTY)
  check(`第 ${EMPTY} 行已落表`, () => assert.ok(row27, `第 ${EMPTY} 行没有数据`))
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
  check(`人数 +1（${baseRows[SHEET]} → ${baseRows[SHEET] + 1}）`, () =>
    assert.equal(model1.rows.length, baseRows[SHEET] + 1),
  )
  check(`空行顺延到第 ${EMPTY + 1} 行`, () => assert.equal(firstEmptyRow(model1), EMPTY + 1))

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
  await table.mutate(ctx => ctx.setCell(SHEET, EMPTY, "note", "改过的备注"))
  const wb2 = await openWorkbook(await fs.readFile(fixture))
  const model2 = buildModel({ name: SHEET, xml: await wb2.sheetXml(SHEET), shared: wb2.shared })
  check("备注已更新", () =>
    assert.equal(model2.rows.find(i => i.row === EMPTY)?.note, "改过的备注"),
  )
  check("其他列未被误改", () => {
    const row = model2.rows.find(i => i.row === EMPTY)
    assert.equal(row.nickname, NICK)
    assert.equal(row.gameName, "测试游戏名")
    assert.equal(row.goal, "无畏(N5)")
  })

  await table.mutate(ctx => ctx.clearRow(SHEET, EMPTY))
  const afterLeave = await fs.readFile(fixture)
  const wb3 = await openWorkbook(afterLeave)
  const xml3 = await wb3.sheetXml(SHEET)
  const model3 = buildModel({ name: SHEET, xml: xml3, shared: wb3.shared })
  check("退队后人数恢复", () => assert.equal(model3.rows.length, baseRows[SHEET]))
  check(`第 ${EMPTY} 行已无数据`, () => assert.equal(model3.rows.find(i => i.row === EMPTY), undefined))
  /**
   * 退队保留「空格子 + 原样式」而不是把 <c> 整段删掉（AQ-15）：
   * 删掉的话重新报名只能套用同列第一个格子的样式，行自己的隔行配色就串了。
   * 所以这里断言的是「值没了、格子与样式还在」。
   */
  check("B–H 清空后没有值、但保留格子与样式", () => {
    const rowBlock = new RegExp(`<row r="${EMPTY}"[^>]*>([\\s\\S]*?)</row>`).exec(xml3)?.[1] ?? ""
    assert.ok(rowBlock.includes(`r="A${EMPTY}"`), `A${EMPTY} 公式应保留`)
    for (const col of ["B", "C", "D", "E", "F", "G", "H"]) {
      const cell = new RegExp(`<c r="${col}${EMPTY}"([\\s\\S]*?)(?:/>|</c>)`).exec(rowBlock)
      assert.ok(cell, `${col}${EMPTY} 应保留为空格子（样式随之保留）`)
      assert.ok(/s="\d+"/.test(cell[1]), `${col}${EMPTY} 应保留原样式属性：${cell[0]}`)
      assert.ok(!cell[0].includes("<is>"), `${col}${EMPTY} 不该还有 inlineStr 内容：${cell[0]}`)
      assert.ok(!cell[0].includes("<v>"), `${col}${EMPTY} 不该还有 <v> 值：${cell[0]}`)
    }
  })
  check(`退队后空行回到第 ${EMPTY} 行`, () => assert.equal(firstEmptyRow(model3), EMPTY))

  console.log("\n【5】重复报名与特殊字符")
  await table.mutate(ctx => ctx.setCell(SHEET, EMPTY, "nickname", "重名测试"))
  const wb4 = await openWorkbook(await fs.readFile(fixture))
  const model4 = buildModel({ name: SHEET, xml: await wb4.sheetXml(SHEET), shared: wb4.shared })
  check("按昵称可查到行", () =>
    assert.equal(findByNickname(model4, "重名测试")[0].row, EMPTY),
  )
  check("按 QQ 定位：没有绑定时按群昵称兜底，并给出待绑定信息", () => {
    const empty = { get: () => null, qqsOf: () => [] }
    const hit = locateSelf(model4, empty, SHEET, "123456789", "重名测试")
    assert.equal(hit.row, EMPTY)
    assert.equal(hit.source, "nickname")
    assert.deepEqual(hit.bind, { row: EMPTY, nickname: "重名测试" })
    assert.equal(myRowOf(model4, empty, SHEET, "123456789", "重名测试"), EMPTY)
  })
  check("按 QQ 定位：有绑定就认绑定（昵称一致）", () => {
    const bound = { get: () => ({ row: EMPTY, nickname: "重名测试" }), qqsOf: () => [] }
    const hit = locateSelf(model4, bound, SHEET, "123456789", "重名测试")
    assert.equal(hit.row, EMPTY)
    assert.equal(hit.source, "bind")
    assert.equal(hit.renamedFrom, undefined)
  })
  check("按 QQ 定位：本人改了群名片时，返回要同步的新昵称", () => {
    const bound = { get: () => ({ row: EMPTY, nickname: "老名字" }), qqsOf: () => [] }
    const hit = locateSelf(model4, bound, SHEET, "123456789", "新名字")
    /** QQ 才是身份：昵称对不上也认这一行，并告诉调用方把表里的昵称改成新名片 */
    assert.equal(hit.row, EMPTY)
    assert.equal(hit.source, "bind")
    assert.equal(hit.renamedFrom, "重名测试")
    assert.equal(hit.nick, "新名字")
  })
  check("按 QQ 定位：绑定指向的行没了 → 判为过期并回到昵称兜底", () => {
    const gone = { get: () => ({ row: EMPTY + 100, nickname: "重名测试" }), qqsOf: () => [] }
    const hit = locateSelf(model4, gone, SHEET, "123456789", "重名测试")
    assert.equal(hit.stale, true)
    assert.equal(hit.row, EMPTY)
    assert.equal(hit.source, "nickname")
  })
  check("按 QQ 定位：那一行已经属于别的 QQ → 不抢，判为过期", () => {
    const taken = { get: () => ({ row: EMPTY, nickname: "重名测试" }), qqsOf: () => ["99999"] }
    /** 对方绑定里的昵称与表里一致，这才算"这一行确实是他的" */
    const store = {
      get: (sheet, qq) => (String(qq) === "123456789" ? { row: EMPTY, nickname: "重名测试" } : { row: EMPTY, nickname: "重名测试" }),
      qqsOf: () => ["99999"],
    }
    const hit = locateSelf(model4, store, SHEET, "123456789", "重名测试")
    assert.equal(hit.stale, true)
    assert.equal(locateSelf(model4, taken, SHEET, "123456789", "查无此人").row, 0)
  })
  check("按 QQ 定位：别人留下的过期绑定（昵称已对不上）不挡后来人", () => {
    const store = {
      get: (sheet, qq) => (String(qq) === "123456789" ? { row: EMPTY, nickname: "重名测试" } : { row: EMPTY, nickname: "很久以前的旧名字" }),
      qqsOf: () => ["88888"],
    }
    const hit = locateSelf(model4, store, SHEET, "123456789", "重名测试")
    assert.equal(hit.stale, undefined)
    assert.equal(hit.row, EMPTY)
    assert.equal(hit.source, "bind")
  })
  check("按 QQ 定位：昵称与绑定都没有 → 0", () => {
    const empty = { get: () => null, qqsOf: () => [] }
    assert.equal(myRowOf(model4, empty, SHEET, "123456789", ""), 0)
    assert.equal(myRowOf(model4, empty, SHEET, "123456789", "查无此人"), 0)
  })

  const tricky = `A&B <tag> "双引号" '单引' 🐍🐍 【推荐】\n第二行`
  await table.mutate(ctx => ctx.setCell(SHEET, EMPTY, "note", tricky))
  const wb5 = await openWorkbook(await fs.readFile(fixture))
  const model5 = buildModel({ name: SHEET, xml: await wb5.sheetXml(SHEET), shared: wb5.shared })
  check("XML 特殊字符 / emoji / 换行 原样往返", () =>
    assert.equal(model5.rows.find(i => i.row === EMPTY)?.note, tricky),
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

  await finish()
  console.log(`测试产物（可手动用 Excel 打开确认）：${fixture}`)
}

main().catch(err => {
  if (err?.message === "__CHECK_FAILED__") process.exit(1)
  console.error(`\n❌ 表格层回归异常终止：${err?.message ?? err}`)
  process.exit(1)
})
