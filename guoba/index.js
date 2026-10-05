/**
 * 锅巴接入入口：拼 schema + 读写配置
 *
 * 三段式配置的中间那一环——**读 `defSet/config.yaml` 模板 → 替换 `${变量}` → 写运行时
 * `config/config.yaml`**，所以注释按模板完整保留（不走 `YAML.stringify` 整写，那会抹掉注释）。
 *
 * 变量名与值的序列化规则只在 `components/config.js` 里实现（`fieldToVar` / `yamlValue` /
 * `renderDefSet`），这里不重复一份，免得 schema 与模板对不上。
 */
import fs from "node:fs"
import path from "node:path"
import { config, configDir, configPath, defSetPath, renderDefSet, readField } from "../components/config.js"
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

      /** 面板加载时的值：从**当前配置**取（用户配置叠加默认值），不直接读模板 */
      getConfigData() {
        const data = { [ALIAS_FIELD]: aliasesToList(config.anchor_aliases) }
        for (const field of PANEL_FIELDS) data[field] = readField(config, field)
        return data
      },

      /** 保存：回写 `config/config.yaml`（按 defSet 模板渲染，注释完整保留） */
      async setConfigData(data, { Result }) {
        try {
          const values = { anchor_aliases: listToAliases(data[ALIAS_FIELD]) }
          for (const field of PANEL_FIELDS) if (field in data) values[field] = data[field]

          fs.mkdirSync(configDir, { recursive: true })
          let template
          try {
            template = fs.readFileSync(defSetPath, "utf8")
          } catch (err) {
            return Result.error(`读不到配置模板 ${defSetPath}：${err.message}`)
          }
          fs.writeFileSync(configPath, renderDefSet(values, template), "utf8")
          return Result.ok({}, "保存成功~（改动重启机器人后生效；编辑器页脚要重启编辑器进程）")
        } catch (err) {
          logger?.error?.("[abyss-queue] 锅巴保存配置失败：", err)
          return Result.error(`保存失败：${err.message}`)
        }
      },
    },
  }
}
