/**
 * 编辑器类回归套件的共用脚手架
 *
 * 这些套件都得"起一个真的编辑器进程、打真接口、读真文件"，所以临时目录、端口占用重试、
 * 请求拼装与进程清理集中在这里；套件只写自己的场景与断言。
 *
 * 约定（与 test/README.md 一致）：
 *   - 一切临时产物进系统临时目录，绝不动仓库里的真表
 *   - 缺前置就跳过、不算失败
 *   - 端口是固定区间（7800-7811 被别的套件占着），这里从调用方给的候选里挑一个没被占的
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { PLUGIN_DIR, shared } from "./plugin.mjs"

export const { signIdentity } = await shared("model/identity.js")
export const { openWorkbook } = await shared("model/xlsx.js")
export const { Table } = await shared("model/table.js")

export const wait = ms => new Promise(r => setTimeout(r, ms))
export const EDITOR = path.resolve(import.meta.dirname, "..", "editor.mjs")
export const TEMPLATE = path.join(PLUGIN_DIR, "resources", "空模板.xlsx")

/** 开发机上那份真实表（可用 XLSX_PATH 覆盖）；不存在时调用方应当跳过 */
export const realSource = () =>
  process.argv[2] ?? process.env.XLSX_PATH ?? path.join(path.dirname(PLUGIN_DIR), "2026年10月三路深渊排队.xlsx")

/**
 * 临时工作目录：表格副本 + 配置 + 绑定/锁/名单文件的落点
 * @param {string} label 临时目录前缀（方便排查是谁留下的）
 * @param {object} [opts]
 * @param {string} [opts.source] 起始表格；默认用仓库里的空模板（结构齐全、没有成员）
 */
export function makeWorkspace(label, { source = null } = {}) {
  const from = source ?? TEMPLATE
  if (!fs.existsSync(from)) {
    console.log(`⏭ 缺少起始表格（${from}），跳过`)
    process.exit(0)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `abyss-${label}-`))
  const fixture = path.join(dir, "queue.xlsx")
  fs.copyFileSync(from, fixture)
  /**
   * 插件侧配置：**只放插件真正读的键**，不放路径
   *
   * 表文件由 `--file` 给；绑定/锁/名单的落点在测试模式下就是"表格旁边"
   * （= 这个临时目录，见 editor/config.js 的 `dataBase`），配置里没有路径键。
   */
  const cfg = path.join(dir, "config.yaml")
  fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")
  const file = name => path.join(dir, name)
  return {
    dir,
    fixture,
    cfg,
    file,
    /** 绑定 / 锁文件：套件偶尔要直接读它们来验证归属（编辑器把它们放在表格旁边） */
    bindingsFile: path.join(dir, "abyss-editor-bindings.json"),
    locksFile: path.join(dir, "abyss-editor-locks.json"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * 起一个编辑器进程
 *
 * 端口被别的套件占着时（并行跑就会出现）自动换下一个候选端口重试——**不去 kill 别人的进程**。
 * @param {object} opts
 * @param {string} opts.label 日志里用的名字
 * @param {number[]} opts.ports 候选端口
 * @param {string} opts.token 访问口令
 * @param {string} [opts.signKey] 身份签名密钥（不给就退回用口令签，仅测试用）
 * @param {string} [opts.adminToken]
 * @param {string} [opts.adminsFile]
 * @param {string[]} [opts.args] 其它启动参数
 * @param {object} [opts.env] 额外环境变量
 * @param {string[]} [opts.nodeArgs] 放在编辑器脚本**之前**的 node 参数（如 --require 预载）
 */
export async function startEditor({
  label = "editor",
  ports,
  token,
  signKey = "",
  adminToken = "",
  adminsFile = "",
  args = [],
  env = {},
  nodeArgs = [],
}) {
  let lastLog = ""
  for (const port of ports) {
    const argv = [
      ...nodeArgs,
      EDITOR,
      "--port",
      String(port),
      "--token",
      token,
      ...(signKey ? ["--sign-key", signKey] : []),
      ...(adminToken ? ["--admin-token", adminToken] : []),
      ...(adminsFile ? ["--admins", adminsFile] : []),
      ...args,
    ]
    const child = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", d => (out += d))
    child.stderr.on("data", d => (out += d))

    let ready = false
    for (let i = 0; i < 24 && !ready; i++) {
      await wait(250)
      if (child.exitCode !== null) break
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/healthz?k=${encodeURIComponent(token)}`)).status === 200
      } catch {
        /* 还没起来 */
      }
    }
    if (ready) {
      return makeClient({ label, port, token, signKey: signKey || token, child, log: () => out })
    }
    lastLog = out
    child.kill()
    await wait(250)
    console.log(`  ⏭ ${label} 在端口 ${port} 没起来（多半被别的套件占着），换下一个端口重试`)
  }
  throw new Error(`${label} 起不来：\n${lastLog}`)
}

/** 对外的请求口子：带口令、带签名身份、POST JSON 或原始字节 */
function makeClient({ label, port, token, signKey, child, log }) {
  const base = `http://127.0.0.1:${port}`

  const query = ({ who = null, params = {} } = {}) => {
    const q = [`k=${encodeURIComponent(token)}`]
    if (who) {
      const id = signIdentity(who, signKey)
      q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
    }
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.push(`${k}=${encodeURIComponent(v)}`)
    return q.join("&")
  }

  /**
   * @param {string} p 路径
   * @param {object} [opts] who 身份 / body JSON / raw 原始字节 / method / params 额外查询参数
   */
  const request = async (p, { who = null, body = null, raw = null, method, params = {} } = {}) => {
    const qs = query({ who, params })
    const init = { method: method ?? (body || raw ? "POST" : "GET") }
    if (body) {
      init.headers = { "content-type": "application/json" }
      init.body = JSON.stringify(body)
    } else if (raw) {
      init.headers = { "content-type": "application/octet-stream" }
      init.body = raw
    }
    const res = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}${qs}`, init)
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = { __raw: text.slice(0, 500) }
    }
    return { status: res.status, json, text }
  }

  return {
    label,
    port,
    base,
    log,
    request,
    /** 数据接口（页面加载时拿的那份） */
    data: (who = null) => request("/api/data", { who }),
    stop: async () => {
      child.kill()
      await wait(200)
    },
  }
}
