/**
 * 配置加载：config/config.yaml（不存在时从 config/config.yaml.example 生成）
 *
 * 同步加载，便于插件构造时决定是否注册定时任务。
 * 注意：本文件在 components/ 下，插件根需向上一级解析（不能把 import.meta.dirname 直接当插件根）。
 */
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

export const pluginRoot = path.resolve(import.meta.dirname, "..")
export const configDir = path.join(pluginRoot, "config")
export const configPath = path.join(configDir, "config.yaml")
export const examplePath = path.join(configDir, "config.yaml.example")

/** 回归测试可用环境变量指定另一份配置，避免动到真实配置 */
const activeConfigPath = () => process.env.ABYSS_QUEUE_CONFIG || configPath

export const DEFAULT_CONFIG = {
  // 表格文件路径：绝对路径，或相对插件目录
  xlsx_path: "",
  // 默认榜（引导报名时的首项、退队时多个绑定的优先项）
  default_sheet: "幽境危战",
  // 各表默认写入的「帮帮完成情况」
  sheets: {
    幻想真境剧诗: { default_status: "排队中" },
    幽境危战: { default_status: "排队中" },
    深境螺旋: { default_status: "等待开启" },
  },
  // 列表显示条数（0 表示全部）
  list_limit: 20,
  // 报名的 QQ 在表中已有同昵称行时：update=更新该行 / reject=拒绝并要求换昵称
  join_existing_nickname: "update",
  // 写表前是否备份为 <原文件名>.bak
  backup: true,
  // 引导式报名的等待超时（秒）
  context_timeout: 180,
  permission: {
    join: "all",
    leave: "all",
    note: "all",
    clear: "master",
  },
  // 定时推送（默认关闭）
  push: {
    enable: false,
    cron: "0 12 * * *",
    groups: [],
    sheets: [],
    limit: 10,
  },
  // 绑定数据文件（相对插件目录）
  store_file: "data/bindings.json",
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

/** 首次启动：从 config.yaml.example 生成运行时配置（幂等） */
export function ensureConfig() {
  if (fs.existsSync(configPath) || !fs.existsSync(examplePath)) return false
  fs.mkdirSync(configDir, { recursive: true })
  fs.copyFileSync(examplePath, configPath)
  logger?.mark?.(`[abyss-queue] 已从 config.yaml.example 生成 config.yaml，请先填写 xlsx_path`)
  return true
}

export function loadConfig() {
  let user = {}
  const file = activeConfigPath()
  try {
    if (file === configPath) ensureConfig()
    if (fs.existsSync(file)) user = readYaml(file)
  } catch (err) {
    logger?.error?.(`[abyss-queue] 读取配置失败：${err.message}`)
  }

  const config = merge(DEFAULT_CONFIG, user)
  config.xlsxPath = config.xlsx_path
    ? path.isAbsolute(config.xlsx_path)
      ? config.xlsx_path
      : path.join(pluginRoot, config.xlsx_path)
    : ""
  config.storePath = path.isAbsolute(config.store_file)
    ? config.store_file
    : path.join(pluginRoot, config.store_file)
  return config
}

export const config = loadConfig()

/** 缺配置时给用户看的提示 */
export function configHint() {
  return [
    "插件还没配置好：请在 config/config.yaml 里填写 xlsx_path（表格文件路径）",
    `当前配置文件：${configPath}`,
    `当前表格路径：${config.xlsxPath || "（空）"}`,
  ].join("\n")
}
