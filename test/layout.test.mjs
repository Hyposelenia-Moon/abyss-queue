/**
 * 版式契约：表格的列对齐（文本列左、状态/数字列居中、**表头跟着内容走**）
 *
 * 这套规则是照着群里的出图定的（三张渲染图 + 编辑器用同一套）：
 *   文本列（榜单 / 成员 / 昵称 / 游戏名 / 主播 / 备注 / 强项 / 入口）表头与内容都左对齐，
 *   状态与数字列（序号 / 人数 / 完成情况 / 推荐度 / 操作）表头与内容都居中。
 * 它最容易被后来改模板的人带偏（表头又变回一律居中、加了状态列忘了居中），所以在这里钉住：
 *   - 三张渲染模板：thead th 默认左对齐；状态/数字列的表头带 class="num"（CSS 里居中），
 *     同一列单元格的 class 在 CSS 里也是 text-align: center，且**没有多出来的 num 表头**
 *   - 编辑器主表（PC）：难度 / 账号强度 / 帮帮完成情况 三列的表头与药丸居中，操作列居中
 *     —— 手机是卡片布局（字段名在左边），不参与这条
 *
 * 这里只查"规则有没有被写回去"（静态契约）；**长什么样**由 test/render-check.mjs 出图人工看。
 * 用法：node test/layout.test.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { createChecker, Paths } from "./_helper.mjs"

const { check, finish } = createChecker("版式契约")

const read = rel => fs.readFileSync(path.join(Paths.root, rel), "utf8")
/** 只取 <style> 里的 CSS：别让 body 里的标记蒙到断言 */
const cssOf = html => html.slice(html.indexOf("<style>"), html.indexOf("</style>"))
const hasCenter = (css, cls) => new RegExp(`\\.${cls}\\s*\\{[^}]*text-align:\\s*center`, "s").test(css)

/**
 * 每张模板：状态/数字列的表头标题 → 这一列单元格的 class
 * （标题顺序无所谓，只用于"该居中的列有没有居中、别的列有没有乱加 class"）
 */
const TPLS = [
  {
    file: "resources/queue/menu.html",
    /** 榜单总览：榜单名是文本列，人数是数字列（整榜同一状态时那里写「等待开启」） */
    nums: { 排队人数: "count" },
  },
  {
    file: "resources/queue/queue.html",
    /** 队列表：成员是文本列，序号与完成情况居中 */
    nums: { 序号: "seq", 完成情况: "status" },
  },
  {
    file: "resources/queue/anchors.html",
    /** 主播表：只有推荐度是状态列（胶囊） */
    nums: { 推荐度: "rec" },
  },
]

for (const t of TPLS) {
  check(`${t.file}：表头跟着内容走（文本列左、状态/数字列居中）`, () => {
    const html = read(t.file)
    const css = cssOf(html)
    if (!/thead\s+th\s*\{[^}]*text-align:\s*left/s.test(css))
      throw new Error("thead th 的默认对齐不是左对齐（表头该跟着文本列走）")
    if (!/thead\s+th\.num\s*\{[^}]*text-align:\s*center/s.test(css))
      throw new Error("缺少 thead th.num { text-align: center }（状态/数字列的表头要居中）")

    const titles = Object.keys(t.nums)
    for (const [title, cls] of Object.entries(t.nums)) {
      if (!html.includes(`<th class="num">${title}</th>`)) throw new Error(`表头「${title}」没标成 class="num"`)
      if (html.includes(`<th>${title}</th>`)) throw new Error(`表头「${title}」还是没分类的 th`)
      if (!hasCenter(css, cls)) throw new Error(`「${title}」列（.${cls}）的单元格没有 text-align: center`)
    }
    /** 别的列不该乱加 num：多一个就说明有人把文本列也居中了 */
    const marked = html.match(/<th class="num">/g)?.length ?? 0
    if (marked !== titles.length) throw new Error(`带 class="num" 的表头有 ${marked} 个，应当只有 ${titles.length} 个：${titles.join("、")}`)
  })
}

check("编辑器主表：PC 上药丸列左对齐、序号与操作列居中", () => {
  const css = cssOf(read("editor/editor.html"))
  if (!/th\s*\{[^}]*text-align:\s*left/s.test(css)) throw new Error("编辑器的 th 默认对齐不是左对齐")
  for (const cls of [".no", ".rowno"]) if (!hasCenter(css, cls.slice(1))) throw new Error(`编辑器的序号列（${cls}）没有居中`)

  const at = css.indexOf("@media (min-width: 821px)")
  if (at < 0) throw new Error("找不到 PC 的媒体查询（列对齐只该在 PC 上覆盖）")
  /** 媒体查询里的规则就这几行，取到第一段结束（"}" 收尾）即可 */
  const pc = css.slice(at, css.indexOf("\n      }", at))
  /**
   * 难度及目标(5) / 账号强度(6) / 帮帮完成情况(8)：PC 上**左对齐**
   * （主人 2026-10-05 要求从居中改回左对齐；表头与药丸都不该再被这条媒体查询抓去居中）
   */
  for (const n of [5, 6, 8]) {
    if (pc.includes(`#grid th:nth-child(${n})`) || pc.includes(`#grid td:nth-child(${n})`))
      throw new Error(`第 ${n} 列又被抓去居中了：这三列要左对齐`)
  }
  if (!pc.includes("#grid td:nth-child(9)")) throw new Error("操作列没有居中")
})

check("编辑器下拉浮层：固定定位 + JS 算坐标（绝对定位会被裁成一条白边）", () => {
  const css = cssOf(read("editor/editor.html"))
  const rule = css.match(/\.picker\s*\{[^}]*\}/s)?.[0] ?? ""
  if (!rule) throw new Error("找不到 .picker 的样式规则")
  if (!/position:\s*fixed/.test(rule))
    throw new Error(
      "`.picker` 不是固定定位。表格外面的 `.wrap{overflow:auto}` 与 `.panel{overflow:hidden}` 会把绝对定位的浮层裁掉：" +
        "单行表格时单元格贴着容器下沿，浮层只剩 7px 可见（现场就是「点开只有一个空白小条」，选项全点不到）",
    )
  if (/position:\s*absolute/.test(rule)) throw new Error("`.picker` 又变回绝对定位了（会被就地裁掉）")
  if (/top:\s*calc\(100%/.test(rule)) throw new Error("`.picker` 还留着 `top: calc(100% - 6px)` 那套贴着单元格的旧定位")
  if (css.includes(".picker.up")) throw new Error("`.picker.up` 是绝对定位时代的翻转让位写法，改用 placePicker() 算坐标")
  /** 裁切祖先还在（这就是必须固定定位的原因）；哪天没有了，这一条可以放宽 */
  if (!/\.wrap\s*\{[^}]*overflow:\s*auto/s.test(css)) throw new Error("`.wrap` 不再裁切了？那这条约束要跟着复核")
  if (!/\.panel\s*\{[^}]*overflow:\s*hidden/s.test(css)) throw new Error("`.panel` 不再裁切了？那这条约束要跟着复核")

  /** 坐标得真有人算：浮层靠 placePicker() 摆位，不再靠 CSS 里相对单元格的 top/bottom */
  const script = read("editor/editor.html")
  if (!/const placePicker = \(\) => \{/.test(script)) throw new Error("找不到 placePicker()：浮层的坐标没人算了")
  for (const prop of ["style.left", "style.top", "style.bottom", "style.maxHeight"])
    if (!script.includes(prop)) throw new Error(`placePicker() 没算 ${prop}`)
})

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
