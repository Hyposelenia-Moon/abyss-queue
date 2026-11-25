/**
 * 版式契约：表格的列对齐（文本列左、状态/数字列居中、**表头跟着内容走**）
 *
 * 这套规则是照着群里的出图定的（三张渲染图 + 编辑器用同一套）：
 *   文本列（榜单 / 成员 / 昵称 / 游戏名 / 主播 / 备注 / 强项 / 入口）表头与内容都左对齐，
 *   状态与数字列（序号 / 人数 / 完成情况 / 推荐度 / 操作）表头与内容都居中。
 * 它最容易被后来改模板的人带偏（表头又变回一律居中、加了状态列忘了居中），所以在这里钉住：
 *   - 三张渲染模板：thead th 默认左对齐；状态/数字列的表头带 class="num"（CSS 里居中），
 *     同一列单元格的 class 在 CSS 里也是 text-align: center，且**没有多出来的 num 表头**
 *   - 编辑器主表（PC）：难度 / 帮帮完成情况 两列的表头与药丸居中，操作列居中
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
  for (const label of ["选择主播", "完成情况", "主播开播状态"])
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

/**
 * 编辑器主表：列语义、长名字不省略号、手机端有编辑抽屉
 *
 * 这条原来是按旧表格（`<table>` + `th.col-no` sticky 冻结 + 134px 偏移）钉的。
 * 2026-11 九页重写后主表改成 `display:grid` 的 `.tr`（没有 `<table>`，也就没有 sticky 冻结这回事），
 * 于是判据换成**新实现真正要守的三件事**：
 *   - 序号列有语义类且**右对齐**（数字贴向群昵称，维护者 m11932 的要求：间距从 50px 收到 6px）
 *   - 长名字**不省略号**（维护者 m10283：不许出现 `…`，特殊情况换行）——可编辑格是 `textarea`
 *   - 手机端有自己的编辑抽屉（`#msheet` + `openMobile()`），不再靠点击单元格
 * 「冻结列」本身已随旧实现退场：新的滚动单位是整张卡，列宽由 `--cols` 分配。
 */
check("编辑器主表：序号列右对齐、长名字不省略号、手机端有编辑抽屉", () => {
  const html = read("editor/editor.html")
  const css = cssOf(html)

  /** 序号列：grid 的第一个 span，语义类 `.seqcell`，数字右对齐 */
  if (!html.includes('class="seqcell num"')) throw new Error("序号单元格没有 seqcell 语义类")
  if (!/\.tr>span\.seqcell\s*\{[^}]*text-align:\s*right/s.test(css))
    throw new Error("序号列不是右对齐（数字离群昵称太远）")
  if (!/\.tr\.hd>span\.h0\s*\{[^}]*text-align:\s*right/s.test(css))
    throw new Error("「序号」表头没跟正文一起右对齐")

  /**
   * 长名字：全页**不许**出现 `text-overflow: ellipsis`（维护者明确要求避免 `…`）。
   * 可编辑的那三列要用 `textarea` 才能自动撑高，`<input>` 里长值会被截断（实测过）。
   */
  if (/text-overflow:\s*ellipsis/.test(css)) throw new Error("页面里还有 text-overflow: ellipsis：长名字会被截成「…」")
  if (!/\.cellinput\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(css))
    throw new Error("可编辑单元格没有 overflow-wrap: anywhere（超长名字会撑破列宽）")
  const inputs = (html.match(/<input[^>]*data-edit=/g) ?? []).length
  if (inputs) throw new Error(`可编辑格还在用 <input>（长值截断，共 ${inputs} 处），要换 textarea.cellinput`)
  for (const key of ["nickname", "gameName", "note"])
    if (!new RegExp(`<textarea[^>]*data-edit="${key}"`).test(html)) throw new Error(`「${key}」不是 textarea 单元格`)

  /** 手机端：`#msheet` 抽屉 + `openMobile()` 入口，行内那颗「编辑」按钮 */
  if (!/id="msheet"/.test(html) || !/id="msBody"/.test(html)) throw new Error("手机端缺少底部编辑抽屉的容器")
  if (!/function openMobile\(/.test(html)) throw new Error("手机端没有 openMobile()（抽屉打不开）")
  if (!/\.medit\s*\{/.test(css) || !/data-medit=/.test(html)) throw new Error("手机端紧凑列表没有「编辑」入口")
  if (!/body\.fillmode|@media \(max-width:\s*820px\)/s.test(css)) throw new Error("没有手机端（≤820px）的布局覆盖")
})

/**
 * 编辑器主表：表头与正文同列、药丸列/备注列左对齐、序号与呼叫列各有自己的对齐
 *
 * 旧实现是 `<table>` + `th/td:nth-child(n)`，靠 `@media (min-width: 821px)` 覆盖 `nth-child(5)/(7)/(9)`。
 * 九页重写后表头是 `.tr.hd > span.h0..h7`、正文是 `.tr > span`，两套对齐都写在 grid 单元上，
 * 不再有 `nth-child`。这里守的还是**同一批意图**：
 *   - 药丸列（难度及目标）与备注列**左对齐**，不居中
 *   - 序号列右对齐（贴向群昵称）、呼叫列贴左（用户 m12861：状态与呼叫之间不要留白）
 *   - 表头与正文左边界必须一致（曾经表头整体左移 8px，实测 8 列全差 8px）
 */
check("编辑器主表：表头与正文同列、药丸列左对齐、序号右对齐、呼叫贴左", () => {
  const html = read("editor/editor.html")
  const css = cssOf(html)

  if (!/\.tr\.hd\s*\{[^}]*font-size:\s*calc\(var\(--fs\)\s*-\s*2px\)/s.test(css))
    throw new Error("表头字号没跟正文挂钩（原来写死 13px，比正文小 4px）")
  if (!/\.tr\.hd>span\.h0\s*\{[^}]*text-align:\s*right/s.test(css))
    throw new Error("「序号」表头没有跟序号列一起右对齐")
  if (!/\.tr>span\.seqcell\s*\{[^}]*text-align:\s*right/s.test(css))
    throw new Error("序号列不是右对齐（数字离群昵称太远）")
  if (!/\.callcell\s*\{[^}]*justify-content:\s*flex-start/s.test(css))
    throw new Error("呼叫列没有贴左：状态列与呼叫按钮之间会空一大块")
  if (!/\.tr\.hd>span\.h7\s*\{[^}]*text-align:\s*left/s.test(css))
    throw new Error("「呼叫」表头与按钮没对齐")

  /** 药丸列与备注列：都不该出现居中（居中会让长短胶囊参差） */
  const goalRule = css.match(/\.goalcell\s*\{[^}]*\}/s)?.[0] ?? ""
  if (/text-align:\s*center/.test(goalRule)) throw new Error("难度及目标列被居中了，要左对齐")
  const noteRule = css.match(/\.tr>span\.note\s*\{[^}]*\}/s)?.[0] ?? ""
  if (/text-align:\s*center/.test(noteRule)) throw new Error("备注列被居中了，要左对齐")
})

/** 下拉浮层：固定定位 + JS 按按钮坐标摆位（`place()` 里已用 pageZoom() 归一，大屏 zoom 下不偏） */
check("编辑器下拉浮层：固定定位 + JS 算坐标（绝对定位会被裁成一条白边）", () => {
  const html = read("editor/editor.html")
  const css = cssOf(html)
  const rule = css.match(/\.pk\s*\{[^}]*\}/s)?.[0] ?? ""
  if (!rule) throw new Error("找不到 `.pk` 的样式规则")
  if (!/position:\s*fixed/.test(rule))
    throw new Error(
      "`.pk` 不是固定定位。表格卡 `.tablecard{overflow:hidden}` 会把绝对定位的浮层裁掉：" +
        "单行表格时单元格贴着容器下沿，浮层只剩一条可见（现场就是「点开只有一个空白小条」）",
    )
  if (/position:\s*absolute/.test(rule)) throw new Error("`.pk` 又变回绝对定位了（会被就地裁掉）")
  if (/top:\s*calc\(100%/.test(rule)) throw new Error("`.pk` 还在用贴合单元格的 top（浮层位置必须由 place() 算）")

  /** 候选那一层自己滚，浮层本身不滚（否则常驻的「＋ 收录新名字」会跟着被裁） */
  if (!/\.pk\s+\.opts\s*\{[^}]*overflow:\s*auto/s.test(css))
    throw new Error("缺少 `.pk .opts { overflow: auto }`（候选那一层没有自己的滚动区）")

  /**
   * 坐标得真有人算，而且必须在 zoom 页面上归一：
   * `html{zoom:1.3333}` 时 `getBoundingClientRect()` 返回缩放后坐标，而 `position:fixed` 的
   * `style.left/top` 按布局像素解释 —— 不除 zoom 就整体偏 1.333 倍（实测菜单跑到 left 1317 应是 988）。
   */
  if (!/function place\(host,\s*btn\)/.test(html)) throw new Error("找不到 place()：浮层的坐标没人算了")
  if (!/function pageZoom\(\)/.test(html)) throw new Error("没有 pageZoom()：大屏 zoom 下浮层会错位")
  const placeAt = html.indexOf("function place(host, btn)")
  const placeBody = placeAt < 0 ? "" : html.slice(placeAt, placeAt + 900)
  if (!/getBoundingClientRect\(\)/.test(placeBody)) throw new Error("place() 没有量按钮位置")
  if (!/pageZoom\(\)/.test(placeBody)) throw new Error("place() 没把 zoom 算进去（大屏必偏）")
  for (const prop of ["style.left", "style.top"])
    if (!placeBody.includes(prop)) throw new Error(`place() 没算 ${prop}`)
})

/** 攻炼版本表读当前榜 options.attackVersions，并按版本号排序（用户 m12484「顺序归一」） */
check("编辑器：攻炼版本表读当前榜 options.attackVersions，且按版本号排序", () => {
  const script = read("editor/editor.html")
  const at = script.indexOf("function attackVersionRows()")
  if (at < 0) throw new Error("找不到 attackVersionRows()")
  const block = script.slice(at, at + 900)
  if (!block.includes("options") || !block.includes("attackVersions"))
    throw new Error("attackVersionRows() 没有读当前榜的 options.attackVersions（会永远落到旧 fallback）")
  if (block.includes("data.attackVersions"))
    throw new Error("attackVersionRows() 又在读顶层 data.attackVersions；/api/data 把它放在每个榜的 options 里")
  if (!/byVersion/.test(block)) throw new Error("attackVersionRows() 没有按版本号排序（会出现 7.3/7.2模式）")
})

/**
 * 状态列按榜分宽：剧诗/危战/螺旋只需要一颗胶囊，攻炼要放多段复合状态
 * （`7.2排队中 7.3等待开启`）。列宽由 `.tablecard` 上的 `--status-w` 收放，
 * **必须挂在 `.tablecard` 而不是 `:root`** —— CSS `var()` 在声明处展开，写 `:root` 就快照住抓不到了。
 */
check("排队状态列按榜分宽：--status-w 挂在 .tablecard 上，攻炼单独放宽", () => {
  const html = read("editor/editor.html")
  const css = cssOf(html)
  const card = css.match(/\.tablecard\s*\{[^}]*\}/s)?.[0] ?? ""
  if (!card) throw new Error("找不到 .tablecard 规则")
  if (!/--status-w:/.test(card)) throw new Error("--status-w 没挂在 .tablecard 上（写 :root 会快照住，按榜改不动）")
  const rootRule = css.match(/:root\s*\{[^}]*\}/s)?.[0] ?? ""
  if (/--cols:/.test(rootRule))
    throw new Error("--cols 又回到 :root 了：里面的 var(--status-w) 会在 :root 展开，按榜分宽失效")
  if (!/body\.attack-sheet\s+\.tablecard\s*\{[^}]*--status-w/s.test(css))
    throw new Error("攻炼没单独放宽 --status-w（多段复合状态会被挤成竖条）")
  if (!/classList\.toggle\(\s*['"]attack-sheet['"]/.test(html)) throw new Error("没有按榜名切 attack-sheet 关类")
})

/** 主播卡：五列网格、星级、公共队列单独标记、公共队列卡不显示呼叫 */
check("主播区卡片：星级、完成情况，公共队列单独标记且不显示呼叫", () => {
  const script = read("editor/editor.html")
  const css = cssOf(script)
  if (!/\.acards\s*\{[^}]*grid-template-columns:\s*repeat\(5/s.test(css))
    throw new Error("主播卡片不是五列网格")
  if (!/\.acard\s*\{/.test(css)) throw new Error("缺少主播卡片样式")
  if (!/function anchorListHTML\(/.test(script)) throw new Error("没有主播卡片构建函数")
  if (!/(?:function|const)\s+starsOf\s*[=(]/.test(script)) throw new Error("没有星级换算（推荐度 → ★）")
  if (!script.includes("isPublic")) throw new Error("没有公共队列标记")
  /** 卡片上显示的是「公共队」角标（原来断言「公共队列」，那是旧文案） */
  if (!script.includes("公共队")) throw new Error("公共队列角标缺失")
  if (!/\.acard\.pub\s+\.acall\s*\{[^}]*visibility:\s*hidden/s.test(css))
    throw new Error("公共队列卡没有隐藏呼叫按钮")
  if (script.includes("req-star")) throw new Error("主播卡仍带必填星号")
})

/**
 * 呼叫按钮点下去要有回执（维护者 2026-11-25）
 *
 * 静态契约只查 CSS 那半：按下有 `:active` 的位移、松开有 `transition` 回来；
 * ".called"（发出后短暂变蓝）由 `editor/test/anchor-add.test.mjs` 的动态断言守住。
 */
check("呼叫按钮点下去有看得见的回执（:active + transition + .called）", () => {
  const script = read("editor/editor.html")
  const css = cssOf(script)
  const callbtn = css.match(/\.callbtn\s*\{[^}]*\}/s)?.[0] ?? ""
  if (!callbtn) throw new Error("找不到 .callbtn 规则")
  if (!/transition:[^;}]*transform/s.test(callbtn)) throw new Error("呼叫按钮没有 transition（按下/松开是硬跳）")
  if (!/\.callbtn:active\s*\{[^}]*transform:/s.test(css)) throw new Error("呼叫按钮没有 :active 的按下位移")
  if (!/\.acall:active\s*(?:,[^{]*)?\{[^}]*transform:/s.test(css)) throw new Error("主播卡呼叫按钮没有 :active 的按下位移")
  if (!/\.(?:callbtn|acall)\.called\s*[,{]/.test(css)) throw new Error("没有「已发出」的 .called 样式")
  if (!/classList\.add\(\s*['"]called['"]/.test(script)) throw new Error("页面没有在发出后加 .called")
})

/**
 * 手机档填写页头：「榜名 + 上次保存」竖排
 *
 * 维护者 2026-11-26 截图：手机（390 CSS 宽）上「幻想真境剧诗」被右侧「上次保存 2026/11/26 01:57:02」
 * 挤成「幻想真境剧 / 诗」两行。`.fillhead` 是并排的，那串时间占掉 ~150px，34px 的 6 字榜名只剩
 * 不到 200px ⇒ 必断。窄屏要改成竖排、榜名收小、时间贴左，和榜名成一组。
 */
check("手机档填写页头竖排（榜名不被「上次保存」挤断）", () => {
  const html = read("editor/editor.html")
  const css = cssOf(html)
  const at = css.indexOf("@media (max-width:1100px)")
  if (at < 0) throw new Error("找不到手机档（≤1100px）的样式块")
  const mob = css.slice(at)
  if (!/\.fillhead\s*\{[^}]*flex-direction:\s*column/s.test(mob))
    throw new Error("手机档 .fillhead 还是并排：右侧那串时间会把长榜名挤成两行")
  if (!/\.fillhead h1\s*\{[^}]*font-size:\s*26px/s.test(mob))
    throw new Error("手机档榜名没缩到 26px（34px 的 6 字榜名在 390 宽下仍会断行）")
  if (!/\.fillhead \.saved\s*\{[^}]*text-align:\s*left/s.test(mob))
    throw new Error("手机档「上次保存」还是右对齐：竖排后要贴左才跟榜名成一组")
})

/* 以下旧断言已随 2026-11 九页重写退场（原 292–400 行）：
 *   - 编辑器下拉浮层：走 .picker + placePickerAt(td,picker) + optsBox.className='opts'
 *     → 新实现是 .pk + place(host,btn) + pageZoom()，断言已按新实现重写在上方
 *   - 枪战版本表：const attackVersionRows = () => {...sheet()?.options?.attackVersions}
 *     → 函数已改成 function attackVersionRows()，断言按新签名重写在上方
 *   - 群昵称列 fitTableColumns()/--nick-w、.chips 单行 --status-w
 *     → 列宽改由 .tablecard 的 --cols 比例列分配，fitTableColumns 不存在了
 *   - 主播区「呼叫TA」按钮、buildAnchorCards/anchorQueuePillsOf/.acard-h/req-star
 *     → 卡片改成 anchorListHTML()/starsOf()，按钮文案是「呼叫」（不是「呼叫TA」）
 *   - 编辑浮层抬高宿主单元格（#grid td.picking + z-index）
 *     → 主表不再是 table，浮层是 fixed 单例，无需抬高单元格
 */

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
