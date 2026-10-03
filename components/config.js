/**
 * 配置加载：config/config.yaml（不存在时从 config/config.yaml.example 生成）
 *
 * 同步加载，便于插件构造时决定是否注册定时任务。
 * 本文件在 components/ 下，插件根需向上一级解析（不能把 import.meta.dirname 直接当插件根）。
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
  /**
   * 数据来源：云端编辑器（插件只读它，不碰任何本地表格文件）
   *
   * 机器人每次按 ttl_ms 从 `<url>/api/snapshot?k=<token>` 拉一份 xlsx 快照，
   * 拿去解析成 models；写表只发生在云端编辑器与腾讯文档。
   * 本机联调可以把 url 指到 http://127.0.0.1:7788（本机编辑器）。
   */
  remote: {
    // 云端编辑器地址（例：https://yunzai.axiu.uno/queue）
    url: "",
    // 访问口令：与编辑器进程的 ABYSS_EDITOR_TOKEN 一致
    token: "",
    // 内存快照有效期（毫秒）：这期间连续命令不再重复拉取
    ttl_ms: 30000,
    // 单次拉取超时（毫秒）
    timeout_ms: 15000,
    /**
     * 本机联调兜底（可选）：拉不到数据时按这个路径把编辑器拉起来，等几秒再试一次。
     * 例：E:/Apps/editor-launch.mjs（.mjs 用 node 跑，.vbs 用 wscript）。正式部署不用填。
     */
    autostart: "",
  },
  // 默认榜（`#排队 全部` 不带榜名时使用）
  default_sheet: "幽境危战",
  // 列表显示条数（图片模式下即最大行数；0 表示全部）
  list_limit: 20,
  // 是否用图片渲染队列 / 主播 / 菜单；渲染后端不可用时自动回退文本
  render_image: true,
  // 出图分辨率倍数（设备像素比）：2 = 两倍宽高的高清图，CSS 布局不变；1 = 与旧版一致
  render_scale: 2,
  // 图片模式的列截断宽度（显示宽度，中文算 2；0 = 不截断）
  render_name_max: 40,
  render_status_max: 40,
  // 字体：首次渲染时从云端拉取并缓存到 data/fonts（不入库）；false = 不下载，直接用系统字体
  font_download: true,
  // 字体镜像（按顺序尝试；留空则用内置的 jsDelivr / raw.githubusercontent 多镜像）
  font_mirrors: [],
  // 写表前是否备份为 <原文件名>.bak（插件不写表；这项只对编辑器的本地表生效）
  backup: true,
  // 主播别名：正名 → 别名（按正则整串匹配、忽略大小写）
  // 表里/群里对同一位主播的其它写法（老昵称、简称）登记在这里，读的时候会归一成正名
  anchor_aliases: {},
  // 定时推送（默认关闭）
  push: {
    enable: false,
    cron: "0 12 * * *",
    groups: [],
    sheets: [],
    limit: 10,
  },
  // 进度通知：完成情况变化后 @ 下一位、每月最后一天催办
  notify: {
    enable: true,
    // 发到哪些群；留空则用 push.groups
    groups: [],
    // 多久检查一次「上一位是否已完成」
    progress_cron: "*/3 * * * *",
    // 每天检查一次「今天是不是当月最后一天」
    monthly_cron: "0 12 * * *",
    monthly_enable: true,
    // 进度快照（用于识别状态变化，避免重复通知）
    state_file: "data/progress.json",
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
  globalThis.logger?.mark?.(`[abyss-queue] 已从 config.yaml.example 生成 config.yaml，请先填写 remote.url（云端编辑器地址）`)
  return true
}

export function loadConfig() {
  let user = {}
  const file = activeConfigPath()
  try {
    if (file === configPath) ensureConfig()
    if (fs.existsSync(file)) user = readYaml(file)
  } catch (err) {
    globalThis.logger?.error?.(`[abyss-queue] 读取配置失败：${err.message}`)
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

/**
 * 按当前 ABYSS_QUEUE_CONFIG 重新读取配置
 *
 * 存在的理由：Node 先求值依赖模块，测试文件里「先 setenv 再 import 插件」并不成立——
 * config.js 早在 env 设置之前就按仓库 config.yaml 读完了。回归套件因此在写好临时配置后
 * 调用本函数（见 test/env.mjs）。
 *
 * 就地改写同一个对象，保证 config 这个绑定（以及各模块已 import 的引用）始终有效。
 */
export function reloadConfig() {
  const next = loadConfig()
  for (const k of Object.keys(config)) if (!(k in next)) delete config[k]
  Object.assign(config, next)
  return config
}

/** 缺配置时给用户看的提示 */
export function configHint() {
  return [
    "插件还没配置好：请在 config/config.yaml 里填写 remote.url（云端编辑器地址）",
    "本机联调可填 http://127.0.0.1:7788；remote.token 要与编辑器的 ABYSS_EDITOR_TOKEN 一致",
    `当前配置文件：${configPath}`,
    `当前云端地址：${config.remote?.url || "（空）"}`,
  ].join("\n")
}
