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
    file: "resources/queue/queue.html",
    /** 队列表：成员是文本列，序号与完成情况居中 */
    nums: { 序号: "seq", 完成情况: "status" },
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

check("队列表：列宽按内容自适应、去掉表说明行", () => {
  const html = read("resources/queue/queue.html")
  const css = cssOf(html)
  if (html.includes("表：")) throw new Error("队列表不应再显示「表：…」说明行")
  if (!/共 \{\{listed\}\} 人/.test(html)) throw new Error("页眉总数应使用表内行数 listed")
  if (!/已显示全部 \{\{listed\}\} 人/.test(html)) throw new Error("页脚总数应使用表内行数 listed")
  if (!/table-layout:\s*auto/.test(css)) throw new Error("队列表应使用 table-layout: auto，由内容决定列宽")
  if (/<colgroup|class="col-/.test(html)) throw new Error("队列表不应再写死 colgroup 列宽")
})

check("渲染字体：英文与数字优先 Times New Roman，中文回落原神字体", () => {
  for (const file of [
    "resources/queue/queue.html",
    "resources/queue/menu.html",
    "resources/queue/anchors.html",
    "resources/queue/help.html",
  ]) {
    const css = cssOf(read(file))
    if (!/font-family:\s*"Times New Roman",\s*"GenshinBody"/.test(css))
      throw new Error(`${file}：正文没有把 Times New Roman 放在 GenshinBody 前`)
    if (/font-family:\s*"GenshinBody",/.test(css))
      throw new Error(`${file}：仍有未前置 Times New Roman 的 GenshinBody 字体栈`)
  }
})

check("主播图是双列卡片，排队胶囊带「排队/等待」字样", () => {
  const html = read("resources/queue/anchors.html")
  const css = cssOf(html)
  if (/<table[\s>]/.test(html)) throw new Error("主播图不应再使用窄列表格")
  if (!/\.anchor-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/s.test(css))
    throw new Error("主播卡片不是双列网格")
  if (!/\.anchor-name\s*\{[^}]*font-size:\s*20px/s.test(css)) throw new Error("主播名字号不是 20px")
  if (!/\.skill\s*\{[^}]*font-size:\s*16px/s.test(css)) throw new Error("强项字号不是 16px")
  if (!/\.q\s*\{[^}]*font-size:\s*13px/s.test(css)) throw new Error("排队胶囊字号不是 13px")
  if (!/\{\{q\.short\}\} 排队 \{\{q\.queued\}\}/.test(html)) throw new Error("排队胶囊没有「排队」字样")
  if (!/\{\{q\.short\}\} 等待 \{\{q\.waiting\}\}/.test(html)) throw new Error("排队胶囊没有「等待」字样")
  if (!/a\.queueChips\.length/.test(html)) throw new Error("卡片没有用 queueChips 渲染排队")
})

check("总览图是榜单卡 + 我的排队卡，不再用汇总表", () => {
  const html = read("resources/queue/menu.html")
  const css = cssOf(html)
  if (/<table[\s>]/.test(html)) throw new Error("总览图不应再使用汇总表格")
  if (!/\.sheet-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4/s.test(css))
    throw new Error("榜单概况不是四列卡片")
  if (!/\.mine-grid\s*\{[^}]*grid-template-columns:\s*(?:1fr 1fr|repeat\(2,\s*minmax\(0,\s*1fr\)\))/s.test(css))
    throw new Error("我的排队信息不是双列卡片")
  if (!/\.sheet\s*\{/.test(css)) throw new Error("缺少榜单卡片样式")
  if (!/\.mine\s*\{/.test(css)) throw new Error("缺少我的排队卡片样式")
  if (!/#排队/.test(html)) throw new Error("总览图缺少命令提示")
  const wideLabel = css.match(/\.mrow\.wide \.lab\s*\{([^}]*)\}/s)
  if (!wideLabel || !/flex:\s*0 0 auto/.test(wideLabel[1]))
    throw new Error("总览本人卡「主播开播状态」标签应使用内容宽度，避免标签和值之间出现大空隙")
})

check("总览本人卡标题不再重复显示开播状态", () => {
  const html = read("resources/queue/menu.html")
  if (/anchorLive/.test(html))
    throw new Error("总览本人卡第 N 位右侧又渲染了开播状态；该状态已在本卡下方「主播开播状态」行展示")
})

check("单榜「你的报名信息」与总览本人卡同一套字段（含开播状态）", () => {
  const html = read("resources/queue/queue.html")
  const css = cssOf(html)
  for (const label of ["选择主播", "账号强度", "完成情况", "主播开播状态"])
    if (!html.includes(label)) throw new Error(`单榜本人卡缺少「${label}」：与总览不是同一套字段`)
  if (!/own\.anchorEntries/.test(html)) throw new Error("单榜本人卡没有渲染 anchorEntries（开播状态拿不到）")
  if (!/\.own \.live\s*\{/.test(css)) throw new Error("单榜本人卡缺少开播状态胶囊样式")
  if (!/\.own \.fields > \.f:last-child:nth-child\(odd\)\s*\{[^}]*grid-column:\s*1 \/ -1/s.test(css))
    throw new Error("本人卡字段数为奇数时，最后一个字段没有铺满两列，会缺一截虚线分隔")
  if (!/<div class="f"><span class="k">备注<\/span>/.test(html))
    throw new Error("本人卡没有固定渲染备注行，备注为空时整行会被吞掉")
  const label = css.match(/\.own \.f \.k\s*\{([^}]*)\}/s)
  const labelMin = label?.[1].match(/min-width:\s*(\d+)px/)
  if (!label || !/flex:\s*0 0 auto/.test(label[1]) || !labelMin || Number(labelMin[1]) < 88)
    throw new Error("「主播开播状态」标签应按内容宽度且至少 88px，避免换行或与值之间出现大空隙")
})

check("编辑器主表：序号 / 群昵称冻结，管理员按 134px 偏移", () => {
  const html = read("editor/editor.html")
  const css = cssOf(html)
  if (!html.includes('class="no col-no"')) throw new Error("序号表头没有 col-no 语义类")
  if (!html.includes("f.key === 'nickname' ? 'col-nick'")) throw new Error("群昵称表头没有 col-nick 语义类")
  if (!html.includes("td.classList.add('col-nick')")) throw new Error("群昵称单元格没有 col-nick 语义类")

  if (!/#grid th\.col-no, #grid th\.col-nick\s*\{[^}]*position:\s*sticky/s.test(css))
    throw new Error("表头 col-no/col-nick 没有 sticky")
  if (!/#grid td\.col-no, #grid td\.col-nick\s*\{[^}]*position:\s*sticky/s.test(css))
    throw new Error("单元格 col-no/col-nick 没有 sticky")
  if (!/#grid td\.col-nick\s*\{\s*left:\s*62px/s.test(css))
    throw new Error("普通成员的群昵称列不是 left: 62px")
  if (!/body\.can-call #grid td\.col-nick\s*\{\s*left:\s*134px/s.test(css))
    throw new Error("管理员的群昵称列不是 left: 134px（序号 62 + 呼叫 72）")
  if (!/#grid td\.col-nick\s*\{\s*position:\s*static/s.test(css))
    throw new Error("手机端没有关闭群昵称冻结")
})

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
   * （主人 2026-10-05 要求：这三列在 PC 上左对齐；表头与药丸都不该再被这条媒体查询抓去居中）
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
  if (/top:\s*calc\(100%/.test(rule)) throw new Error("`.picker` 还在用贴合单元格的 top（浮层位置必须由 placePicker() 算）")
  if (css.includes(".picker.up")) throw new Error("`.picker` 还在用翻转让位写法——位置必须由 placePicker() 算，CSS 不写 top/bottom")
  /** 裁切祖先还在（这就是必须固定定位的原因）；哪天没有了，这一条可以放宽 */
  if (!/\.wrap\s*\{[^}]*overflow:\s*auto/s.test(css)) throw new Error("`.wrap` 不裁切了？那这条约束要跟着复核")
  if (!/\.panel\s*\{[^}]*overflow:\s*hidden/s.test(css)) throw new Error("`.panel` 不裁切了？那这条约束要跟着复核")

  /**
   * 滚动只发生在候选那一层，底部「＋ 收录新名字」常驻浮层底部
   *
   * 底行要是跟着候选一起被 `max-height` 裁（它以前就是 `.picker` 的最后一个子节点），
   * 候选一多就落到浮层可见区域之外：实测 10 个候选 + 底行自然高 449px、浮层上限 220px 时，
   * 底行量到 top 650 而浮层只到 464 —— 主人点不到「收录」。
   */
  if (!/\.picker\s*\{[^}]*overflow:\s*hidden/s.test(css))
    throw new Error("`.picker` 又是自己滚了：底部的「＋ 收录新名字」会跟着候选一起被裁")
  if (!/\.picker\s+\.opts\s*\{[^}]*overflow:\s*auto/s.test(css))
    throw new Error("缺少 `.picker .opts { overflow: auto }`（候选那一层没有自己的滚动区）")

  /**
   * 坐标得真有人算：浮层靠 `placePickerAt(td, picker)` 摆位（胶囊格的 `placePicker()` 与群昵称的
   * 候选下拉都转调它），不靠 CSS 里相对单元格的 top/bottom。
   */
  const script = read("editor/editor.html")
  if (!/function placePickerAt\(td, picker\)/.test(script)) throw new Error("找不到 placePickerAt()：浮层的坐标没人算了")
  if (!/const placePicker = \(\) => placePickerAt\(td, picker\)/.test(script))
    throw new Error("胶囊格的 placePicker() 没有转调 placePickerAt()")
  for (const prop of ["style.left", "style.top", "style.bottom", "style.maxHeight"])
    if (!script.includes(prop)) throw new Error(`placePickerAt() 没算 ${prop}`)
  /** 上面那条 CSS 要是没人在浮层里造出 `.opts`，就只是条空规则（底行照样跟候选一起滚） */
  if (!/optsBox\.className = 'opts'/.test(script)) throw new Error("浮层里没有造出 `.opts` 那一层（`.picker .opts` 成了空规则）")
})

check("编辑器：枪战版本表读当前榜 options.attackVersions，不读顶层", () => {
  const script = read("editor/editor.html")
  const block = script.match(/const attackVersionRows = \(\) => \{[\s\S]{0,400}?\n      \}/)?.[0] ?? ""
  if (!block.includes("sheet()?.options?.attackVersions"))
    throw new Error("attackVersionRows() 没有读当前榜的 options.attackVersions（会永远落到旧 fallback）")
  if (block.includes("data.attackVersions"))
    throw new Error("attackVersionRows() 又在读顶层 data.attackVersions；/api/data 把它放在每个榜的 options 里")
})

check("群昵称列按当前最长名字收放，不再写死 170/150px", () => {
  const script = read("editor/editor.html")
  if (!/function fitTableColumns\(\)/.test(script)) throw new Error("找不到 fitTableColumns()")
  if (!script.includes("--nick-w")) throw new Error("列宽没有写回 --nick-w")
  if (!script.includes("--status-w")) throw new Error("完成情况列没有写回 --status-w")
  for (const fallback of ["var(--nick-w, 170px)", "var(--nick-w, 150px)", "var(--status-w, 280px)"]) {
    if (!script.includes(fallback)) throw new Error(`缺少 ${fallback}`)
  }
  if (!/grid\.oninput\s*=/.test(script)) throw new Error("输入群昵称时没有重新量宽")
  if (!/td\.col-status/.test(script)) throw new Error("完成情况格没有 col-status 标记")
})

check("完成情况多选列：胶囊保持单行，列宽由 --status-w 收放", () => {
  const css = cssOf(read("editor/editor.html"))
  const rule = css.match(/\.chips\s*\{[^}]*\}/s)?.[0] ?? ""
  if (!rule) throw new Error("找不到 .chips 规则")
  if (!/flex-wrap:\s*nowrap/.test(rule)) throw new Error(".chips 不应再换行：会把行高撑乱")
  if (/overflow-x:\s*auto/.test(rule)) throw new Error(".chips 又横向滚动了：列宽应由 --status-w 保证")
})

check("主播区呼叫按钮恢复为「呼叫TA」", () => {
  const script = read("editor/editor.html")
  const hits = script.match(/callBtn\.textContent = '呼叫TA'/g) ?? []
  if (hits.length < 2) throw new Error(`只找到 ${hits.length} 处「呼叫TA」按钮`)
})

check("主播排队人数在名字右侧，用状态胶囊而不是名字下方小字", () => {
  const script = read("editor/editor.html")
  const css = cssOf(script)
  if (!/\.anchor-name-cell\s*\{[^}]*display:\s*(flex|grid)/s.test(css))
    throw new Error("主播名字格没有改成 flex/grid 行")
  if (!/\.anchor-name-cell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*var\(--anchor-name-w\)\)/s.test(css))
    throw new Error("主播名字格没有与表头共用 --anchor-name-w 名称列")
  if (!script.includes("td.classList.add('anchor-name-cell')"))
    throw new Error("主播名字格没有 anchor-name-cell")
  if (!/function anchorQueuePillsOf\(/.test(script))
    throw new Error("没有旧服务端字段的 queuePills 兜底")
  if (!/function anchorPillsEl\(/.test(script))
    throw new Error("没有统一的 anchor-pills 容器")
  if (!script.includes("anchorPillsEl(values)"))
    throw new Error("可编辑分支没有使用统一胶囊容器")
  if (!script.includes("anchorPillsEl(a)"))
    throw new Error("只读分支没有使用统一胶囊容器")
  if (script.includes("for (const queuePill of anchorQueuePillsOf("))
    throw new Error("主播名格仍有旧的裸胶囊循环，未走统一 anchor-pills 容器")
  if (!script.includes("isPublic"))
    throw new Error("没有公共队列行")
  if (!script.includes("公共队列"))
    throw new Error("公共队列名称缺失")
  if (script.includes("q.className = 'anchor-queue'"))
    throw new Error("旧的 anchor-queue 下方小字仍在")
})

check("公共队列表头：无主播星号，主播/公共队列与计数胶囊同一行且同尺寸", () => {
  const script = read("editor/editor.html")
  const css = cssOf(script)
  if (script.includes("req-star")) throw new Error("主播表头仍带星号")
  if (!script.includes("anchor-head-public")) throw new Error("公共队列表头缺失")
  if (!script.includes("anchor-head-title")) throw new Error("主播名与公共队列没有同排容器")
  const line = css.match(/\.anchor-head-public\s*\{[^}]*\}/s)?.[0] ?? ""
  if (!/display:\s*(flex|grid)/.test(line)) throw new Error("公共队列行没有 flex/grid 对齐")
  if (!/grid-template-columns:\s*minmax\(0,\s*var\(--anchor-name-w\)\)/.test(line))
    throw new Error("公共队列行没有与主播行共用 --anchor-name-w 名称列")
  if (/margin-top:\s*5px/.test(line)) throw new Error("公共队列仍被拆到第二行")
  const pill = css.match(/\.anchor-head-public\s+\.pill\s*\{[^}]*\}/s)?.[0] ?? ""
  if (!/padding:\s*3px 7px/.test(pill)) throw new Error("公共队列胶囊 padding 与行内不一致")
  if (!/font-size:\s*12px/.test(pill)) throw new Error("公共队列胶囊字号与行内不一致")
})

check("编辑器浮层打开时抬高宿主单元格，避免被 sticky 表头/表格压住", () => {
  const script = read("editor/editor.html")
  const css = cssOf(script)
  if (!/#grid td\.picking\s*\{[^}]*z-index:\s*(?:[6-9]\d|\d{3,})/s.test(css))
    throw new Error("浮层打开时没有抬高宿主单元格，候选会被 sticky 表头/表格数据压住")
  if (!script.includes("classList.add('picking')")) throw new Error("打开浮层时没有给宿主单元格加 picking")
  if (!script.includes("classList?.remove('picking')")) throw new Error("收起浮层时没有移除 picking")
})

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
