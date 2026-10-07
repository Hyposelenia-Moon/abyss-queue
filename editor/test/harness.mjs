/**
 * 编辑器类回归套件的共用脚手架
 *
 * 这些套件都得"起一个真的编辑器进程、打真接口、读真文件"，所以临时目录、端口占用重试、
 * 请求拼装与进程清理集中在这里；套件只写自己的场景与断言。
 *
 * 约定（与 test/README.md 一致）：
 *   - 一切临时产物进系统临时目录，绝不动仓库里的真表
 *   - 缺前置就跳过、不算失败
 *   - **端口一律现要**（`freePort()` 绑 0 让系统挑）：固定端口只要撞上（两套并发跑、本机有个
 *     没退干净的编辑器）就会以 `fetch failed` / "编辑器没起来"变红，排查成本全落在下一个人身上
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { PLUGIN_DIR, shared } from "./plugin.mjs"

export const { signIdentity, signWindow, WINDOW_MS } = await shared("model/identity.js")
export const { openWorkbook } = await shared("model/xlsx.js")
export const { Table } = await shared("model/table.js")
/** 现要一个空闲端口；套件要用就直接从这里取（同一个实现，别再抄一份） */
export const { freePort } = await shared("test/_helper.mjs")

export const wait = ms => new Promise(r => setTimeout(r, ms))
export const EDITOR = path.resolve(import.meta.dirname, "..", "editor.mjs")
export const TEMPLATE = path.join(PLUGIN_DIR, "resources", "空模板.xlsx")

/** 开发机上那份真实表（可用 XLSX_PATH 覆盖）；不存在时调用方应当跳过 */
export const realSource = () =>
  process.argv[2] ?? process.env.XLSX_PATH ?? path.join(path.dirname(PLUGIN_DIR), "2026年10月三路深渊排队.xlsx")

/**
 * 一个"浏览器"的 cookie 罐
 *
 * 认领那一层靠 cookie 认设备（`editor/claims.js`）：**同一个浏览器**认领之后，后续请求必须
 * 把那个 cookie 带上，否则会被当成"第二个来的人"降级只读——这是产品口径，不是套件 bug。
 * 自己拼请求的套件（不起 `startEditor`、直接 fetch 的那种）要按台设备建一个罐：
 *
 *   const jar = cookieJar()
 *   const res = await fetch(url, { headers: jar.headers })
 *   jar.take(res)
 *
 * @param {string} [name] 要收的 cookie 名（缺省收全部）
 */
export const cookieJar = (name = "") => {
  const box = new Map()
  return {
    /** 直接塞进 fetch 的 headers（没有 cookie 时是空对象） */
    get headers() {
      return box.size ? { cookie: [...box].map(([k, v]) => `${k}=${v}`).join("; ") } : {}
    },
    /** 收下一份响应里的 cookie（只认 `名字=值`，属性段丢掉） */
    take(res) {
      const raw = res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : [])
      for (const line of raw) {
        const pair = String(line).split(";")[0].trim()
        const at = pair.indexOf("=")
        if (at <= 0) continue
        const key = pair.slice(0, at)
        if (!name || key === name) box.set(key, pair.slice(at + 1))
      }
    },
    value: key => box.get(key) ?? "",
  }
}

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
 * 端口默认**现要一个空闲的**；端口被抢走时（并发跑就会出现这种极小概率）自动换下一个重试——
 * **不去 kill 别人的进程**。
 * @param {object} opts
 * @param {string} opts.label 日志里用的名字
 * @param {number[]} [opts.ports] 指定候选端口（一般不用给；给了就按这个顺序试，不再动态取）
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
  ports = null,
  token,
  signKey = "",
  adminToken = "",
  adminsFile = "",
  args = [],
  env = {},
  nodeArgs = [],
}) {
  let lastLog = ""
  const attempts = ports?.length ? ports.length : 3
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = ports?.length ? ports[attempt] : await freePort()
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
  /**
   * cookie 罐：**一个身份一个**（见上面 `cookieJar` 的说明）
   *
   * `cookies: false` 才是"这台设备一条 cookie 都不带"（清过 cookie / 全新设备）。
   */
  const jars = new Map()
  const jarOf = who => {
    /**
     * 按 QQ 分罐：同一个 QQ 换昵称（测"改了群名片"那种场景）还是**同一台设备**。
     */
    const key = who ? `qq:${who.qq ?? ""}` : "(无身份)"
    if (!jars.has(key)) jars.set(key, cookieJar())
    return jars.get(key)
  }

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
   *        `headers` 额外请求头 / `cookies` 是否带上这个身份的 cookie（默认带）/ `redirect`
   */
  const request = async (p, { who = null, body = null, raw = null, method, params = {}, headers = {}, cookies = true, redirect = "manual" } = {}) => {
    const qs = query({ who, params })
    const init = { method: method ?? (body || raw ? "POST" : "GET"), redirect }
    const jar = jarOf(who)
    const hs = { ...(cookies ? jar.headers : {}), ...headers }
    if (body) {
      hs["content-type"] = "application/json"
      init.body = JSON.stringify(body)
    } else if (raw) {
      hs["content-type"] = "application/octet-stream"
      init.body = raw
    }
    init.headers = hs
    const res = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}${qs}`, init)
    /** 收到的 cookie 一律存进**这次那个身份**的罐里（`cookies: false` 只影响"带不带"，不影响"存不存"） */
    jar.take(res)
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = { __raw: text.slice(0, 500) }
    }
    return { status: res.status, json, text, headers: res.headers, location: res.headers.get("location") }
  }

  return {
    label,
    port,
    base,
    log,
    request,
    /** 数据接口（页面加载时拿的那份） */
    data: (who = null) => request("/api/data", { who }),
    /** 这个身份（缺省 = 无身份那份）当前的 cookie（调试与断言用） */
    cookieHeader: (who = null) => jarOf(who).headers.cookie ?? "",
    stop: async () => {
      child.kill()
      await wait(200)
    },
  }
}
