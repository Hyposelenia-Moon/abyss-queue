/**
 * 合成样本表：入库的**空模板** + 一份匿名成员数据
 *
 * 为什么要有它（外部审核「改进意见 #3」）：
 *   回归套件以前只会去读维护者放在插件同级目录的那份真实表（2026年10月三路深渊排队.xlsx），
 *   干净克隆上它当然不存在 —— 于是「缺前置就跳过」的套件一大片，CI/别人机器上只有一半的套件真跑。
 *   这里以 `resources/空模板.xlsx` 为骨架（三张榜、表头、序号公式、主播区、下拉验证、
 *   条件格式、隔行配色全在）灌一份**匿名、可复现**的成员数据，"被测表格"不再依赖任何人的真实表格。
 *
 * 匿名到什么程度：
 *   - 成员行（B–H 列）的群昵称、游戏名、备注全是编的；
 *   - 「主播区」（表头上方那一小块）**原样保留模板里的主播名**：它是模板的结构内容，
 *     不是成员数据，而且有几条断言（含不许改的 workbook.test.mjs）就是拿它钉结构的；
 *   - 下拉选项同样来自模板，只把「完成情况」整成一列里出现过的实际取值。
 *
 * 复现：同一份模板 + 这份规格必然产出同样的内容（行、状态、样式），
 * 调用方（`ensureSampleTable()`）只有在目标文件不存在或代次变了（SAMPLE_VERSION）时才重建；
 * 连续两次生成**逻辑内容**逐一相同（字节层面不保证：JSZip 会把条目时间写进 zip 头）。
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { openWorkbook, parseSheet, removeCells, setCellText, setValidationList } from "../../lib/xlsx.js"
import { DATA_COLUMNS, buildModel } from "../../lib/schema.js"

/** 插件根（本文件在 test/fixtures/ 下） */
const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..")

/** 入库骨架：结构齐全、一行成员数据都没有 */
export const templatePath = path.join(PLUGIN_ROOT, "resources", "空模板.xlsx")

/**
 * 样本代次，用来做"可复现"判据：改了下面的 SPEC 就把它 +1，
 * 已经存在的旧样本会被重建（否则别人机器上留着上一版样本，跑出来的结论跟代码对不上）。
 */
export const SAMPLE_VERSION = "1"

/** 样本落点：`test/.test-tmp/` 已在 .gitignore 里，绝不写进版本库 */
export const samplePath = path.join(PLUGIN_ROOT, "test", ".test-tmp", "sample-table.xlsx")

/**
 * 「主播别名」这条路的样本值：成员行里按**旧名（别名）**写，正名是主播区里的那一位。
 *
 * 为什么样本自己带这对值：别名认不认得出来取决于配置（`anchor_aliases`），
 * 而编辑器那几个套件以前把真实表里的「璃月第一深情 → 摸头妹」写死在断言里。
 * 换成合成样本后，套件用这份契约同时写配置与断言 —— 谁都不用再记真实表里的名字。
 */
export const SAMPLE_ALIAS = { value: "样本旧名甲", canonical: "摸头妹" }

/**
 * 「别的榜有行、这一张榜没有」的样本值
 *
 * 编辑器端到端要拿这种人试"本榜还没报名 → 新报名写首个空行"；
 * 指定榜用他、`excludeSheet` 那张榜不要放他（真实表里同样有只在部分榜报名的人）。
 */
export const SAMPLE_ONLY_IN = { nickname: "样本子", sheet: "幻想真境剧诗", excludeSheet: "幽境危战" }

/**
 * 各榜的成员规格
 *
 * 覆盖的状态（这是套件真正要跑到的路径）：
 *   - `排队中`：还等着主播（月催办、上一位完成 @ 下一位都靠它）
 *   - 主播名（`阿修Axiu` / `阿修Axiu,听雨`）：主播打完了
 *   - 旧名（别名，`SAMPLE_ALIAS.value`）：编辑器要归到正名、下拉里不该冒出旧名
 *   - `本人已完成`：自己点过完成（渲染时按该行群昵称显示）
 *   - 空行：没有人，用来测"新报名写首个空行"
 *   - 深境螺旋整榜「等待开启」：菜单要显示整榜状态而不是人数
 *
 * 注：锚点里的主播名（`阿修Axiu`/`摸头妹`…）来自**模板的主播区**，
 * 那是表结构的一部分（不是成员数据）；有几条断言就拿它钉"下拉以主播列表为准"，
 * 所以样本沿用同一批名字，匿名的是成员行（昵称/游戏名/备注）与固定假号 QQ。
 */
const SPEC = {
  幻想真境剧诗: [
    { nickname: "样本甲", gameName: "样本游戏甲", anchor: "阿修Axiu", goal: "困难满花", strength: "低配", status: "本人已完成", note: "样本备注" },
    { nickname: "样本乙", gameName: "样本游戏乙", anchor: "阿修Axiu", goal: "卓越满花", strength: "中配", status: "阿修Axiu" },
    { nickname: "样本丙", gameName: "样本游戏丙", anchor: "听雨", goal: "月谕满花", strength: "低配", status: "排队中" },
    { nickname: "样本丁", gameName: "样本游戏丁", anchor: "阿修Axiu", goal: "困难满原石", strength: "中配", status: "排队中" },
    { nickname: "样本戊", gameName: "样本游戏戊", anchor: "赐次", goal: "卓越满原石", strength: "高配", status: "排队中" },
    { nickname: "样本己", gameName: "样本游戏己", anchor: "都可以", goal: "月谕满原石", strength: "低配", status: "排队中" },
    { nickname: "样本庚", gameName: "样本游戏庚", anchor: "阿修Axiu", goal: "困难满花", strength: "低配", status: "阿修Axiu" },
    { nickname: "样本辛", gameName: "样本游戏辛", anchor: "听雨", goal: "卓越满花", strength: "中配", status: "排队中" },
    { nickname: "样本壬", gameName: "样本游戏壬", anchor: "都可以", goal: "月谕满花", strength: "低配", status: "排队中" },
    { nickname: "样本癸", gameName: "样本游戏癸", anchor: "赐次", goal: "困难满原石", strength: "高配", status: "排队中" },
    /** 只在这一张榜报名的人（见 SAMPLE_ONLY_IN）：编辑器靠他试"本榜还没有我的行 → 新报名" */
    { nickname: SAMPLE_ONLY_IN.nickname, gameName: "样本游戏子", anchor: "阿修Axiu", goal: "困难满花", strength: "低配", status: "排队中" },
  ],
  幽境危战: [
    /** 多选主播：别名/多值那条路的输入（值都取自模板主播区，改模板时会当场报错） */
    { nickname: "样本甲", gameName: "样本游戏甲", anchor: "阿修Axiu,听雨", goal: "无畏(N5)", strength: "低配", status: "排队中", note: "样本备注" },
    { nickname: "样本乙", gameName: "样本游戏乙", anchor: "阿修Axiu", goal: "险恶(N4)", strength: "中配", status: "本人已完成" },
    /** 「都可以」是独占值：与别人并选必须被拒 */
    { nickname: "样本丙", gameName: "样本游戏丙", anchor: "都可以", goal: "无畏(N5)", strength: "低配", status: "排队中" },
    { nickname: "样本丁", gameName: "样本游戏丁", anchor: "纸笑", goal: "无畏(N5)", strength: "低配", status: "排队中" },
    { nickname: "样本戊", gameName: "样本游戏戊", anchor: "纸笑", goal: "绝境(N6)", strength: "中配", status: "排队中" },
    { nickname: "样本己", gameName: "样本游戏己", anchor: "漠天秋", goal: "无畏(N5)", strength: "高配", status: "排队中" },
    { nickname: "样本庚", gameName: "样本游戏庚", anchor: "摸头妹", goal: "无畏(N5)", strength: "低配", status: "排队中" },
    { nickname: "样本辛", gameName: "样本游戏辛", anchor: "阿修Axiu", goal: "绝境(N6)180s", strength: "高配", status: "阿修Axiu,摸头妹" },
    { nickname: "样本壬", gameName: "样本游戏壬", anchor: "听雨", goal: "险恶(N4)", strength: "低配", status: "排队中" },
    { nickname: "样本癸", gameName: "样本游戏癸", anchor: "七笙", goal: "无畏(N5)", strength: "中配", status: "排队中" },
    { nickname: "样本亥", gameName: "样本游戏亥", anchor: "阿修Axiu", goal: "绝境(N6)", strength: "低配", status: "排队中" },
    { nickname: "样本丑", gameName: "样本游戏丑", anchor: "听雨", goal: "无畏(N5)", strength: "中配", status: "排队中" },
    { nickname: "样本寅", gameName: "样本游戏寅", anchor: "纸笑", goal: "无畏(N5)", strength: "低配", status: "排队中" },
    { nickname: "样本卯", gameName: "样本游戏卯", anchor: "漠天秋", goal: "险恶(N4)", strength: "高配", status: "排队中" },
    { nickname: "样本辰", gameName: "样本游戏辰", anchor: "阿修Axiu", goal: "无畏(N5)", strength: "低配", status: "排队中" },
    { nickname: "样本酉", gameName: "样本游戏酉", anchor: "七笙", goal: "绝境(N6)", strength: "中配", status: "排队中" },
    /** 旧名（别名）那一行：编辑器要能把它归到正名，且下拉里不该冒出别名本身 */
    { nickname: "样本未", gameName: "样本游戏未", anchor: SAMPLE_ALIAS.value, goal: "无畏(N5)", strength: "低配", status: "排队中", note: "样本备注" },
  ],
  /** 整榜「等待开启」：菜单显示整榜状态而非排队人数（workbook.test.mjs 用真实表时同样成立） */
  深境螺旋: [
    { nickname: "样本甲", gameName: "样本游戏甲", anchor: "阿修Axiu", goal: "12层满星", strength: "低配", status: "等待开启", note: "样本备注" },
    { nickname: "样本乙", gameName: "样本游戏乙", anchor: "阿修Axiu", goal: "12层满星", strength: "中配", status: "等待开启" },
    { nickname: "样本丙", gameName: "样本游戏丙", anchor: "摸头妹", goal: "11层满星", strength: "低配", status: "等待开启" },
    { nickname: "样本丁", gameName: "样本游戏丁", anchor: "听雨", goal: "12层满星", strength: "低配", status: "等待开启" },
    { nickname: "样本戊", gameName: "样本游戏戊", anchor: "阿修Axiu", goal: "11层满星", strength: "高配", status: "等待开启" },
    { nickname: "样本己", gameName: "样本游戏己", anchor: "都可以", goal: "12层满星", strength: "中配", status: "等待开启" },
    /**
     * 只在这一张榜报名的人：编辑器端到端要拿他试"本榜还没有我的行 → 新报名"，
     * 所以样本里必须存在「别的榜有行、这一张榜没有」的昵称（真实表里同样有这样的人）。
     */
    { nickname: "样本午", gameName: "样本游戏午", anchor: "阿修Axiu", goal: "12层满星", strength: "低配", status: "等待开启" },
  ],
}

/** 「都可以」不是某位主播，是模板下拉里就有的独占选项，样本也照用 */
const ANY_ANCHOR = "都可以"

/** 两个"还没轮到人"的状态：编辑器给新行下发的默认值之一，样本里也备上 */
const ANY_WAITING = "等待开启"
const ANY_QUEUED = "排队中"

/** 样本里用到的旧名（别名）→ 正名：成员行按旧名写，正名必须真的在主播区里 */
const ALIAS_TO = new Map([[SAMPLE_ALIAS.value, SAMPLE_ALIAS.canonical]])

/**
 * 逐行样板：数据区里"从没填过人、且 B–H 每格都带样式"的行，按行号奇偶各取一个
 *
 * 表是**隔行配色**的（奇偶各一套样式）。这里必须挑"**完整**的空行"（七列都有样式）：
 * 空模板里紧挨数据的头一行可能只剩 A 列公式格（B–H 压根没有格子），
 * 拿它当样板写出来的行会没有样式 —— 而模板自检（`test/template.test.mjs`）
 * 与 `tools/make-template.mjs` 用的都是"某个空行的样式"，两边必须落在同一套上。
 */
function donorStyleOf(sheet, model) {
  const used = new Set(model.rows.map(r => r.row))
  const styleAt = (row, col) => sheet.rows.get(row)?.cells.get(col)?.style
  const complete = row => DATA_COLUMNS.every(k => styleAt(row, model.col[k]) != null)
  const donor = {}
  for (let r = model.dataStart; r <= model.dataEnd; r++) {
    if (used.has(r) || !complete(r)) continue
    if (donor[r % 2] === undefined) donor[r % 2] = r
  }
  const styles = {}
  for (const parity of Object.keys(donor)) {
    styles[parity] = {}
    for (const key of DATA_COLUMNS) styles[parity][key] = styleAt(donor[parity], model.col[key])
  }
  return styles
}

/** 样本内容写入：值按规格、样式按该行奇偶的"空行样板"（隔行配色不串） */
function fillSheet(xml, sheet, model, rows, anchorNames) {
  let out = xml
  const donor = donorStyleOf(sheet, model)
  const cell = (row, key, value, style) => {
    const col = model.col?.[key]
    if (!col) throw new Error(`工作表「${model.name}」没有「${key}」列，样本规格与表结构对不上`)
    out = setCellText(out, `${col}${row}`, String(value ?? ""), style)
  }
  rows.forEach((row, i) => {
    const r = model.dataStart + i
    if (r > model.dataEnd) throw new Error(`工作表「${model.name}」数据区放不下第 ${i + 1} 行（末日行 ${model.dataEnd}）`)
    /** 先把这一行**已有**的格清成空值（保留样式属性），再按样板样式重写，最后落值 */
    out = removeCells(out, DATA_COLUMNS.map(k => model.col?.[k] && `${model.col[k]}${r}`).filter(Boolean))
    for (const key of DATA_COLUMNS) cell(r, key, "", donor[r % 2]?.[key])
    for (const [value, keys] of [
      [row.nickname, ["nickname"]],
      [row.gameName, ["gameName"]],
      [row.anchor, ["anchor"]],
      [row.goal, ["goal"]],
      [row.strength, ["strength"]],
      [row.note ?? "", ["note"]],
      [row.status, ["status"]],
    ])
      for (const key of keys) cell(r, key, value, donor[r % 2]?.[key])
    /** 主播值必须点得出主播区里的某一位（可由别名归一过来），否则编辑器的"下拉以主播列表为准"会把它判成非法 */
    for (const name of String(row.anchor).split(/[,，]/).map(s => s.trim()).filter(Boolean)) {
      if (name === ANY_ANCHOR || anchorNames.has(name)) continue
      const canonical = ALIAS_TO.get(name)
      if (canonical && anchorNames.has(canonical)) continue
      throw new Error(`样本规格里的主播「${name}」既不在「${model.name}」的主播区、也不是已登记的旧名：${[...anchorNames].join("、")}`)
    }
  })

  /**
   * 三列下拉：
   *   - 完成情况 = 两个"还没轮到人"的状态 + 这批数据真正用到的取值（含主播名与「本人已完成」）
   *   - **选择主播保持骨架里那份（不补全）**：真实表里就有一位只在主播区、不在下拉验证里的名字
   *     （编辑器的"下拉以主播列表为准"就是为它写的），样本照旧保留这个场景，
   *     否则 `editor/test/editor.test.mjs` 里那条断言会因为"没有这个场景"而空转。
   */
  const states = [...new Set([ANY_WAITING, ANY_QUEUED, ...rows.map(r => r.status)])]
  out = setValidationList(out, model.col.status, states).xml
  return out
}

/** 自检：写出来的样本必须真的能解析出「每榜几行 + 那些状态」 */
function verify(buffer) {
  return openWorkbook(buffer).then(wb => {
    const names = wb.sheets.map(s => s.name)
    const want = Object.keys(SPEC)
    if (names.join("|") !== want.join("|"))
      throw new Error(`样本工作表清单不对：${names.join("、")}（期望 ${want.join("、")}）`)
    const summary = []
    return Promise.all(
      names.map(async name => {
        const model = buildModel({ name, xml: await wb.sheetXml(name), shared: wb.shared })
        if (model.rows.length !== SPEC[name].length)
          throw new Error(`样本「${name}」有 ${model.rows.length} 行，期望 ${SPEC[name].length} 行`)
        const got = [...new Set(model.rows.map(r => r.status))].sort().join("/")
        const expect = [...new Set(SPEC[name].map(r => r.status))].sort().join("/")
        if (got !== expect) throw new Error(`样本「${name}」的状态是 ${got}，期望 ${expect}`)
        if (!model.anchors.length) throw new Error(`样本「${name}」的主播区没了（骨架没读对）`)
        summary.push(`${name} ${model.rows.length} 行`)
      }),
    ).then(() => {
      /**
       * `SAMPLE_ONLY_IN` 是给编辑器端到端用的："别的榜有行、这一张榜没有"。
       * 样本自己先验一遍，免得改样本时把这条前提悄悄破坏掉（套件那边只会报"找不到人"）。
       */
      const inSheet = SPEC[SAMPLE_ONLY_IN.sheet]?.some(r => r.nickname === SAMPLE_ONLY_IN.nickname)
      const inExcluded = SPEC[SAMPLE_ONLY_IN.excludeSheet]?.some(r => r.nickname === SAMPLE_ONLY_IN.nickname)
      if (!inSheet || inExcluded)
        throw new Error(
          `SAMPLE_ONLY_IN 约定被破坏：「${SAMPLE_ONLY_IN.nickname}」应当只在「${SAMPLE_ONLY_IN.sheet}」有行、` +
            `「${SAMPLE_ONLY_IN.excludeSheet}」没有（当前：在=${inSheet}，被排除的榜也有=${inExcluded}）`,
        )
      return summary.join("、")
    })
  })
}

/**
 * 说明"这一趟用的是合成样本"（**每个套件进程印一次**）
 *
 * 生成只在第一次落盘时发生，但"这次跑的不是真实数据"这件事每个套件都得说清楚
 * （看日志的人只看到某一个套件的输出时，也该知道结论是在样本上得到的）。
 */
let noticeShown = false
export function noticeUsingSample() {
  if (noticeShown) return
  noticeShown = true
  console.log(`本次用合成样本（真实表不存在）：${samplePath}`)
}

/**
 * 确保样本表存在（不存在或代次变了就重建），返回其路径
 * @returns {Promise<string>}
 */
export async function ensureSampleTable() {
  noticeUsingSample()
  const marker = `${samplePath}.v`
  const built = (() => {
    try {
      return fs.readFileSync(marker, "utf8").trim()
    } catch {
      return ""
    }
  })()
  const tpl = createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex").slice(0, 12)
  const stamp = `${SAMPLE_VERSION}:${tpl}:${process.version}`
  if (built === stamp && fs.existsSync(samplePath)) return samplePath
  if (!fs.existsSync(templatePath)) throw new Error(`缺少入库的空模板：${templatePath}（合成样本以它为骨架）`)

  const wb = await openWorkbook(fs.readFileSync(templatePath))
  for (const [name, rows] of Object.entries(SPEC)) {
    if (!wb.hasSheet(name)) throw new Error(`骨架「${templatePath}」里没有工作表「${name}」`)
    const xml = await wb.sheetXml(name)
    const model = buildModel({ name, xml, shared: wb.shared })
    const anchorNames = new Set(model.anchors.map(a => a.name))
    wb.setSheetXml(name, fillSheet(xml, parseSheet(xml, wb.shared), model, rows, anchorNames))
  }
  const buffer = await wb.toBuffer()
  const summary = await verify(buffer)
  fs.mkdirSync(path.dirname(samplePath), { recursive: true })
  fs.writeFileSync(samplePath, buffer)
  fs.writeFileSync(marker, stamp, "utf8")
  console.log(`  内容：${summary}（骨架 ${path.basename(templatePath)}）`)
  return samplePath
}
