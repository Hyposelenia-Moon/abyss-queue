/**
 * 锅巴接入回归：三段式配置的渲染契约 + schema 与配置键的一致性
 *
 * 这一套钉的是**锅巴保存那条路**（读 `defSet/config.yaml` 模板 → 替换 `${变量}` → 写运行时
 * `config/config.yaml`）。它是三段式里最容易写坏的一环：
 *   - 变量名漏一个 → 那份配置里留一个 `${...}`，YAML 解析出一串怪字；
 *   - 值的序列化不对 → 含 `#`、`:`、引号、逗号、换行的值会把 YAML 结构写坏；
 *   - 三份文件结构漂移 → 面板显示的键与默认值/参考文件对不上。
 *
 * 所以这里做**真往返**：填一批刁钻的值 → 渲染 → 用 YAML 解析回来 → 逐个比对值与类型。
 * 用例：node test/guoba.test.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
/* 隔离配置必须最先就位（ESM 静态 import 先于顶层代码执行） */
import { ensureEnv } from "./env.mjs"
import { createChecker, Paths } from "./_helper.mjs"

/** 路径比较：解析后逐字符比（Windows 上大小写不敏感，这里只用于"是不是同一个位置"） */
const same = (a, b) => path.resolve(String(a)) === path.resolve(String(b))
const wait = ms => new Promise(r => setTimeout(r, ms))

/** 先备好隔离环境（配置写进临时目录），再 import 插件代码 */
const ENV = await ensureEnv({ prefix: "abyss-guoba-" })

const { CONFIG_FIELDS, CROSS_LAYER_FIELDS, DEFAULT_CONFIG, config, defSetPath, fieldToVar, renderDefSet, readField, yamlValue } =
  await import("../components/config.js")
const { supportGuoba } = await import("../guoba.support.js")
const { check, finish } = createChecker("锅巴三段式配置")

const examplePath = path.join(Paths.root, "config", "config.yaml.example")
const exampleText = fs.readFileSync(examplePath, "utf8")
const example = YAML.parse(exampleText)
const template = fs.readFileSync(defSetPath, "utf8")

/**
 * 比结构用**顶层键** + **逐字段可取**
 *
 * 不做深度平铺：`.example` 会给 `anchor_aliases` 带两条别名示例、默认值里是空映射，
 * 深度比会把"示例内容多寡"误判成"结构不同"。真正要防的是：
 * 少一个配置键、或者某份文件里那个键根本读不出来。
 */
const topKeys = obj => Object.keys(obj).sort()

/** config 是加载后的对象，含派生键（落点 / 表路径）——它们不是配置项，比结构时要排掉 */
const DERIVED_KEYS = ["storePath", "notifyStatePath", "backupDir", "xlsxPath"]
const defaultsOnly = Object.fromEntries(Object.entries(config).filter(([k]) => !DERIVED_KEYS.includes(k)))

console.log(`模板：${defSetPath}\n参考：${examplePath}\n隔离配置：${ENV.config}\n`)

/* ------------------------------ 用例 ------------------------------ */

console.log("【1】defSet 模板的占位符与 CONFIG_FIELDS 一一对应")
{
  const missing = CONFIG_FIELDS.filter(field => !template.includes(`\${${fieldToVar(field)}}`))
  check(`${CONFIG_FIELDS.length} 个配置键都有 \${变量}`, () => {
    if (missing.length) throw new Error(`缺占位符：${missing.map(f => `${f} → \${${fieldToVar(f)}}`).join("、")}`)
  })
  check("模板里没有多余的同名占位符（拼错的变量会被这里逮到）", () => {
    const declared = new Set(CONFIG_FIELDS.map(fieldToVar))
    const used = [...template.matchAll(/\$\{([a-z_]+)\}/g)].map(m => m[1])
    const extra = used.filter(v => !declared.has(v))
    if (extra.length) throw new Error(`模板里有未声明的占位符：${extra.join("、")}`)
  })
}

console.log("\n【2】三段式的键结构一致（默认值渲染结果 = .example = DEFAULT_CONFIG）")
{
  const rendered = YAML.parse(renderDefSet({}))
  /**
   * **把"值的写法"剥掉之后，模板与参考文件必须逐行相同**
   *
   * 判据：去掉注释、去掉冒号后的值，只留「缩进 + 键 + 注释骨架」。
   * 这样"行内空格的多少""示例值带不带引号"不会误报，而
   * 「模板里少一段注释」「参考文件里多一个键」「层级写错」都会立刻红。
   */
  const shape = text =>
    text
      .split("\n")
      .map(l => l.replace(/#.*$/, "").trimEnd())
      .map(l => l.replace(/^(.*?:\s*).*$/, "$1").trimEnd())
      .join("\n")
  check("模板与参考文件的「注释 + 键」骨架逐行相同（三份同构的骨架闸）", () => {
    const t = shape(template).split("\n")
    const e = shape(exampleText).split("\n")
    const bad = []
    for (let i = 0; i < Math.max(t.length, e.length); i++)
      if (t[i] !== e[i]) bad.push(`行 ${i + 1}：模板 ${JSON.stringify(t[i])} · 参考 ${JSON.stringify(e[i])}`)
    if (bad.length) throw new Error(`骨架漂了 ${bad.length} 行：\n  ${bad.slice(0, 8).join("\n  ")}`)
  })
  check("全默认值渲染后与 config.yaml.example 的顶层键一致", () => {
    const a = topKeys(rendered).join(", ")
    const b = topKeys(example).join(", ")
    if (a !== b) throw new Error(`\n  渲染：${a}\n  参考：${b}`)
  })
  check("与 DEFAULT_CONFIG 的顶层配置键一致", () => {
    const renderedOwn = topKeys(rendered)
    const defaults = topKeys(defaultsOnly)
    const onlyInRendered = renderedOwn.filter(k => !defaults.includes(k))
    const onlyInDefaults = defaults.filter(k => !renderedOwn.includes(k))
    if (onlyInRendered.length || onlyInDefaults.length)
      throw new Error(
        `\n  渲染独有：${onlyInRendered.join(", ") || "（无）"}\n  默认值独有：${onlyInDefaults.join(", ") || "（无）"}`,
      )
  })
  check("每个配置键在三份文件里都读得出来（不缺键、不写错层级）", () => {
    const bad = []
    for (const field of CONFIG_FIELDS) {
      if (readField(rendered, field) === undefined) bad.push(`渲染缺 ${field}`)
      if (readField(example, field) === undefined) bad.push(`.example 缺 ${field}`)
      if (readField(defaultsOnly, field) === undefined) bad.push(`默认值缺 ${field}`)
    }
    if (bad.length) throw new Error(bad.join("、"))
  })
  check("跨层键 footer.html 也有默认值（三份同构的前提：模板里每个占位符都要有来源）", () => {
    const missing = CONFIG_FIELDS.filter(f => readField(DEFAULT_CONFIG, f) === undefined)
    if (missing.length) throw new Error(`没有默认值的键：${missing.join("、")}`)
    /** 编辑器并排部署时读不到插件配置，所以它自己那份默认值必须与插件这份逐字相同 */
    const editorDefault = fs.readFileSync(path.join(Paths.root, "editor", "config.js"), "utf8")
    const html = readField(DEFAULT_CONFIG, "footer.html")
    if (CROSS_LAYER_FIELDS.includes("footer.html") && !editorDefault.includes(html))
      throw new Error("editor/config.js 的 DEFAULTS.footerHtml 与 DEFAULT_CONFIG.footer.html 不是同一份")
  })
}

console.log("\n【3】往返：刁钻的值渲染后解析回来，值与类型都对")
{
  const tricky = {
    "remote.url": "https://yunzai.axiu.uno/queue",
    /** 含 @ : # " 和空格：JSON.stringify 那条路的边界 */
    "remote.token": 'p@ss:word #tag "quoted"',
    "remote.sign_key": "0123456789abcdef0123456789abcdef",
    "remote.short_link": false,
    "remote.link_markdown": true,
    "roster.group": "123456789",
    "notify.enable": true,
    "notify.groups": [111111111, 222222222],
    "notify.cron": "*/3 * * * *",
    "notify.monthly_enable": false,
    "notify.monthly_at": "12:00",
    "remote.ttl_ms": 30000,
    "remote.timeout_ms": 15000,
    "remote.autostart": "D:/Yunzai/plugins/abyss-queue/data/自定义启动脚本.cmd",
    default_sheet: "幽境危战",
    /** 0 有真实语义（= 全部），不能被当成空值丢掉 */
    list_limit: 0,
    render_max: 40,
    render_image: true,
    render_scale: 2,
    /** 子表：面板上是"一行一个主播"，写下去是映射 */
    anchor_aliases: { 阿修Axiu: ["阿修"], 摸头妹: ["璃月第一深情"] },
    /** 多行 HTML：必须仍是单行 YAML 标量，解析回来还是多行 */
    "footer.html":
      '<div>© 2026 <a href="https://github.com/Hyposelenia-Moon">缄月</a> &amp; <a href="https://github.com/AxiuCN">阿修Axiu</a></div>\n<div>京ICP备2026xxxxxx号-1</div>',
    "snapshot_backup.enable": true,
  }
  const text = renderDefSet(tricky)
  const back = YAML.parse(text)
  for (const [field, want] of Object.entries(tricky))
    check(`${field} = ${JSON.stringify(want).slice(0, 44)}`, () => {
      const got = readField(back, field)
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`实得 ${JSON.stringify(got)}`)
    })

  check("跑完仍能落盘 + 读回（不是只在内存里成立）", () => {
    const file = path.join(ENV.dir, "config.yaml")
    fs.writeFileSync(file, text, "utf8")
    const again = YAML.parse(fs.readFileSync(file, "utf8"))
    if (JSON.stringify(readField(again, "notify.groups")) !== JSON.stringify([111111111, 222222222]))
      throw new Error("读回来的 notify.groups 不对")
  })
}

console.log("\n【4】注释按模板保留（不走 YAML.stringify 整写）")
{
  const text = renderDefSet({})
  check("文件头注释在", () => {
    if (!text.includes("# 三路深渊排队插件配置")) throw new Error("丢了文件头注释")
  })
  check("「数据落点不可配置」那节注释在", () => {
    if (!text.includes("数据落点：**不可配置**")) throw new Error("丢了数据落点那节注释")
  })
  check("解释性注释仍在（逐项说明没被抹掉）", () => {
    if (!text.match(/# .*身份签名密钥/)) throw new Error("丢了签名密钥那段说明")
  })
}

console.log("\n【5】锅巴 schema 的契约")
{
  const support = supportGuoba()
  check("pluginInfo 必备字段齐备", () => {
    for (const k of ["name", "title", "description", "author", "link", "isV3"])
      if (!support.pluginInfo?.[k]) throw new Error(`pluginInfo 缺 ${k}`)
  })
  check("pluginInfo.name 与插件目录名一致（锅巴按它路由 /api/plugin/s/<name>/icon）", () => {
    if (support.pluginInfo.name !== path.basename(Paths.root)) throw new Error(support.pluginInfo.name)
  })
  check("图标是**实际存在的文件**（锅巴直接 res.sendFile，路径错了面板就没图标）", () => {
    const icon = support.pluginInfo.iconPath
    if (!icon) throw new Error("没配 iconPath")
    if (!fs.existsSync(icon)) throw new Error(`文件不存在：${icon}`)
  })

  const schemas = support.configInfo?.schemas ?? []
  check("schema 非空且有大 label 分组", () => {
    if (!schemas.some(s => s.component === "SOFT_GROUP_BEGIN")) throw new Error("没有 SOFT_GROUP_BEGIN 分组")
  })
  /**
   * 面板字段要么是**配置路径**（在 CONFIG_FIELDS 里），要么是**面板专用名**：
   * 别名子表（存储是"正名→别名"映射，面板上是"一行一个主播"的数组）与告警横幅
   * （`config.yaml` 读不出来时才出现，见【8】组）。面板专用名必须**不与任何配置路径撞名**。
   */
  const UI_ONLY_FIELDS = ["anchor_aliases_list", "_panel_warning"]
  const fieldItems = schemas.filter(s => s.field)
  check(`${fieldItems.length} 个字段要么是配置路径、要么是登记过的面板专用名`, () => {
    const bad = fieldItems
      .map(s => s.field)
      .filter(f => !CONFIG_FIELDS.includes(f) && !UI_ONLY_FIELDS.includes(f))
    if (bad.length) throw new Error(`既不在 CONFIG_FIELDS、也没登记为面板专用：${bad.join("、")}`)
  })
  check("面板专用名不与配置路径撞名", () => {
    const clash = UI_ONLY_FIELDS.filter(f => CONFIG_FIELDS.includes(f))
    if (clash.length) throw new Error(clash.join("、"))
  })
  check("每个 field 都有 label 与 component", () => {
    const bad = schemas.filter(s => s.field && (!s.label || !s.component)).map(s => s.field)
    if (bad.length) throw new Error(`缺 label/component：${bad.join("、")}`)
  })

  /**
   * **组件名必须是锅巴真的注册过的**
   *
   * 写错不会报任何错：锅巴前端查它的组件表（`componentMap.get(component)`），查不到就把那一格
   * 渲染成一句"未知的组件"——面板上多一个永远显示不出内容的框，而所有人都以为配好了。
   * 事故：告警横幅曾写成 `Alert`，锅巴根本没有这种纯展示组件。
   *
   * 这份名单读自 `guoba-plugin/server/static/assets/`（`BasicForm...js` 的注册表 + `index.js` 里
   * 锅巴自己追加的四个），**锅巴升级后要重新对一遍**。
   */
  const GUOBA_COMPONENTS = [
    // 注册表原生的
    "Input", "InputGroup", "InputPassword", "InputSearch", "InputTextArea", "InputNumber", "AutoComplete",
    "Select", "ApiSelect", "ApiTree", "TreeSelect", "ApiTreeSelect", "ApiRadioGroup", "Switch",
    "RadioButtonGroup", "RadioGroup", "Checkbox", "CheckboxGroup", "ApiCascader", "Cascader", "Slider", "Rate",
    "ApiTransfer", "DatePicker", "MonthPicker", "RangePicker", "WeekPicker", "TimePicker", "StrengthMeter",
    "IconPicker", "InputCountDown", "Upload", "Divider",
    // 锅巴自己追加的（异步加载）
    "GSelectGroup", "EasyCron", "GSubForm", "GTags",
    // 分组标记（锅巴拿它切页签，不是真组件）
    "SOFT_GROUP_BEGIN",
  ]
  check("面板用的组件都是锅巴注册过的（写错只会静默渲染成「未知的组件」）", () => {
    const unknown = [...new Set(schemas.map(s => s.component))].filter(c => c && !GUOBA_COMPONENTS.includes(c))
    if (unknown.length) throw new Error(`锅巴没有这些组件：${unknown.join("、")}——先去看锅巴的组件注册表`)
  })
  /**
   * 锅巴前端渲染插件配置前会先造一个名为"默认"的页签，然后顺序扫 schemas，遇到 `SOFT_GROUP_BEGIN`
   * 才切组——**第一个分组标记之前的字段全落在"默认"里**（只有空分组才会被删掉）。
   * 所以第一个 schema 必须是分组标记，否则面板上会白多一个页签。
   */
  check("第一个 schema 是分组标记（有字段排在它前面就会多出一个「默认」页签）", () => {
    if (schemas[0]?.component !== "SOFT_GROUP_BEGIN")
      throw new Error(`第一个是 ${JSON.stringify(schemas[0])}，面板会多出一个「默认」页签`)
  })
  check("告警横幅只在读不出来时渲染（平时不许常驻一行）", () => {
    const banner = schemas.find(s => s.field === "_panel_warning")
    if (!banner) throw new Error("面板上没有告警横幅这一项")
    if (typeof banner.show !== "function") throw new Error("横幅没有 show 控制，平时也会渲染出来")
    if (banner.show({ model: {} }) !== false) throw new Error("没有告警时它照样渲染——那会常驻一行空框")
    if (banner.show({ model: { _panel_warning: "⚠ x" } }) !== true) throw new Error("有告警时它反而不渲染")
  })

  const data = support.configInfo.getConfigData()
  /**
   * 告警横幅是**条件字段**：配置读得出来时它根本不该出现（前端就不显示横幅），读不出来时才有值。
   * 所以比"键对得上"时把它排掉，另用一条断言钉住"平时没有它"。
   */
  const alwaysFields = schemas.filter(s => s.field && s.field !== "_panel_warning").map(s => s.field)
  check("getConfigData 的键与 schema 对得上（除别名子表与条件出现的告警横幅）", () => {
    const missing = alwaysFields.filter(f => !(f in data))
    if (missing.length) throw new Error(`getConfigData 没给：${missing.join("、")}`)
  })
  check("配置读得出来时没有告警横幅（横幅只在读不出来时挂）", () => {
    if ("_panel_warning" in data) throw new Error(`不该有横幅：${data._panel_warning}`)
  })
  check("别名表在面板上是数组（GSubForm），不是映射", () => {
    if (!Array.isArray(data.anchor_aliases_list)) throw new Error(JSON.stringify(data.anchor_aliases_list))
  })
  check("getConfigData 的值来自当前配置（不是模板里的占位符）", () => {
    if (String(data["notify.cron"]) !== String(config.notify.cron))
      throw new Error(`面板值 ${data["notify.cron"]} ≠ 配置 ${config.notify.cron}`)
    if (/\$\{/.test(JSON.stringify(data))) throw new Error("面板数据里带了未替换的占位符")
  })
}

console.log("\n【6】字体随源码分发（不下载、不缓存、没有配置项）")
{
  const { FONTS, fontDir, fontUrl, fontUrls } = await import("../components/font.js")
  check(`字体目录就在插件内：resources/common/font`, () => {
    if (!same(fontDir, path.join(Paths.root, "resources", "common", "font"))) throw new Error(fontDir)
  })
  /**
   * 字体在不在**只经公开的 `fontUrl(key)` 判**（模块内部那个探测函数不导出，§3.7）：
   * 在给 `file://`、不在给空串——空串正是"模板 `@font-face` 整条失效、回落系统字体"这个
   * 可读降级的入口（§3.1：静态资源缺失要降级，不是去下载）。
   */
  check("字体在：三个用途（title/body/number）都给 file:// 且文件真的存在", () => {
    for (const key of ["title", "body", "number"]) {
      const url = fontUrl(key)
      if (!url.startsWith("file://")) throw new Error(`${key} 没取到字体：${JSON.stringify(url)}`)
      if (!fs.existsSync(fileURLToPath(url))) throw new Error(`${key} 指向的文件不存在：${url}`)
    }
  })
  check("字体缺失：给空串（回落系统字体），不抛错、不编造路径", () => {
    /** 只改内存里的清单，**不动磁盘上的字体文件**（finally 还原）；"文件缺失"那一支由此走到 */
    const real = FONTS.body
    FONTS.body = "no-such-font.woff"
    try {
      const url = fontUrl("body")
      if (url !== "") throw new Error(`期望空串，实际 ${JSON.stringify(url)}`)
    } finally {
      FONTS.body = real
    }
  })
  await check("fontUrls() 给的是 file:// 绝对路径（模板 @font-face 直接用）", async () => {
    const urls = await fontUrls()
    for (const [key, url] of Object.entries(urls)) {
      if (!url.startsWith("file://")) throw new Error(`${key} 不是 file://：${url}`)
      const file = fileURLToPath(url)
      if (!fs.existsSync(file)) throw new Error(`${key} 指向的文件不存在：${file}`)
    }
  })
  /**
   * 字体**必须真的进到渲染数据里**：`renderQueueImg` 等写的是
   * `const theme = await themeData(); { ...view, ...theme }`——
   * `themeData` 一旦返回 Promise，展开的就是 Promise 自己的属性（一个都没有），
   * 字体字段会静默丢掉、出图回落系统字体且不报错。这条钉住那个坑。
   */
  await check("渲染数据里真的有 fontTitle/fontBody/fontNumber", async () => {
    const { renderQueueImg } = await import("../components/render-html.js")
    const model = { name: "幽境危战", title: "幽境危战", rows: [], anchors: [], options: {}, col: {} }
    let seen = null
    const ctx = {
      reply: async () => true,
      renderImg: async (plugin, tpl, data) => {
        seen = { tpl, data }
        return { type: "image", file: "base64://x" }
      },
    }
    const e = { runtime: null }
    await renderQueueImg(ctx, e, model, { limit: 0 })
    if (!seen) throw new Error("没有发生渲染")
    for (const key of ["fontTitle", "fontBody", "fontNumber"]) {
      const v = seen.data?.[key]
      if (typeof v !== "string" || !v.startsWith("file://")) throw new Error(`${key} 没进渲染数据：${JSON.stringify(v)}`)
    }
  })
  check("woff 与 ttf 两份都在（与 Axiu-Plugin / Atlas-Plugin 发放形态一致）", () => {
    for (const name of ["HYWH-65W.woff", "HYWH-65W.ttf", "tttgbnumber.woff", "tttgbnumber.ttf"])
      if (!fs.existsSync(path.join(fontDir, name))) throw new Error(`缺 ${name}`)
  })
  check("配置里没有字体相关的键（既不该能配，也不该有镜像列表）", () => {
    const bad = ["font_download", "font_mirrors"].filter(k => k in config)
    if (bad.length) throw new Error(`配置里仍有：${bad.join("、")}`)
    if (CONFIG_FIELDS.some(f => f.startsWith("font_"))) throw new Error("CONFIG_FIELDS 里还有 font_*")
  })
  check("字体模块里没有下载逻辑（不 fetch、不写 data/fonts）", () => {
    const src = fs.readFileSync(path.join(Paths.root, "components", "font.js"), "utf8")
    for (const bad of ["fetch(", "mirrors(", "dataDir", "font_download", "font_mirrors"])
      if (src.includes(bad)) throw new Error(`components/font.js 里仍有 ${bad}`)
  })
}

console.log("\n【7】yamlValue 的边界")
{
  check("布尔与数字不加引号", () => {
    if (yamlValue(false) !== "false" || yamlValue(0) !== "0") throw new Error(`${yamlValue(false)} / ${yamlValue(0)}`)
  })
  check("空串写成 YAML 空串（不是裸空，那样会解析成 null）", () => {
    if (yamlValue("") !== '""') throw new Error(yamlValue(""))
    if (YAML.parse(`x: ${yamlValue("")}`).x !== "") throw new Error("解析回来不是空串")
  })
  check("多行串仍是单行字面量，且解析回来还是多行", () => {
    const v = yamlValue("a\nb")
    if (v.includes("\n")) throw new Error("写出了真换行")
    if (YAML.parse(`x: ${v}`).x !== "a\nb") throw new Error("解析回来不是两行")
  })
  check("空数组与空对象", () => {
    if (yamlValue([]) !== "[]" || yamlValue({}) !== "{}") throw new Error(`${yamlValue([])} / ${yamlValue({})}`)
  })
  check("undefined / null 写成空串（不会写出 null 字面量）", () => {
    if (yamlValue(undefined) !== '""' || yamlValue(null) !== '""') throw new Error("没兜住")
  })
}

/**
 * 这一组盯的是"**坏了之后还有没有救**"，两头都要管：
 *   - 读不出来（`config.yaml` 语法坏掉 / 读不动）：**面板要照常打得开**并在最上面挂告警——
 *     抛错会让前端只剩一个"确认"弹窗，主人连改都改不了，而面板正是唯一能把坏配置救回来的地方；
 *     同时读值不许把文件的原文带出去（那行常常就是 `token:`）。
 *   - 写坏：落盘前必须验证渲染结果能解析回来、且与提交的值一致。少了这一步，一个坏值就能把文件
 *     写成"下次读不出来的样子"。
 * 真实事故两次都发生过：44 字节的坏文件被写成 5 KB 的全空配置（面板还报"保存成功"）；
 * 以及 `token: """` 把配置写成再也读不出来的样子。
 */
console.log("\n【8】坏配置的爆炸半径 = 0：读不出来也要能救，写下去必须先验")
{
  const { readCurrentConfigWithStatus, reloadConfig } = await import("../components/config.js")
  const { getConfigData, setConfigData } = supportGuoba().configInfo
  const panelFile = ENV.config
  const originalPanelFile = fs.readFileSync(panelFile)
  const Result = { ok: (data, message) => ({ ok: true, data, message }), error: message => ({ ok: false, message }) }
  /** 少一个收尾引号：YAML 解析必然失败 */
  const broken = 'remote:\n  url: "https://broken.test/queue\n  token: abc\n'

  const readable = () => {
    try {
      return readCurrentConfigWithStatus(panelFile).error
    } catch (err) {
      return String(err?.message ?? err)
    }
  }

  await check("坏配置：读状态里带上错误（不是静默返回空对象）", () => {
    fs.writeFileSync(panelFile, broken, "utf8")
    const err = readable()
    if (!err) throw new Error("读不出来却没报错——那就会被当成'用户什么都没配'")
  })

  /**
   * **错误文案里不能带配置文件的内容**
   *
   * `yaml` 库会把"出错那行原文"整段塞进异常消息，而配置里那行常常就是 `token:` / `sign_key:`。
   * 原文一旦进日志或锅巴弹窗，等于**把口令打出来**（实机截图里就是这么泄的）。
   */
  await check("坏配置：错误文案里没有配置行内容（不泄口令）", () => {
    const err = String(readable() ?? "")
    const leaked = ['ABYSS_EDITOR_TOKEN', 'token:', '"""', "broken.test"].filter(t => err.includes(t))
    if (leaked.length) throw new Error(`错误文案带出了配置内容：${leaked.join("、")} —— ${err}`)
    if (!err.includes(panelFile)) throw new Error(`至少要说清是哪份文件读不了：${err}`)
  })

  /** 抛错会让前端只剩一个"确认"弹窗——面板彻底不可用，那就连改都改不了 */
  await check("坏配置：面板照样能打开，并在第一个页签里给出告警横幅", async () => {
    const data = await getConfigData()
    if (!data || typeof data !== "object") throw new Error("面板没拿到值")
    if (!data._panel_warning) throw new Error("没有告警横幅，主人不会知道'看到的不是自己的配置'")
    if (!/参考默认值/.test(data._panel_warning)) throw new Error(`横幅没说清显示的是什么：${data._panel_warning}`)
  })

  await check("坏配置：横幅里同样不出现配置行内容", async () => {
    const warn = String((await getConfigData())._panel_warning ?? "")
    if (['ABYSS_EDITOR_TOKEN', 'token:', '"""'].some(t => warn.includes(t))) throw new Error(`横幅泄了口令：${warn}`)
  })

  await check("坏配置：照旧能保存（面板是唯一能救回来的路），回执点明其余键按参考默认值重写", async () => {
    const r = await setConfigData({ "remote.url": "https://rescued.test/queue" }, { Result })
    if (r?.ok !== true) throw new Error(`救不回来：${JSON.stringify(r)}`)
    const back = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    if (back.remote.url !== "https://rescued.test/queue") throw new Error("提交的值没写进去")
    if (!/其余键已按参考默认值重写/.test(String(r.message))) throw new Error(`回执没提醒"其余键被重写"：${r.message}`)
  })

  await check("坏配置：救回来之后面板不再告警（横幅只在读不出来时才挂）", async () => {
    const data = await getConfigData()
    if (data._panel_warning) throw new Error(`保存成功却还在告警：${data._panel_warning}`)
  })

  /**
   * **写前验证**：渲染出来的文本必须能解析回来。
   *
   * 不验证的话，一个坏值就会把文件写成"下次读不出来的样子"——那正是配置整份丢失的现场
   * （实机：`token: """` → `Unexpected double-quoted scalar at node end`）。
   * 测法是拿**坏模板**让渲染结果必然解析不了；模板用完立刻逐字节还原。
   */
  await check("写前验证：渲染结果解析不回来时拒绝保存，且文件一个字节都没动", async () => {
    const templateBytes = fs.readFileSync(defSetPath)
    const beforeBytes = fs.readFileSync(panelFile)
    /**
     * 这一步要**临时**把仓库里的模板改坏。万一中途被打断（断言抛错、Ctrl+C、进程崩），
     * 退出钩子会把模板还原——`defSet/config.yaml` 是入库文件，绝不能留在坏状态里。
     */
    const restoreTemplate = () => {
      try {
        if (!fs.readFileSync(defSetPath).equals(templateBytes)) fs.writeFileSync(defSetPath, templateBytes)
      } catch {}
    }
    process.once("exit", restoreTemplate)
    let r
    try {
      fs.writeFileSync(defSetPath, templateBytes.toString("utf8").replace("url: ${remote_url}", 'url: "unterminated'), "utf8")
      r = await setConfigData({ "remote.token": "x" }, { Result })
    } finally {
      restoreTemplate()
      process.removeListener("exit", restoreTemplate)
    }
    if (!fs.readFileSync(defSetPath).equals(templateBytes)) throw new Error("模板没还原——先去看 defSet/config.yaml")
    if (r?.ok !== false) throw new Error(`竟然保存成功：${JSON.stringify(r)}`)
    if (!/没有被改动/.test(String(r.message))) throw new Error(`错误信息没说清"文件没动"：${r.message}`)
    const afterBytes = fs.readFileSync(panelFile)
    if (!afterBytes.equals(beforeBytes)) throw new Error(`文件被改写了：${beforeBytes.length} → ${afterBytes.length} 字节`)
  })

  /** 写前验证不能把正常值也挡掉——这块最容易"为了安全把功能关死" */
  await check("写前验证不误伤：一批刁钻但合法的值都能写下去并原样读回", async () => {
    const cases = {
      '两个引号 ""': '""',
      含双引号与井号: 'a"b#c',
      含制表符: "a\tb",
      含换行: "a\nb",
      含反斜杠: "a\\b",
      含单引号: "a'b",
      以井号开头: "# 注释样",
      只有一个引号: '"',
    }
    const bad = []
    for (const [name, value] of Object.entries(cases)) {
      const r = await setConfigData({ "remote.token": value }, { Result })
      if (r?.ok !== true) {
        bad.push(`${name}：被拒（${r?.message}）`)
        continue
      }
      const back = YAML.parse(fs.readFileSync(panelFile, "utf8"))
      if (JSON.stringify(back.remote.token) !== JSON.stringify(value)) bad.push(`${name}：读回 ${JSON.stringify(back.remote.token)}`)
    }
    if (bad.length) throw new Error(bad.join("；"))
  })

  /** 收尾：还原原字节，后面的断言（以及复跑）不受这组影响 */
  fs.writeFileSync(panelFile, originalPanelFile)
  reloadConfig()
}

console.log("\n【9】面板读写链：读文件、读写同源、写完热重载")
{
  /**
   * 这一组盯的是"面板读不到 / 写进去像没生效"那条链。
   *
   * 关键口径：内存里的 `config` 是**模块加载那一刻的快照**，`#排队初始化` 写密钥、维护者手工编辑、
   * 面板自己保存都只改文件——面板必须看文件，不能看快照；写也必须写回同一个（套件里被重定向的）路径。
   */
  const { config: live, readCurrentConfig, reloadConfig, resolveConfigPath, watchConfig } = await import(
    "../components/config.js"
  )
  const { getConfigData, setConfigData } = supportGuoba().configInfo
  const panelFile = ENV.config
  /** 这组会真改临时配置：原样存一份，收尾逐字节还原，后面的用例与复跑都不受影响 */
  const originalPanelFile = fs.readFileSync(panelFile)

  const writeCurrent = patch => {
    const doc = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    Object.assign(doc.remote ??= {}, patch.remote ?? {})
    Object.assign(doc, patch)
    fs.writeFileSync(panelFile, YAML.stringify(doc), "utf8")
    reloadConfig()
  }

  await check("读写走同一个来源：resolveConfigPath() 指向套件重定向的那份配置", () => {
    if (!same(resolveConfigPath(), panelFile))
      throw new Error(`面板会写到 ${resolveConfigPath()}，而插件读 ${panelFile}——两边不是同一份`)
  })

  await check("面板读的是文件，不是内存快照：外部改了文件，getConfigData 立刻读得到", async () => {
    writeCurrent({ remote: { url: "https://written-by-someone-else.test/queue" } })
    const got = (await getConfigData())["remote.url"]
    if (got !== "https://written-by-someone-else.test/queue") throw new Error(`面板读到 ${JSON.stringify(got)}（旧值）`)
  })

  await check("内存快照会滞后于文件（这条正是面板必须读文件的原因）", () => {
    /** 只改文件、不 reload：内存仍是上一份 */
    const doc = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    doc.remote.url = "https://file-only.test/queue"
    fs.writeFileSync(panelFile, YAML.stringify(doc), "utf8")
    if (live.remote.url === "https://file-only.test/queue") throw new Error("内存竟然自己更新了（那这组断言就失去意义）")
    reloadConfig()
  })

  const Result = { ok: (data, message) => ({ ok: true, data, message }), error: message => ({ ok: false, message }) }
  const put = patch => setConfigData({ ...patch }, { Result })

  await check("面板保存：值落进**套件重定向的那份**配置（没碰仓库的 config.yaml）", async () => {
    const before = fs.readFileSync(path.join(Paths.root, "config", "config.yaml"))
    const r = await put({ "remote.url": "https://saved-from-panel.test/queue", list_limit: 7 })
    if (!r?.ok) throw new Error(`返回不像成功：${JSON.stringify(r)}`)
    const back = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    if (back.remote.url !== "https://saved-from-panel.test/queue") throw new Error(`文件里是 ${JSON.stringify(back.remote.url)}`)
    if (back.list_limit !== 7) throw new Error(`list_limit 是 ${JSON.stringify(back.list_limit)}`)
    const after = fs.readFileSync(path.join(Paths.root, "config", "config.yaml"))
    if (!before.equals(after)) throw new Error("仓库的 config/config.yaml 被改了——面板写到了硬编码路径上")
  })

  await check("面板保存后内存同步（写完就热重载，机器人不用重启）", () => {
    if (live.remote.url !== "https://saved-from-panel.test/queue") throw new Error(`内存里还是 ${JSON.stringify(live.remote.url)}`)
    if (live.list_limit !== 7) throw new Error(`内存里 list_limit 是 ${JSON.stringify(live.list_limit)}`)
  })

  await check("面板保存不丢别的键（改一处，其余照旧）", async () => {
    const before = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    await put({ "remote.token": "token-after-partial-save" })
    const after = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    /** 只比两边都真实存在的键：临时夹具里可能本来就没有某个段 */
    for (const key of ["anchor_aliases", "notify", "roster", "snapshot_backup", "default_sheet", "render_scale"])
      if (key in before && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        throw new Error(`${key} 被改动了：${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`)
    if (after.remote.url !== "https://saved-from-panel.test/queue") throw new Error("上一次保存的 remote.url 被回退了")
  })

  await check("热重载：外部改文件后，内存 config 自己跟上（watcher 真在盯盘）", async () => {
    const stop = watchConfig({ debounceMs: 150 })
    try {
      /**
       * 先把文件恢复成原字节、等一会儿再改：每次写文件都会给 watcher 记一次待防抖的触发，
       * 上一轮断言那次直写会把我这次要验的触发挤掉（现象就是"改了却不热重载"）。
       */
      fs.writeFileSync(panelFile, originalPanelFile)
      await wait(600)
      const doc = YAML.parse(fs.readFileSync(panelFile, "utf8"))
      doc.remote.url = "https://hot-reload.test/queue"
      doc.list_limit = 33
      fs.writeFileSync(panelFile, YAML.stringify(doc), "utf8")
      let ok = false
      for (let i = 0; i < 40 && !ok; i++) {
        await wait(120)
        ok = live.remote.url === "https://hot-reload.test/queue" && live.list_limit === 33
      }
      if (!ok)
        throw new Error(`3 秒内没热重载：remote.url=${JSON.stringify(live.remote.url)} list_limit=${JSON.stringify(live.list_limit)}`)
    } finally {
      await stop()
    }
  })

  /**
   * 三层结构的**核心不变量**：`defSet` 是一张"填空表"，面板把 config.yaml 的当前值填进去，
   * 还原出一份完整的 config.yaml。这里用"每个键都放非默认值"整份压一遍——
   * 只测 `renderDefSet({})` 这种"全默认值"渲染是压不到它的（默认值恰好等于模板兜底值）。
   */
  const allFields = CONFIG_FIELDS.filter(f => !CROSS_LAYER_FIELDS.includes(f) && f !== "anchor_aliases")
  /** 给每个键造一个与 DEFAULT_CONFIG 不同的值，按类型来 */
  const weird = (field, seed) => {
    const cur = readField(live, field)
    if (typeof cur === "boolean") return !cur
    if (typeof cur === "number") return cur + 11
    if (Array.isArray(cur)) return cur.length ? [...cur, 900000000 + seed] : [900000000 + seed]
    return `非默认-${field}-${seed}`
  }
  const filled = Object.fromEntries(allFields.map((f, i) => [f, weird(f, i)]))
  filled["footer.html"] = `<div>© 2026 面板填的页脚 &amp; 备案 ${allFields.length}</div>`
  /** 别名在面板上是 GSubForm 子表，走它自己的字段名 */
  const aliasRows = [{ name: "面板正名", aliases: ["面板别名一", "面板别名二"] }]

  await check("三层结构：面板每个键都填非默认值 → 整份写回 config.yaml，值一个不丢", async () => {
    fs.writeFileSync(panelFile, originalPanelFile)
    const r = await put({ ...filled, anchor_aliases_list: aliasRows })
    if (!r?.ok) throw new Error(`保存失败：${JSON.stringify(r)}`)
    const text = fs.readFileSync(panelFile, "utf8")
    const back = YAML.parse(text)
    const left = text.match(/\$\{[A-Za-z0-9_]+\}/g)
    if (left) throw new Error(`写出的 config.yaml 里还有没替换的占位符：${left.join("、")}`)
    const lost = []
    for (const [field, want] of Object.entries(filled)) {
      const got = readField(back, field)
      if (JSON.stringify(got) !== JSON.stringify(want)) lost.push(`${field}: 期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`)
    }
    if (JSON.stringify(back.anchor_aliases) !== JSON.stringify({ 面板正名: ["面板别名一", "面板别名二"] }))
      throw new Error(`别名子表没写对：${JSON.stringify(back.anchor_aliases)}`)
    if (lost.length) throw new Error(`${lost.length} 个键没落进文件：\n  ${lost.join("\n  ")}`)
  })

  await check("三层结构：填完再读回来，插件内存与文件逐键一致（不是只在文件里对）", () => {
    const lost = Object.entries(filled).filter(([field, want]) => JSON.stringify(readField(live, field)) !== JSON.stringify(want))
    if (lost.length) throw new Error(`内存里这些键不对：${lost.map(([f]) => f).join("、")}`)
    if (JSON.stringify(live.anchor_aliases) !== JSON.stringify({ 面板正名: ["面板别名一", "面板别名二"] }))
      throw new Error(`内存里的别名不对：${JSON.stringify(live.anchor_aliases)}`)
  })

  await check("三层结构：模板占位符与配置键双向覆盖（多一个少一个都算错）", () => {
    const tplVars = new Set([...template.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]))
    const missingInTpl = CONFIG_FIELDS.filter(f => !tplVars.has(f.replace(/\./g, "_")))
    if (missingInTpl.length) throw new Error(`这些键在模板里没有占位符：${missingInTpl.join("、")}`)
    const keyVars = new Set(CONFIG_FIELDS.map(f => f.replace(/\./g, "_")))
    const extra = [...tplVars].filter(v => !keyVars.has(v))
    if (extra.length) throw new Error(`模板里有对不上配置键的占位符：${extra.join("、")}`)
  })

  /** 收尾：临时配置逐字节还原（这组改过它），再让内存跟上 */
  fs.writeFileSync(panelFile, originalPanelFile)
  reloadConfig()
}

/**
 * 【10】未配置阶段：**锅巴是主人正常的配置手段**，这一阶段面板必须照常可用
 *
 * "还没配置"（文件合法，但 `url` / `token` / `sign_key` 都是空串）**不是异常状态**：
 * 面板要照常打开、照常保存。只有"文件读不出来"才算异常（见【8】组）。
 * 这两条路的界线要一直清楚——把"空值"当成"读不出来"，主人反而连配置都做不了。
 */
console.log("\n【10】未配置阶段：空配置下面板照常打开、照常保存")
{
  const { reloadConfig } = await import("../components/config.js")
  const { getConfigData, setConfigData } = supportGuoba().configInfo
  const panelFile = ENV.config
  const originalPanelFile = fs.readFileSync(panelFile)
  const Result = { ok: (data, message) => ({ ok: true, data, message }), error: message => ({ ok: false, message }) }
  const SAVED_URL = "https://fresh-install.test/queue"

  /** 全新安装的样子：**就是参考文件**（值全空、注释齐全） */
  fs.writeFileSync(panelFile, exampleText, "utf8")
  reloadConfig()

  await check("未配置：面板读得出来（不抛错），且没有告警横幅", async () => {
    const data = await getConfigData()
    if (!data || typeof data !== "object") throw new Error("面板没拿到值")
    if ("_panel_warning" in data) throw new Error(`未配置不该报警：${data._panel_warning}`)
  })

  await check("未配置：三个凭证键读出来是空串（不是 undefined、也不是带注释的文本）", async () => {
    const data = await getConfigData()
    for (const field of ["remote.url", "remote.token", "remote.sign_key"])
      if (data[field] !== "") throw new Error(`${field} 是 ${JSON.stringify(data[field])}，应当是空串`)
  })

  await check("未配置：只填云端地址就能存下去，文件仍可解析", async () => {
    const r = await setConfigData({ "remote.url": SAVED_URL }, { Result })
    if (r?.ok !== true) throw new Error(`存不下去：${JSON.stringify(r)}`)
    const back = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    if (back.remote.url !== SAVED_URL) throw new Error(`url 没写进去：${JSON.stringify(back.remote.url)}`)
  })

  /** 面板**不许**替 `#排队初始化` 生成凭证：它不知道编辑器进程正拿着哪个口令，换了就把编辑器踢出局 */
  await check("未配置：面板不替主人生成口令 / 签名密钥（那是 #排队初始化 的事）", async () => {
    const back = YAML.parse(fs.readFileSync(panelFile, "utf8"))
    if (back.remote.token !== "" || back.remote.sign_key !== "")
      throw new Error(`面板自己造了凭证：${JSON.stringify(back.remote)}`)
  })

  await check("未配置：保存后再读一次仍是新值、仍没有横幅（不是只在文件里对）", async () => {
    const data = await getConfigData()
    if (data["remote.url"] !== SAVED_URL) throw new Error(`回读是 ${JSON.stringify(data["remote.url"])}`)
    if ("_panel_warning" in data) throw new Error(`不该有横幅：${data._panel_warning}`)
  })

  /** 收尾：临时配置逐字节还原（这组改过它） */
  fs.writeFileSync(panelFile, originalPanelFile)
  reloadConfig()
}

/**
 * 【11】生效时机：哪些键改了要重启
 *
 * 面板保存**不是全部热重载**：`RESTART_ONLY_FIELDS` 那批键由**编辑器在插件加载时**取走
 * （宿主注入三个凭证、`editor/config.js` 读页脚），插件侧热重载了、编辑器侧没有——不重启就是
 * "插件用新口令、编辑器还认旧口令"（填表链接直接 403）。
 *
 * 提醒**只提这次真的改了的**键：面板提交的是整张表单，按"在不在表单里"判会变成每次保存都说要重启，
 * 那样的提醒没人会看。
 */
console.log("\n【11】生效时机：哪些键改了要重启（提醒只提真正改了的）")
{
  const { RESTART_ONLY_FIELDS, reloadConfig } = await import("../components/config.js")
  const { setConfigData } = supportGuoba().configInfo
  const panelFile = ENV.config
  /** 这组会真改临时配置：原样存一份，收尾逐字节还原 */
  const originalPanelFile = fs.readFileSync(panelFile)
  const Result = { ok: (data, message) => ({ ok: true, data, message }), error: message => ({ ok: false, message }) }

  /** 从参考文件起步：值全是默认 / 空串，注释齐全 */
  fs.writeFileSync(panelFile, exampleText, "utf8")
  reloadConfig()

  await check("重启类键的名单：notify.cron + 三个凭证 + footer.html（编辑器在加载时取走的那批）", () => {
    for (const field of ["notify.cron", "remote.token", "remote.sign_key", "remote.admin_token", "footer.html"])
      if (!RESTART_ONLY_FIELDS.includes(field))
        throw new Error(`RESTART_ONLY_FIELDS 少了 ${field}：${JSON.stringify(RESTART_ONLY_FIELDS)}`)
  })

  await check("只改热重载键：回执不提重启（提醒不能每次保存都出现）", async () => {
    const r = await setConfigData({ "remote.url": "https://no-restart.test/queue" }, { Result })
    if (r?.ok !== true) throw new Error(`存不下去：${JSON.stringify(r)}`)
    if (String(r.message).includes("重启")) throw new Error(`不该提醒重启：${r.message}`)
  })

  await check("改访问口令：回执点出是哪个键、并说明要重启机器人", async () => {
    const r = await setConfigData(
      { "remote.url": "https://no-restart.test/queue", "remote.token": "panel-changed-token" },
      { Result },
    )
    if (r?.ok !== true) throw new Error(`存不下去：${JSON.stringify(r)}`)
    if (!String(r.message).includes("remote.token")) throw new Error(`没点出是哪个键：${r.message}`)
    if (!String(r.message).includes("重启")) throw new Error(`没说重启：${r.message}`)
  })

  await check("改页脚：同样提醒重启（页脚也是编辑器在加载时取走的）", async () => {
    const r = await setConfigData({ "footer.html": "<div>changed-by-panel</div>" }, { Result })
    if (r?.ok !== true) throw new Error(`存不下去：${JSON.stringify(r)}`)
    if (!String(r.message).includes("footer.html") || !String(r.message).includes("重启"))
      throw new Error(`回执不对：${r.message}`)
  })

  /** 收尾：临时配置逐字节还原（这组改过它） */
  fs.writeFileSync(panelFile, originalPanelFile)
  reloadConfig()
}

await ENV.cloud?.close()
await finish()
