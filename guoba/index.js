/**
 * 锅巴接入入口：拼 schema + 读写配置
 *
 * 三段式配置的中间那一环——**读 `defSet/config.yaml` 模板 → 替换 `${变量}` → 写运行时
 * `config/config.yaml`**，所以注释按模板完整保留（不走 `YAML.stringify` 整写，那会抹掉注释）。
 *
 * 三条硬规矩（改这里之前先读）：
 *   1. **读文件、不读内存**：`getConfigData` 走 `readCurrentConfig()`。面板必须看得见
 *      `#排队初始化` / 手工编辑 / 上一次保存写进文件的东西——内存 `config` 是模块加载那一刻的快照。
 *   2. **读写同源**：都走 `resolveConfigPath()`。一处硬编码、一处解析，就会出现"写进去却读不到"。
 *   3. **写完同步内存**：`reloadConfig()`，否则机器人继续用旧值、面板紧接着回读也是旧值。
 *
 * 变量名与值的序列化规则只在 `components/config.js` 里实现（`fieldToVar` / `yamlValue` /
 * `renderDefSet`），这里不重复一份，免得 schema 与模板对不上。
 */
import fs from "node:fs"
import path from "node:path"
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
      schemas: [...connectionSchema(), ...displaySchema(), ...footerSchema(), ...advancedSchema()],

      /**
       * 面板加载时的值：**读文件当前内容**（用户配置叠加默认值），不读模板、也不读内存快照
       *
       * 读不出来（语法坏掉 / 读不动）时**直接让面板看到错误**，不返回一份"全空"：
       * 那份空一旦被当成"用户什么都没配"，下次保存就会把他的配置整份写成空值。
       */
      getConfigData() {
        const read = readCurrentConfigWithStatus()
        if (read.error) throw new Error(read.error)
        const data = { [ALIAS_FIELD]: aliasesToList(read.config.anchor_aliases) }
        for (const field of PANEL_FIELDS) data[field] = readField(read.config, field)
        return data
      },

      /** 保存：回写运行时配置（按 defSet 模板渲染，注释完整保留），并同步内存 */
      async setConfigData(data, { Result }) {
        try {
          /**
           * **读不出来就不写**：`renderDefSet` 对"表单没提交的键"是按文件当前值兜底的，
           * 文件都读不出来时那份兜底就是"全默认"——照写等于拿空值把用户的配置整份覆盖掉。
           * 宁可让面板报错、让主人去修文件，也不能把配置写没。
           */
          const read = readCurrentConfigWithStatus()
          if (read.error) return Result.error(`当前配置读不出来，已放弃保存（不覆盖你的文件）：${read.error}`)

          const values = { anchor_aliases: listToAliases(data[ALIAS_FIELD]) }
          for (const field of PANEL_FIELDS) if (field in data) values[field] = data[field]

          let template
          try {
            template = fs.readFileSync(defSetPath, "utf8")
          } catch (err) {
            return Result.error(`读不到配置模板 ${defSetPath}：${err.message}`)
          }
          const target = resolveConfigPath()
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, renderDefSet(values, template), "utf8")
          /** 改完立刻热重载：机器人马上用新值，面板紧接着的回读也看得到 */
          reloadConfig()
          const restart = RESTART_ONLY_FIELDS.filter(f => f in values)
          return Result.ok(
            {},
            restart.length
              ? `保存成功~ 已生效；${restart.join("、")} 改动要重启机器人才生效（编辑器页脚要重启编辑器进程）`
              : "保存成功~ 已生效（编辑器页脚要重启编辑器进程）",
          )
        } catch (err) {
          logger?.error?.("[abyss-queue] 锅巴保存配置失败：", err)
          return Result.error(`保存失败：${err.message}`)
        }
      },
    },
  }
}
