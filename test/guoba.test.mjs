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
import YAML from "yaml"
/* 隔离配置必须最先就位（ESM 静态 import 先于顶层代码执行） */
import { ensureEnv } from "./env.mjs"
import { createChecker, Paths } from "./_helper.mjs"

/** 先备好隔离环境（配置写进临时目录），再 import 插件代码 */
const ENV = await ensureEnv({ prefix: "abyss-guoba-" })

const { CONFIG_FIELDS, CROSS_LAYER_FIELDS, config, defSetPath, fieldToVar, renderDefSet, readField, yamlValue } =
  await import("../components/config.js")
const { supportGuoba } = await import("../guoba.support.js")
const { check, finish } = createChecker("锅巴三段式配置")

const examplePath = path.join(Paths.root, "config", "config.yaml.example")
const example = YAML.parse(fs.readFileSync(examplePath, "utf8"))
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
    /** 模板注释里那句"值写成 ${变量} 占位符"是说明文字，不是变量 */
    const real = extra.filter(v => v !== "变量")
    if (real.length) throw new Error(`模板里有未声明的占位符：${real.join("、")}`)
  })
}

console.log("\n【2】三段式的键结构一致（默认值渲染结果 = .example = DEFAULT_CONFIG）")
{
  const rendered = YAML.parse(renderDefSet({}))
  check("全默认值渲染后与 config.yaml.example 的顶层键一致", () => {
    const a = topKeys(rendered).join(", ")
    const b = topKeys(example).join(", ")
    if (a !== b) throw new Error(`\n  渲染：${a}\n  参考：${b}`)
  })
  check("与 DEFAULT_CONFIG 的顶层配置键一致（跨层键 footer 除外）", () => {
    /** 跨层键（footer）只写在配置文件里、由编辑器读，本来就不该出现在插件默认值里 */
    const crossTop = new Set(CROSS_LAYER_FIELDS.map(f => f.split(".")[0]))
    const renderedOwn = topKeys(rendered).filter(k => !crossTop.has(k))
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
      /** 跨层键（footer）本来就不在插件默认值里，它由编辑器读 */
      const inDefaults = readField(defaultsOnly, field) !== undefined
      if (!inDefaults && !CROSS_LAYER_FIELDS.includes(field)) bad.push(`默认值缺 ${field}`)
    }
    if (bad.length) throw new Error(bad.join("、"))
  })
  check("跨层键的口径没走样：它确实不在默认值里，其余键都在", () => {
    const crossTop = [...new Set(CROSS_LAYER_FIELDS.map(f => f.split(".")[0]))]
    const missing = crossTop.filter(k => k in defaultsOnly)
    const wrong = CONFIG_FIELDS.filter(f => CROSS_LAYER_FIELDS.includes(f) === false && !(f.split(".")[0] in defaultsOnly))
    if (missing.length || wrong.length)
      throw new Error(`跨层键 ${missing.join("、")} 出现在默认值里；非跨层键 ${wrong.join("、")} 不在默认值里`)
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
    "remote.autostart": "D:/Yunzai/plugins/abyss-queue/data/editor-launch.mjs",
    default_sheet: "幽境危战",
    /** 0 有真实语义（= 全部），不能被当成空值丢掉 */
    list_limit: 0,
    render_max: 40,
    render_image: true,
    render_scale: 2,
    font_download: false,
    font_mirrors: ["https://a.example/font", "https://b.example/font"],
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
   * 面板字段要么是**配置路径**（在 CONFIG_FIELDS 里），要么是**面板专用名**
   * （目前只有别名子表：存储是"正名→别名"映射，面板上是"一行一个主播"的数组）。
   * 面板专用名必须**不与任何配置路径撞名**，免得读到同名配置。
   */
  const UI_ONLY_FIELDS = ["anchor_aliases_list"]
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

  const data = support.configInfo.getConfigData()
  check("getConfigData 的键与 schema 对得上（除别名子表）", () => {
    const fields = schemas.filter(s => s.field).map(s => s.field)
    const missing = fields.filter(f => !(f in data))
    if (missing.length) throw new Error(`getConfigData 没给：${missing.join("、")}`)
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

console.log("\n【6】yamlValue 的边界")
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

await ENV.cloud?.close()
await finish()
