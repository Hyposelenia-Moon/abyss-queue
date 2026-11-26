/** 配置加载：config/config.yaml（不存在时从 config/config.yaml.example 生成） */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { log } from "./logger.js"

export const pluginRoot = path.resolve(import.meta.dirname, "..")
export const configDir = path.join(pluginRoot, "config")
export const configPath = path.join(configDir, "config.yaml")
export const examplePath = path.join(configDir, "config.yaml.example")

export const dataDir = path.join(pluginRoot, "data")

const atData = rel => path.join(dataDir, rel)

export const resolveConfigPath = () => process.env.ABYSS_QUEUE_CONFIG || configPath

export const insidePlugin = (target, root = pluginRoot) => {
  const rel = path.relative(root, path.resolve(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export const testPathsAllowed = () => /^(1|true|yes|on)$/i.test(String(process.env.ABYSS_QUEUE_TEST_PATHS ?? "").trim())

export function confineDataPath(label, raw, fallbackRel, { log } = {}) {
  const fallback = path.join(pluginRoot, fallbackRel)
  const value = String(raw ?? "").trim()
  if (!value) return fallback
  const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(pluginRoot, value)
  if (insidePlugin(abs) || testPathsAllowed()) return abs
  const say = log ?? (typeof globalThis.logger?.error === "function" ? m => globalThis.logger.error(m) : m => console.error(m))
  say(
    `[abyss-queue] 配置项 ${label} 指向插件目录之外：${abs}；已回落到插件内默认值 ${fallback} —— ` +
      `数据必须留在插件目录内（${dataDir}），不要把它配到外面`,
  )
  return fallback
}

export const DEFAULT_CONFIG = {
  editor: {
    public_url: "",
    token: "",
    sign_key: "",
    admin_token: "",
  },
  snapshot_backup: {
    enable: true,
  },
  default_sheet: "幽境危战",
  roster: {
    group: "",
    at: "05:00",
  },
  list_limit: 20,
  render_image: true,
  render_scale: 6,
  render_max: 40,
  footer: {
    html: '<div>© 2026 <a href="https://github.com/Hyposelenia-Moon">缄月</a> &amp; <a href="https://github.com/AxiuCN">阿修Axiu</a> · 由 <a href="https://github.com/Hyposelenia-Moon/abyss-queue">abyss-queue</a> 提供</div>',
  },
  anchor_aliases: {},
  attack_versions: [
    { version: "7.0", open_at: "2026-08-26 10:00", preset: "7.0模式", modes: ["线列破袭", "至寒风暴", "狭域死战"] },
    { version: "7.1", open_at: "2026-09-30 10:00", preset: "7.1模式", modes: ["焰羽追绞", "囚笼冰城"] },
    { version: "7.2", open_at: "2026-11-04 10:00", preset: "7.2模式", modes: ["交错锤砧", "重兵固港", "灾厄旧城"] },
    { version: "7.3", open_at: "2026-12-16 10:00", preset: "7.3模式", modes: [] },
  ],
  notify: {
    enable: true,
    groups: [],
    cron: "*/3 * * * *",
    monthly_at: "12:00",
    monthly_enable: true,
    open_anchor: true,
  },
  anchor_live: {
    enable: true,
    push: true,
  },
}

const isPlainObject = v => v && typeof v === "object" && !Array.isArray(v)

function merge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === undefined || v === null) continue
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v
  }
  return out
}

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, "utf8")) ?? {}
}

function explainParseError(file, err) {
  const reason = String(err?.message ?? err).split("\n")[0].trim()
  return `解析不了 ${file}：${reason}`
}

function readUserConfig(file) {
  try {
    if (file === configPath) ensureConfig()
    if (fs.existsSync(file)) return { user: readYaml(file), error: null, file }
    if (fs.existsSync(examplePath)) return { user: readYaml(examplePath), error: null, file: examplePath }
    return { user: {}, error: null, file }
  } catch (err) {
    const message = explainParseError(file, err)
    globalThis.logger?.error?.(`[abyss-queue] 读取配置失败：${message}`)
    return { user: {}, error: message, file }
  }
}

function buildConfig(user) {
  const config = merge(DEFAULT_CONFIG, user)
  config.storePath = atData("bindings.json")
  config.notifyStatePath = atData("progress.json")
  config.backupDir = atData("backup")
  config.adminsPath = atData("abyss-editor-admins.json")
  config.managerLinkPath = atData("manager-link.json")
  config.rosterPath = atData("roster.json")
  config.editorLinksPath = atData("abyss-editor-links.json")
  config.anchorNamesPath = atData("anchor-names.json")
  config.anchorLivePath = atData("anchor-live.json")
  config.liveAlertsPath = atData("live-alerts.json")
  if (testPathsAllowed()) {
    const env = name => String(process.env[name] ?? "").trim()
    if (env("ABYSS_QUEUE_STORE_FILE"))
      config.storePath = confineDataPath("ABYSS_QUEUE_STORE_FILE", env("ABYSS_QUEUE_STORE_FILE"), "data/bindings.json")
    if (env("ABYSS_QUEUE_STATE_FILE"))
      config.notifyStatePath = confineDataPath("ABYSS_QUEUE_STATE_FILE", env("ABYSS_QUEUE_STATE_FILE"), "data/progress.json")
    if (env("ABYSS_QUEUE_BACKUP_DIR"))
      config.backupDir = confineDataPath("ABYSS_QUEUE_BACKUP_DIR", env("ABYSS_QUEUE_BACKUP_DIR"), "data/backup")
    if (env("ABYSS_QUEUE_ADMINS_FILE"))
      config.adminsPath = confineDataPath("ABYSS_QUEUE_ADMINS_FILE", env("ABYSS_QUEUE_ADMINS_FILE"), "data/abyss-editor-admins.json")
    if (env("ABYSS_QUEUE_MANAGER_LINK_FILE"))
      config.managerLinkPath = confineDataPath(
        "ABYSS_QUEUE_MANAGER_LINK_FILE",
        env("ABYSS_QUEUE_MANAGER_LINK_FILE"),
        "data/manager-link.json",
      )
    if (env("ABYSS_QUEUE_ROSTER_FILE"))
      config.rosterPath = confineDataPath("ABYSS_QUEUE_ROSTER_FILE", env("ABYSS_QUEUE_ROSTER_FILE"), "data/roster.json")
    if (env("ABYSS_QUEUE_ANCHOR_NAMES_FILE"))
      config.anchorNamesPath = confineDataPath(
        "ABYSS_QUEUE_ANCHOR_NAMES_FILE",
        env("ABYSS_QUEUE_ANCHOR_NAMES_FILE"),
        "data/anchor-names.json",
      )
    if (env("ABYSS_QUEUE_ANCHOR_LIVE_FILE"))
      config.anchorLivePath = confineDataPath(
        "ABYSS_QUEUE_ANCHOR_LIVE_FILE",
        env("ABYSS_QUEUE_ANCHOR_LIVE_FILE"),
        "data/anchor-live.json",
      )
    if (env("ABYSS_QUEUE_LIVE_ALERTS_FILE"))
      config.liveAlertsPath = confineDataPath(
        "ABYSS_QUEUE_LIVE_ALERTS_FILE",
        env("ABYSS_QUEUE_LIVE_ALERTS_FILE"),
        "data/live-alerts.json",
      )
    config.xlsxPath = env("ABYSS_QUEUE_XLSX_PATH")
      ? path.resolve(pluginRoot, env("ABYSS_QUEUE_XLSX_PATH"))
      : ""
  } else {
    config.xlsxPath = ""
  }
  if (config.snapshot_backup?.enable === false) config.backupDir = ""
  return config
}

export function ensureConfig() {
  if (fs.existsSync(configPath) || !fs.existsSync(examplePath)) return false
  fs.mkdirSync(configDir, { recursive: true })
  fs.copyFileSync(examplePath, configPath)
  log("info", `[abyss-queue] 已从 config.yaml.example 生成 config.yaml，请先填写 editor.public_url（编辑器地址）`)
  return true
}

export function readCurrentConfigWithStatus(file = resolveConfigPath()) {
  const read = readUserConfig(file)
  return { config: buildConfig(read.user), error: read.error, file: read.file }
}

export function readCurrentConfig(file = resolveConfigPath()) {
  return readCurrentConfigWithStatus(file).config
}

export function loadConfig() {
  const read = readUserConfig(resolveConfigPath())
  return buildConfig(read.user)
}

export const config = loadConfig()

export const defSetPath = path.join(pluginRoot, "defSet", "config.yaml")

export const fieldToVar = field => String(field).replace(/\./g, "_")

export function readField(src, field) {
  let cur = src
  for (const seg of String(field).split(".")) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[seg]
  }
  return cur
}

export function yamlValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  if (value === null || value === undefined) return '""'
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(yamlValue).join(", ")}]`
  return `{${Object.entries(value)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`)
    .join(", ")}}`
}

export function renderDefSet(values = {}, template = fs.readFileSync(defSetPath, "utf8")) {
  const current = readCurrentConfig()
  let out = template
  for (const field of CONFIG_FIELDS) {
    const value = field in values ? values[field] : readField(current, field)
    out = out.replace(new RegExp(`\\$\\{${fieldToVar(field)}\\}`, "g"), yamlValue(value))
  }
  return out
}

export const CONFIG_FIELDS = [
  "editor.public_url",
  "editor.token",
  "editor.sign_key",
  "editor.admin_token",
  "roster.group",
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
  "render_image",
  "render_scale",
  "render_max",
  "anchor_aliases",
  "attack_versions",
  "footer.html",
  "roster.at",
  "snapshot_backup.enable",
]

export const CROSS_LAYER_FIELDS = ["footer.html"]

let attackVersionsStamp = 0
export function refreshAttackVersions() {
  try {
    const file = resolveConfigPath()
    const stamp = fs.statSync(file).mtimeMs
    if (stamp === attackVersionsStamp) return config.attack_versions
    attackVersionsStamp = stamp
    const next = readCurrentConfig(file).attack_versions
    if (Array.isArray(next) || (next && typeof next === "object")) config.attack_versions = next
  } catch {
  }
  return config.attack_versions
}

export function reloadConfig() {
  const next = loadConfig()
  for (const k of Object.keys(config)) if (!(k in next)) delete config[k]
  Object.assign(config, next)
  return config
}

export const RESTART_ONLY_FIELDS = ["notify.cron", "editor.token", "editor.sign_key", "editor.admin_token", "footer.html"]

export function watchConfig({ debounceMs = 200, intervalMs = 700 } = {}) {
  const file = resolveConfigPath()
  let timer = null
  const onChange = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        const before = JSON.stringify(config)
        const beforeRestart = RESTART_ONLY_FIELDS.map(f => JSON.stringify(readField(config, f)))
        reloadConfig()
        if (JSON.stringify(config) === before) return
        const restart = RESTART_ONLY_FIELDS.filter((f, i) => JSON.stringify(readField(config, f)) !== beforeRestart[i])
        log(
          "info",
          `[abyss-queue] 配置已热重载（${file}）` +
            (restart.length ? `；${restart.join("、")} 的改动要重启机器人才生效` : ""),
        )
      } catch (err) {
        log("warn", `[abyss-queue] 配置热重载失败，继续用上一份：${err?.message ?? err}`)
      }
    }, debounceMs)
  }
  fs.watchFile(file, { interval: intervalMs, persistent: false }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size && cur.nlink === prev.nlink) return
    onChange()
  })
  return () => {
    if (timer) clearTimeout(timer)
    fs.unwatchFile(file)
  }
}
