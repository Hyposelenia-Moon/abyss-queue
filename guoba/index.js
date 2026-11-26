/** 锅巴接入入口：拼 schema + 读写配置 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import {
  DEFAULT_CONFIG,
  RESTART_ONLY_FIELDS,
  defSetPath,
  readCurrentConfigWithStatus,
  readField,
  reloadConfig,
  renderDefSet,
  resolveConfigPath,
} from "../components/config.js"
import { pluginVersion } from "../components/pluginVersion.js"
import { getSchema as connectionSchema } from "./connection.js"
import { getSchema as displaySchema } from "./display.js"
import { getSchema as footerSchema } from "./footer.js"
import { getSchema as advancedSchema } from "./advanced.js"

const pluginInfo = {
  name: "abyss-queue",
  title: "三路深渊排队",
  description: "排队表工具：查队列 / 主播 / 我的记录（表格随机器人一起维护，自带网页编辑器）",
  author: ["Hyposelenia-Moon", "AxiuCN"],
  authorLink: ["https://github.com/Hyposelenia-Moon", "https://github.com/AxiuCN"],
  link: "https://github.com/Hyposelenia-Moon/abyss-queue",
  isV3: true,
  isV2: false,
  iconPath: path.join(import.meta.dirname, "..", "resources", "image", "HuTao_LeLouvre.ico"),
}

const ALIAS_FIELD = "anchor_aliases_list"

const WARN_FIELD = "_panel_warning"

const warnSchema = () => ({
  field: WARN_FIELD,
  label: "配置警告",
  component: "InputTextArea",
  componentProps: { disabled: true, rows: 3 },
  show: ({ model }) => Boolean(model?.[WARN_FIELD]),
})

const withWarnBanner = list => [list[0], warnSchema(), ...list.slice(1)]

const aliasesToList = map =>
  Object.entries(map ?? {})
    .map(([name, list]) => ({
      name: String(name ?? "").trim(),
      aliases: (Array.isArray(list) ? list : [list]).map(a => String(a ?? "").trim()).filter(Boolean),
    }))
    .filter(item => item.name)
const listToAliases = list => {
  const out = {}
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name ?? "").trim()
    if (!name) continue
    out[name] = (Array.isArray(item?.aliases) ? item.aliases : []).map(a => String(a ?? "").trim()).filter(Boolean)
  }
  return out
}

const ATTACK_FIELD = "attack_versions_list"

const versionFromPreset = preset => {
  const hit = String(preset ?? "").match(/(^|[^\d])(\d+\.\d+)([^\d]|$)/)
  return hit ? hit[2] : ""
}

const defaultAttackVersion = () => DEFAULT_CONFIG.attack_versions.at(-1)

const attackVersionOf = item => {
  const version = String(item?.version ?? "").trim()
  const preset = String(item?.preset ?? "").trim()
  const openAt = String(item?.open_at ?? "").trim()
  const modes = Array.isArray(item?.modes) ? item.modes : []
  if (!version && !preset && !openAt && modes.length === 0) {
    const fallback = defaultAttackVersion()
    return {
      version: fallback.version,
      open_at: fallback.open_at,
      preset: fallback.preset,
    }
  }
  let inferred = version || versionFromPreset(preset)
  if (!inferred && openAt) {
    inferred = DEFAULT_CONFIG.attack_versions.find(v => v.open_at === openAt)?.version ?? ""
  }
  if (!inferred) return null
  const fallback = DEFAULT_CONFIG.attack_versions.find(v => v.version === inferred)
  return {
    version: inferred,
    open_at: openAt || fallback?.open_at || "",
    preset: preset || fallback?.preset || `${inferred}模式`,
  }
}

const attackVersionsToList = list =>
  (Array.isArray(list) ? list : []).map(item => {
    const normalized = attackVersionOf(item)
    if (!normalized) return null
    return {
      ...normalized,
      modes: (Array.isArray(item?.modes) ? item.modes : [])
        .map(m => String(m ?? "").trim())
        .filter(Boolean),
    }
  }).filter(Boolean)
const listToAttackVersions = list =>
  (Array.isArray(list) ? list : []).map(item => {
    const normalized = attackVersionOf(item)
    if (!normalized) return null
    const modes = [...new Set((Array.isArray(item?.modes) ? item.modes : [])
      .map(m => String(m ?? "").trim())
      .filter(Boolean))]
    return {
      ...normalized,
      modes,
    }
  }).filter(Boolean)
const PANEL_FIELDS = [
  "editor.public_url",
  "editor.token",
  "editor.sign_key",
  "editor.admin_token",
  "roster.group",
  "roster.at",
  "notify.enable",
  "notify.groups",
  "notify.cron",
  "notify.monthly_enable",
  "notify.monthly_at",
  "notify.open_anchor",
  "anchor_live.enable",
  "anchor_live.push",
  "default_sheet",
  "list_limit",
  "render_max",
  "render_image",
  "render_scale",
  "footer.html",
  "snapshot_backup.enable",
]

const gitHead = () => {
  try {
    const gitDir = path.join(import.meta.dirname, "..", ".git")
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim()
    if (!head.startsWith("ref:")) return head.slice(0, 7)
    const ref = head.slice(4).trim()
    try {
      return fs.readFileSync(path.join(gitDir, ref), "utf8").trim().slice(0, 7)
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8")
      for (const line of packed.split(/\r?\n/)) if (line.endsWith(` ${ref}`)) return line.split(/\s+/)[0].slice(0, 7)
      return ""
    }
  } catch {
    return ""
  }
}

const runtimeInfo = () => {
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000))
  const started = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(startedAt)
  const commit = gitHead()
  return [
    `插件版本：${pluginVersion}`,
    `进程启动：${started}`,
    `代码提交：${commit || "未知（部署目录没有 .git）"}`,
    "配置热重载：是（锅巴保存后立即 reloadConfig）",
    "代码热重载：否（JS 模块不会自动替换，更新代码需重启机器人）",
  ].join("\n")
}

export function supportGuoba() {
  return {
    pluginInfo,
    configInfo: {
      schemas: withWarnBanner([...connectionSchema(), ...displaySchema(), ...footerSchema(), ...advancedSchema()]),
      getConfigData() {
        const read = readCurrentConfigWithStatus()
        const current = read.config
        const data = {
          [ALIAS_FIELD]: aliasesToList(current.anchor_aliases),
          [ATTACK_FIELD]: attackVersionsToList(current.attack_versions),
          _runtime_info: runtimeInfo(),
        }
        for (const field of PANEL_FIELDS) data[field] = readField(current, field)
        if (read.error)
          data[WARN_FIELD] = `⚠ ${read.error}\n当前面板显示的是「参考默认值」，不是你原来的配置。`
        return data
      },
      async setConfigData(data, { Result }) {
        try {
          const target = resolveConfigPath()
          let template
          try {
            template = fs.readFileSync(defSetPath, "utf8")
          } catch (err) {
            return Result.error(`读不到配置模板 ${defSetPath}：${err.message}`)
          }
          const values = {
            anchor_aliases: listToAliases(data[ALIAS_FIELD]),
            attack_versions: listToAttackVersions(data[ATTACK_FIELD]),
          }
          for (const field of PANEL_FIELDS) if (field in data) values[field] = data[field]
          const read = readCurrentConfigWithStatus()
          const text = renderDefSet(values, template)
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
          reloadConfig()
          const restart = RESTART_ONLY_FIELDS.filter(
            f => f in values && JSON.stringify(readField(read.config, f)) !== JSON.stringify(values[f]),
          )
          const notes = []
          const tableFile = path.join(import.meta.dirname, "..", "data", "queue.xlsx")
          const stateFile = path.join(import.meta.dirname, "..", "data", "queue.json")
          if (!fs.existsSync(tableFile) && !fs.existsSync(stateFile)) {
            notes.push("未找到本机 data/queue.json 或 data/queue.xlsx，跳过线上表回填")
          } else {
            try {
              const { syncAttackStatuses } = await import("../editor/editor.mjs")
              const out = await syncAttackStatuses()
              notes.push(`已自动回填线上枪战/深渊状态 ${Number(out?.changed) || 0} 行`)
            } catch (err) {
              notes.push(`配置已保存，但自动回填线上枪战状态失败：${err.message}`)
            }
          }
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
