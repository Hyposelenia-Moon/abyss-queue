/**
 * 本机编辑器启动器（给桌面快捷方式用）
 *
 * 本机这份是**云端数据的备份 / 工作副本**，不是数据本体：
 *   1. 先看端口是否已被占用：占着就**停下来说清楚是谁占的**，绝不按端口去杀未知进程
 *      （上一轮残留的编辑器也好、别的服务也好，都由主人自己决定怎么处理）
 *   2. 从云端拉一份最新的表覆盖到本地（拉不到就沿用本机现有那份；本地也没有就用插件里的空模板起一份）
 *   3. 以**主人专用**模式起编辑器（除主人外谁都打不开；机器人拉快照与探活除外）
 *   4. 把"带主人身份的页面地址"写进 editor-url.txt，由快捷方式脚本打开
 *
 * 里面的编辑器读的是插件自带的 editor/ 目录，共用插件的表格读写实现（只有一份）。
 *
 * 为什么用 detached + windowsHide 起进程：
 *   直接用 WMI/cmd 起 node 会给它分配控制台，控制台一被关掉（或宿主会话结束）就会收到 SIGHUP 退出。
 *   这里 detached 起、不分配控制台，日志走编辑器自己的 --log。
 *
 * 路径文件 editor-path.txt（UTF-16LE，一行一项，空行表示没配）——就在本脚本旁边：
 *   1. 编辑器：<插件目录>\editor\editor.mjs   （例：<Yunzai>\plugins\abyss-queue\editor\editor.mjs）
 *   2. 本地工作副本：（默认同目录的 排队表-本地.xlsx）
 *   3. 访问口令：与云端 / 插件 remote.token 一致
 *   4. 云端编辑器地址：例 https://yunzai.axiu.uno/queue（留空 = 不自动拉取，用本机现有那份）
 *   5. 身份签名密钥：与云端 / 插件 remote.sign_key 一致（留空 = 退回用访问口令签，仅本机联调）
 *
 * 本目录（`plugins\abyss-queue\data`）放的都跟数据/脚本有关：启动器、口令与身份签名密钥、白名单、
 * 本地工作副本、日志；历史版本与归档在编辑器第一次写表时会自动建在这里。
 * 数据目录就固定在插件里，所以脚本按**自身位置**定位（`import.meta.url`），路径里没有盘符可写。
 */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execSync, spawn } from "node:child_process"

/** 数据目录：脚本、配置、日志、本地副本都在这儿（跟着脚本走，不写死路径） */
const DATA_DIR = path.dirname(fileURLToPath(import.meta.url))
const PATHS_FILE = path.join(DATA_DIR, "editor-path.txt")
const LOCAL_XLSX = path.join(DATA_DIR, "排队表-本地.xlsx")
const URL_FILE = path.join(DATA_DIR, "editor-url.txt")
const LOG_FILE = path.join(DATA_DIR, "editor.log")
const LAUNCH_LOG = path.join(DATA_DIR, "editor-launch.log")
const ADMINS_FILE = path.join(DATA_DIR, "abyss-editor-admins.json")
const PORT = Number(process.env.ABYSS_EDITOR_PORT ?? 7788)
/** 局域网访问：手机/别的电脑要能打开，所以绑 0.0.0.0（有口令兜着，且主人专用） */
const BIND = process.env.ABYSS_EDITOR_BIND ?? "0.0.0.0"

const notes = []
const say = msg => {
  notes.push(`[${new Date().toLocaleString("zh-CN")}] ${msg}`)
  console.log(msg)
}
const fail = msg => {
  say(`失败：${msg}`)
  try {
    fs.writeFileSync(LAUNCH_LOG, notes.join("\r\n") + "\r\n", "utf8")
  } catch {
    /* 写不了日志就算了 */
  }
  process.exit(1)
}

if (!fs.existsSync(PATHS_FILE)) fail(`找不到路径文件：${PATHS_FILE}`)
const lines = fs
  .readFileSync(PATHS_FILE, "utf16le")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .map(s => s.trim())
const [editorPath, localXlsx = LOCAL_XLSX, token = "", cloud = "", signKey = ""] = lines
if (!editorPath || !fs.existsSync(editorPath)) fail(`找不到编辑器：${editorPath}`)
const xlsxPath = localXlsx || LOCAL_XLSX

/**
 * 1) 端口占用检查：**只查不杀**
 *
 * 端口被占用就停下并明确报告占用者，绝不终止不认识的进程：端口上跑的可能是别的服务，
 * 也可能是另一个账号 / 更高权限在跑的东西，"清端口"等于越权终止别人的进程。
 * 上一轮残留的编辑器也好、别的服务也好，都由主人自己决定怎么处理。
 */
const probePort = () =>
  new Promise(resolve => {
    const srv = net.createServer()
    let settled = false
    const done = occupied => {
      if (settled) return
      settled = true
      srv.removeListener("error", onError)
      resolve(occupied)
    }
    const onError = err => {
      /** EADDRINUSE = 被占用；其它错误（权限等）不肯定，交给后面的探活报错 */
      done(err?.code === "EADDRINUSE")
    }
    srv.once("error", onError)
    srv.listen(PORT, "127.0.0.1", () => srv.close(() => done(false)))
  })

/** 占用者是谁：只报告 PID，不终止（netstat 拿不到就返回空串） */
const listenerPids = () => {
  let out = ""
  try {
    out = execSync("netstat -ano", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return []
  }
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const m = line.trim().match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (m && Number(m[1]) === PORT && Number(m[2]) !== process.pid) pids.add(Number(m[2]))
  }
  return [...pids]
}

if (await probePort()) {
  const pids = listenerPids()
  say(`端口 ${PORT} 已被占用${pids.length ? `（PID ${pids.join("、")}）` : ""}`)
  fail(
    `端口 ${PORT} 上已经有进程在监听（可能上一轮编辑器还没退，也可能是别的服务）。` +
      `这个启动器不会去杀不认识的进程：请自己确认并关掉它，或换 ABYSS_EDITOR_PORT 再起。` +
      (pids.length ? `占用者 PID：${pids.join("、")}` : ""),
  )
}

/**
 * 2) 拉云端那份覆盖到本地
 *
 * 拉不到就沿用本机现有那份（本地编辑的内容不会被网络故障抹掉）；
 * 本地也还没有的话，用插件自带的空模板起一份（换月/新部署都这么开始）。
 *
 * **验收通过才替换**：这份字节要能当工作簿打开、每张表都能建模、业务列齐全才准替换。
 * 只看 HTTP 200 + 长度 ≥1KB 的话，服务端返回错误页 / 截断的 xlsx 会被当成本地表换掉，
 * 第二次拉取再把这个已经坏掉的主文件复制进 .bak —— 有效备份与工作副本一起没了。
 * 验收不过就另存诊断文件，主文件与 .bak 都不动。
 */

/** 插件根：编辑器在 `<插件根>/editor/editor.mjs`，启动器的验收要用插件里那套解析实现 */
const PLUGIN_ROOT = path.resolve(path.dirname(editorPath), "..")

/**
 * 业务表必须有这些列（与编辑器替换上传时那份 REPLACE_REQUIRED_COLUMNS 同一个口径）：
 * 缺任何一列，"拉下来能打开"也没用——机器人读不出成员，等于把表换成了废纸。
 */
const REQUIRED_COLUMNS = [
  ["seq", "序号"],
  ["nickname", "群昵称"],
  ["gameName", "原神游戏名"],
  ["anchor", "选择主播"],
  ["goal", "难度及目标"],
  ["strength", "账号强度"],
  ["status", "帮帮完成情况"],
  ["note", "备注"],
]

/**
 * 完整工作簿 / 业务结构验收：复用插件自己的解析与建模（`lib/xlsx.js` + `lib/schema.js`）
 *
 * 为什么用插件的实现而不是另写一套：验收口径必须与"机器人/编辑器真正读表"的口径一致，
 * 另写一套轻量检查（比如只查文件头是不是 PK）挡不住"合法 ZIP、里面根本不是这张表"。
 * 从生成的启动器位置反推插件根，再用 `createRequire` 以插件根为基准解析依赖
 * （启动器自己在 data/ 里，直接 import 会找不到 jszip）。
 * @returns {Promise<string>} 空串 = 通过；否则是拒绝原因（中文）
 */
const requireFromPlugin = createRequire(path.join(PLUGIN_ROOT, "package.json"))
const acceptWorkbook = async bytes => {
  let openWorkbook, buildModel
  try {
    /** 从 `PLUGIN_ROOT` 得到的 require 是**以那个目录为基准**的，所以这里直接用插件内的相对路径 */
    ;({ openWorkbook } = await import(pathToFileURL(requireFromPlugin.resolve("./lib/xlsx.js")).href))
    ;({ buildModel } = await import(pathToFileURL(requireFromPlugin.resolve("./lib/schema.js")).href))
  } catch (err) {
    return `验收组件不可用（${err?.message ?? err}）`
  }
  let wb
  try {
    wb = await openWorkbook(bytes)
  } catch (err) {
    return `不是能读的 xlsx：${err?.message ?? err}`
  }
  if (!wb.sheets?.length) return "里面没有任何工作表"
  for (const sheet of wb.sheets) {
    let model
    try {
      model = buildModel({ name: sheet.name, xml: await wb.sheetXml(sheet.name), shared: wb.shared })
    } catch (err) {
      return `工作表「${sheet.name}」解析不出结构：${err?.message ?? err}`
    }
    const missing = REQUIRED_COLUMNS.filter(([key]) => !model.col?.[key]).map(([, label]) => label)
    if (missing.length) return `工作表「${sheet.name}」的表头缺少：${missing.join("、")}`
  }
  return ""
}

/** 诊断落点带时间戳：反复失败不会互相覆盖，主人能逐份看 */
const stamp = () => {
  const d = new Date()
  const pad = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const pullFromCloud = async () => {
  if (!cloud || !token) return "（没配云端地址：直接用本机这份）"
  try {
    const res = await fetch(`${cloud.replace(/\/+$/, "")}/api/snapshot?k=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1024) throw new Error(`内容过小（${buf.length} 字节）`)

    /** 先验收，再动磁盘上的任何一份文件 */
    const rejected = await acceptWorkbook(buf)
    if (rejected) {
      const bad = `${xlsxPath}.pull-${stamp()}.xlsx`
      try {
        fs.mkdirSync(path.dirname(bad), { recursive: true })
        fs.writeFileSync(bad, buf)
      } catch {
        /* 诊断文件写不了也不能因此覆盖主文件 */
      }
      throw new Error(`云端这份没通过工作簿验收（${rejected}）；已另存诊断副本：${bad}`)
    }

    /** 替换是"临时文件 → rename"的原子替换；.bak 只在验收通过之后才动 */
    const tmp = `${xlsxPath}.pull.tmp`
    fs.writeFileSync(tmp, buf)
    if (fs.existsSync(xlsxPath)) fs.copyFileSync(xlsxPath, `${xlsxPath}.bak`)
    fs.renameSync(tmp, xlsxPath)
    return `已从云端拉取最新一份（${Math.round(buf.length / 1024)}KB，已通过工作簿验收）`
  } catch (err) {
    if (fs.existsSync(xlsxPath)) return `拉取失败（${err.message}），沿用本机现有那份`
    throw new Error(`拉取云端表失败，本机也没有副本：${err.message}`)
  }
}

if (!cloud && !fs.existsSync(xlsxPath)) {
  /** 本机还没有表：用插件自带的空模板起一份（换月/新部署都这么开始） */
  const template = path.join(path.dirname(editorPath), "..", "resources", "空模板.xlsx")
  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true })
  if (fs.existsSync(template)) {
    fs.copyFileSync(template, xlsxPath)
    say(`本机还没有表，已用插件自带的空模板起一份：${xlsxPath}`)
  } else {
    fail(`本机没有 ${xlsxPath}，也没找到空模板 ${template}`)
  }
}
say(await pullFromCloud().catch(err => fail(err.message)))

/** 3) 以主人专用模式起编辑器（云端与本机用同一套口令/签名密钥） */
const args = [
  editorPath,
  "--file", xlsxPath,
  "--port", String(PORT),
  "--bind", BIND,
  "--log", LOG_FILE,
  "--owner-only",
  /**
   * 本机这份挂在**根目录**（插件 remote.url 就是 http://<本机>:7788，没有子路径）：
   * 显式传空，免得编辑器按默认的 /queue 拼进短链跳转（虽然它两种前缀都认，但地址不该多一段）
   */
  "--mount", "",
]
if (token) args.push("--token", token)
if (signKey) args.push("--sign-key", signKey)
if (cloud) args.push("--cloud", cloud)
const child = spawn(process.execPath, args, {
  cwd: path.dirname(editorPath),
  detached: true, // 自己一组，不随启动器退出
  windowsHide: true, // 不分配控制台窗口 -> 不会被 SIGHUP 带走
  stdio: "ignore", // 日志由 --log 自己写
})
child.unref()
say(`已启动编辑器（PID ${child.pid}）：${xlsxPath}${cloud ? ` · 云端 ${cloud}` : ""}`)

/** 4) 把"带主人身份的页面地址"写进 editor-url.txt，让快捷方式脚本去打开 */
const wait = ms => new Promise(r => setTimeout(r, ms))
const ownerIdentity = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(ADMINS_FILE, "utf8").replace(/^\uFEFF/, ""))
    const first = (Array.isArray(raw?.owner) ? raw.owner : []).map(s => String(s).trim()).filter(Boolean)[0]
    if (!first) return null
    /** owner 写 QQ 就是 QQ，写群昵称就当昵称（编辑器两种都认） */
    return /^\d+$/.test(first) ? { qq: first, nick: "" } : { qq: "", nick: first }
  } catch {
    return null
  }
}

const owner = ownerIdentity()
if (!owner) say("注意：白名单文件里没写 owner，主人专用模式下没人能打开页面")
const { editorUrl } = await import(pathToFileURL(path.join(path.dirname(editorPath), "..", "lib", "identity.js")).href)
const localUrl = editorUrl(`http://127.0.0.1:${PORT}`, { token, signKey, ...(owner ?? {}) }) || `http://127.0.0.1:${PORT}/`
fs.writeFileSync(URL_FILE, localUrl + "\n", "utf8")

for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz${token ? `?k=${encodeURIComponent(token)}` : ""}`)
    if (res.ok) {
      say("编辑器就绪，地址已写入 editor-url.txt")
      try {
        fs.writeFileSync(LAUNCH_LOG, notes.join("\r\n") + "\r\n", "utf8")
      } catch {
        /* 写不了就算了 */
      }
      process.exit(0)
    }
  } catch {
    /* 还没起来 */
  }
  await wait(400)
}
fail(`编辑器没有在 16 秒内起来，看看日志：${LOG_FILE}`)
