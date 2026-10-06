/**
 * 锅巴接入入口：拼 schema + 读写配置
 *
 * 三段式配置的中间那一环——**读 `defSet/config.yaml` 模板 → 替换 `${变量}` → 写运行时
 * `config/config.yaml`**，所以注释按模板完整保留（不走 `YAML.stringify` 整写，那会抹掉注释）。
 *
 * 四条硬规矩（改这里之前先读）：
 *   1. **读文件、不读内存**：`getConfigData` 走 `readCurrentConfigWithStatus()`。面板必须看得见
 *      `#排队初始化` / 手工编辑 / 上一次保存写进文件的东西——内存 `config` 是模块加载那一刻的快照。
 *   2. **读写同源**：都走 `resolveConfigPath()`。一处硬编码、一处解析，就会出现"写进去却读不到"。
 *   3. **写完同步内存**：`reloadConfig()`，否则机器人继续用旧值、面板紧接着回读也是旧值。
 *   4. **写盘前先验，读不出来也别抛**：`setConfigData` 先 `YAML.parse` 渲染结果并逐键比对，
 *      不过就一个字节都不写（否则一个坏值会把配置写成下次读不出来的样子）；`getConfigData`
 *      读不出来时**不抛错**，改给 `_panel_warning` 告警横幅——抛错会让前端只剩下一个"确认"弹窗，
 *      而面板正是主人唯一能把坏配置救回来的地方。
 *
 * 变量名与值的序列化规则只在 `components/config.js` 里实现（`fieldToVar` / `yamlValue` /
 * `renderDefSet`），这里不重复一份，免得 schema 与模板对不上。
 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import {
  RESTART_ONLY_FIELDS,
  defSetPath,
  readCurrentConfigWithStatus,
  readField,
  reloadConfig,
  renderDefSet,
  resolveConfigPath,
} from "../components/config.js"
import { getSchema as connectionSchema } from "./connection.js"
import { getSchema as displaySchema } from "./display.js"
import { getSchema as footerSchema } from "./footer.js"
import { getSchema as advancedSchema } from "./advanced.js"

/** 插件信息（面板顶部那张卡） */
const pluginInfo = {
  name: "abyss-queue",
  title: "三路深渊排队",
  description: "只读云端排表：查队列 / 主播 / 我的记录。表由部署在服务器上的在线编辑器维护，插件不写表",
  author: ["Hyposelenia-Moon", "AxiuCN"],
  authorLink: ["https://github.com/Hyposelenia-Moon", "https://github.com/AxiuCN"],
  link: "https://github.com/Hyposelenia-Moon/abyss-queue",
  isV3: true,
  isV2: false,
  /** 面板图标用图片而不是图标字体；锅巴用 res.sendFile 直接吐这个文件 */
  iconPath: path.join(import.meta.dirname, "..", "resources", "image", "HuTao_LeLouvre.ico"),
}

/** 别名表在面板上用"一行一个主播"的子表，存储时是"正名 → 别名列表"的映射 */
const ALIAS_FIELD = "anchor_aliases_list"

/**
 * 面板上的**告警横幅**字段（不是配置键）
 *
 * 只在"`config.yaml` 读不出来"时才有值：告诉主人"你现在看到的不是你的配置"。
 * 平时 `getConfigData` 不返回它，横幅就整行不渲染（见 `warnSchema()`）。
 */
const WARN_FIELD = "_panel_warning"

/**
 * 告警横幅的 schema
 *
 * 两条都是**这个锅巴版本的实际约束**，改之前先读：
 *   1. `component` 必须是锅巴**注册过**的名字。锅巴没有纯展示类组件（注册表里只有各种输入控件与
 *      `Divider`），写一个不存在的名字，前端只会把那格渲染成一句"未知的组件"——横幅承载不了任何信息，
 *      而且它照旧占着位置。
 *   2. 它**必须排在某个 `SOFT_GROUP_BEGIN` 之后**。锅巴前端先造一个名为"默认"的页签，把第一个分组
 *      之前的字段全塞进去（只有空分组才会被删掉），排在前面就会白多一个页签。
 *
 * 所以用**只读文本域**，由 `withWarnBanner()` 插进第一个分组里（主人一进来就能看见），
 * 没有告警时 `show` 为假、整行不渲染。
 */
const warnSchema = () => ({
  field: WARN_FIELD,
  label: "配置警告",
  component: "InputTextArea",
  componentProps: { disabled: true, rows: 3 },
  show: ({ model }) => Boolean(model?.[WARN_FIELD]),
})

/**
 * 把告警横幅插到第一个 `SOFT_GROUP_BEGIN`（「连接与通知」）之后
 *
 * 位置是硬要求，理由见 `warnSchema()` 第 2 条；第一个元素必须是分组标记，`test/guoba.test.mjs` 钉住了。
 */
const withWarnBanner = list => [list[0], warnSchema(), ...list.slice(1)]

/** `{ 阿修Axiu: ["阿修"] }` → `[{ name, aliases }]` */
const aliasesToList = map =>
  Object.entries(map ?? {})
    .map(([name, list]) => ({
      name: String(name ?? "").trim(),
      aliases: (Array.isArray(list) ? list : [list]).map(a => String(a ?? "").trim()).filter(Boolean),
    }))
    .filter(item => item.name)

/** `[{ name, aliases }]` → `{ 阿修Axiu: ["阿修"] }`（同名后者覆盖前者，空行丢掉） */
const listToAliases = list => {
  const out = {}
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name ?? "").trim()
    if (!name) continue
    out[name] = (Array.isArray(item?.aliases) ? item.aliases : []).map(a => String(a ?? "").trim()).filter(Boolean)
  }
  return out
}

/** 面板上要编辑的所有字段（别名表拆成子表，单独处理） */
const PANEL_FIELDS = [
  "remote.url",
  "remote.token",
  "remote.sign_key",
  "remote.admin_token",
  "remote.short_link",
  "remote.link_markdown",
  "roster.group",
  "roster.at",
  "notify.enable",
  "notify.groups",
  "notify.cron",
  "notify.monthly_enable",
  "notify.monthly_at",
  "remote.ttl_ms",
  "remote.timeout_ms",
  "default_sheet",
  "list_limit",
  "render_max",
  "render_image",
  "render_scale",
  "footer.html",
  "snapshot_backup.enable",
  "remote.autostart",
]

export function supportGuoba() {
  return {
    pluginInfo,
    configInfo: {
      schemas: withWarnBanner([...connectionSchema(), ...displaySchema(), ...footerSchema(), ...advancedSchema()]),

      /**
       * 面板加载时的值：**读文件当前内容**（用户配置叠加默认值），不读模板、也不读内存快照
       *
       * 读不出来（语法坏掉 / 读不动）时：**面板照样打开**，值取参考文件（`.example`）+ 默认值，
       * 并在第一个页签里挂一条 `WARN_FIELD` 横幅说明读不了哪个文件（为什么是这个位置/这个组件，
       * 见上面 `warnSchema()`）。两条理由：
       *   1. 抛错会让前端只剩一个"确认"弹窗，**面板彻底不可用**（连改都没法改）；
       *   2. 退回的那份值**保存时会被写进文件**，所以横幅必须写明"面板显示的不是你原来的配置"。
       */
      getConfigData() {
        const read = readCurrentConfigWithStatus()
        const current = read.config
        const data = { [ALIAS_FIELD]: aliasesToList(current.anchor_aliases) }
        for (const field of PANEL_FIELDS) data[field] = readField(current, field)
        if (read.error)
          data[WARN_FIELD] = `⚠ ${read.error}\n当前面板显示的是「参考默认值」，不是你原来的配置。`
        return data
      },

      /** 保存：回写运行时配置（按 defSet 模板渲染，注释完整保留），并同步内存 */
      async setConfigData(data, { Result }) {
        try {
          const target = resolveConfigPath()

          let template
          try {
            template = fs.readFileSync(defSetPath, "utf8")
          } catch (err) {
            return Result.error(`读不到配置模板 ${defSetPath}：${err.message}`)
          }

          const values = { anchor_aliases: listToAliases(data[ALIAS_FIELD]) }
          for (const field of PANEL_FIELDS) if (field in data) values[field] = data[field]
          /**
           * 文件读不出来时**也允许写**（否则面板永远救不回来）：提交过来的值照旧落盘，
           * 但"其余键"只能退回默认值（`renderDefSet` 的兜底来源读不出来），所以要在回执里点明。
           */
          const read = readCurrentConfigWithStatus()

          const text = renderDefSet(values, template)
          /**
           * **写前验证**：渲染出来的东西必须能解析回来，且解析结果与要写的值一致。
           * 不验证的话，一个坏值就会把文件写成"下次读不出来的样子"——那正是配置整份丢失的现场
           * （事故现场：`token: """` → `Unexpected double-quoted scalar at node end`）。
           */
          let parsed
          try {
            parsed = YAML.parse(text)
          } catch (err) {
            return Result.error(
              `渲染出的配置解析不回来，已放弃保存（你的文件没有被改动）：${String(err?.message ?? err).split("\n")[0]}`,
            )
          }
          const diff = Object.entries(values).filter(
            ([field, want]) => JSON.stringify(readField(parsed, field)) !== JSON.stringify(want),
          )
          if (diff.length)
            return Result.error(
              `保存被拒绝（你的文件没有被改动）：这些值写不成有效的 YAML —— ${diff.map(([f]) => f).join("、")}。` +
                `多半是值里混了引号 / 反斜杠 / 制表符这类字符，清掉再保存`,
            )

          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, text, "utf8")
          /** 改完立刻热重载：机器人马上用新值，面板紧接着的回读也看得到 */
          reloadConfig()
          /**
           * 重启提醒只提**这次真的改了的**键：面板提交的是整张表单，按"在不在表单里"判，
           * 每次保存都会说"要重启"，主人很快就不看这句话了。`read.config` 是**保存前**的文件内容。
           */
          const restart = RESTART_ONLY_FIELDS.filter(
            f => f in values && JSON.stringify(readField(read.config, f)) !== JSON.stringify(values[f]),
          )
          const notes = []
          if (read.error) notes.push(`原配置读不出来（${read.error}），其余键已按参考默认值重写，请核对一遍`)
          if (restart.length) notes.push(`${restart.join("、")} 改了要重启机器人才生效`)
          return Result.ok({}, `保存成功~ 已生效（${notes.join("；")}）`)
        } catch (err) {
          logger?.error?.("[abyss-queue] 锅巴保存配置失败：", err)
          return Result.error(`保存失败：${err.message}`)
        }
      },
    },
  }
}
