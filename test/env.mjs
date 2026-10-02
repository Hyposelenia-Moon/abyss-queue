/**
 * 回归套件的隔离环境（**必须是测试文件的第一个 import**）
 *
 * 为什么要单独一个文件：`components/config.js` 在模块求值时就调用 loadConfig() 读
 * `ABYSS_QUEUE_CONFIG`，而 ESM 的静态 import 全部先于测试文件的顶层代码执行。
 * 因此「先 import、再在顶层设环境变量」是无效的——配置会落到仓库里的
 * config/config.yaml，测试就会读写**用户的真实表格与插件真实绑定文件**。
 *
 * 这里把临时配置的生成放在模块顶层（本文件被求值时立即执行），
 * 后续任何 import 插件代码时配置已经就位。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { reloadConfig } from "../components/config.js"

/** 模板占位：把绝对路径写成 posix 风格，YAML 里更安全 */
const posix = p => p.replace(/\\/g, "/")

/** 为某个套件准备隔离配置，返回临时目录与关键路径 */
export function ensureEnv({
  /** 临时目录前缀，便于在 %TEMP% 里辨认是哪个套件 */
  prefix = "abyss-queue-test-",
  /** 指向的表格：默认指向同目录下的副本，调用方随后自己拷贝 */
  fixtureName = "queue.xlsx",
  /** 额外写入的配置项（例如 push） */
  extra = {},
  /** 是否保留备份（含写入的套件建议 false，省一次全表拷贝） */
  backup = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const fixture = path.join(dir, fixtureName)
  const store = path.join(dir, "bindings.json")
  const config = path.join(dir, "config.yaml")

  const lines = [
    `xlsx_path: "${posix(fixture)}"`,
    `store_file: "${posix(store)}"`,
    `backup: ${backup}`,
    "default_sheet: 幽境危战",
    "list_limit: 20",
  ]
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`)
    else if (v && typeof v === "object") {
      lines.push(`${k}:`)
      for (const [k2, v2] of Object.entries(v))
        lines.push(`  ${k2}: ${Array.isArray(v2) ? `[${v2.join(", ")}]` : v2}`)
    } else lines.push(`${k}: ${v}`)
  }
  fs.writeFileSync(config, `${lines.join("\n")}\n`, "utf8")

  /** 必须在任何插件模块被求值之前设置 */
  process.env.ABYSS_QUEUE_CONFIG = config
  /** Node 先求值依赖模块：config.js 早已按仓库配置读过一次，这里必须重载 */
  reloadConfig()

  /** 防复发自检：配置没被重载时，套件会去读写用户的真实表格/绑定，必须当场拦下 */
  const live = reloadConfig()
  if (path.resolve(live.xlsxPath) !== path.resolve(fixture))
    throw new Error(`隔离失败：表格仍指向 ${live.xlsxPath}，而非测试副本 ${fixture}`)
  if (path.resolve(live.storePath) !== path.resolve(store))
    throw new Error(`隔离失败：绑定仍指向 ${live.storePath}，而非 ${store}`)

  return { dir, fixture, store, config }
}
