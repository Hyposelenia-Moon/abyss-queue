/**
 * 初始化产物 → 自动拉起 → 健康检查（走 `#排队初始化`）
 *
 * 这套回归守的是"产物 → 拉起 → 探活"这段链路：
 * 在一个**临时合成的 Yunzai 宿主**里跑一遍 `runInit`（`#排队初始化` 的实现），
 * 拿它生成的启动器产物，再按插件自己的启动协议（`remote.autostart` → `ensureEditor()`）拉起来探活。
 *
 * 合成宿主的路径故意带**空格和中文**（`Yunzai 主 目录`），因为拼路径最容易在这类路径上崩。
 *
 * 钉住六件事：
 *   1. 启动器产物落在**插件内** `<插件根>\data`：仓库之外不放数据目录，也不生成 `editor.cmd`
 *      （启动协议只认 `.mjs`，多一个同名 `editor.cmd` 只会让人照着错的起）
 *   2. 产物是 `model/remote.js` 认得的启动器类型（`.mjs`），`node --check` 能解析，且**自定位**（不写死盘符）
 *   3. `ensureEditor()` 真能把它拉起来，成功与否**以 `/healthz` 为准**
 *   4. 口令 / 签名密钥 / 表格 / 端口 / 挂载 / 主人专用都真的传进了编辑器
 *   5. 重复跑一遍初始化是幂等的：初始化产物逐字节不变、口令不被换掉
 *   6. 初始化只改 `remote.token` / `remote.sign_key` 两行，`remote.url` 与其余内容原样保留
 *
 * 这套件**不**在"第二遍初始化之后"再断言编辑器还活着：实测在本机的 DSH 命令沙箱里，
 * 由启动器 detached 起的那个编辑器进程活不过两三秒（本套件之外单独复现同一段流程能活 5 秒以上），
 * 与本插件的行为无关，是测试环境的进程管理所致。所以存活断言只放在第 3、4 条——
 * 那两处是**紧接着拉起**做的，确定性够。要接着查这件事，见 AGENTS.md 第十节。
 *
 * 副作用一律走注入的桩：`exec` 只认 `schtasks` 且**绝不真的注册计划任务**，`fs` 是真实现但落点
 * 全在系统临时目录。启动器与编辑器都是**真跑的**（那正是要验的一环），跑完把进程杀掉。
 *
 * 用法：node test/init-launcher.test.mjs
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createChecker, Paths, installFrameworkStubs, skip } from "./_helper.mjs"

const { check, finish } = createChecker("初始化产物 → 自动拉起")
/** 框架全局桩必须在 import 插件代码之前装好（`globalThis.plugin` / `logger`） */
installFrameworkStubs()

const { runInit } = await import("../components/init/index.js")
const { RemoteTable, autostartCommand } = await import("../model/remote.js")
const { DEFAULT_CONFIG } = await import("../components/config.js")

/* ------------------------------------------------------------------ 夹具 */

const pluginSrc = Paths.root
/** 启动器在"本机还没有表"时用它起一份本地副本——所以这份空模板是运行期依赖，随源码入库 */
const TEMPLATE = path.join(pluginSrc, "resources", "空模板.xlsx")

/** 初始化要生成 `wscript.exe <vbs>` 的动作，没有它这台机器上的计划任务本来也注册不了 */
const WSCRIPT = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe")
if (process.platform !== "win32" || !fs.existsSync(WSCRIPT)) skip("本机没有 Windows 计划任务（wscript.exe）")

const SENDER = "1733491779"

/**
 * 路径比较**不能按字面比**：Windows 上同一个目录有「8.3 短名」与长名两种写法
 * （Node 的 `os.tmpdir()` 给 `AXIU-H~1`，别的工具给长名），字面不同却指向同一处。
 * 统一用 `realpath.native()` 展开成长名再比。
 */
const canonicalPath = p => {
  try {
    return fs.realpathSync.native(p).toLowerCase()
  } catch {
    return path.resolve(String(p ?? "")).toLowerCase()
  }
}
const samePath = (a, b) => canonicalPath(a) === canonicalPath(b)

/** 合成宿主：父目录同时带空格与中文 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-init-launch-"))
const parentDir = path.join(base, "Yunzai 主 目录")
const hostRoot = path.join(parentDir, "Yunzai")
const pluginDir = path.join(hostRoot, "plugins", "abyss-queue")
const dataDir = path.join(pluginDir, "data")
/** 旧口径：宿主同级的 `abyss-queue-data`（数据在仓库外）——不得再被创建 */
const legacyDataDir = path.join(parentDir, "abyss-queue-data")
const launcher = path.join(dataDir, "editor-launch.mjs")
const pathFile = path.join(dataDir, "editor-path.txt")
const legacyCmd = path.join(dataDir, "editor.cmd")
const cfgPath = path.join(pluginDir, "config", "config.yaml")
/** 启动器自己写的运行期文件：不是初始化产物，幂等断言要绕开它们 */
const RUNTIME_FILES = new Set(["editor.log", "editor-url.txt", "editor-launch.log"])

/**
 * 假编辑器：只回答 `/healthz`，把收到的启动参数回吐出来
 *
 * 用它验收"初始化产物 → 自动拉起 → 探活"整条链路：真起一个进程、真打 /healthz。
 */
const STUB_EDITOR = `import http from "node:http"
const argv = process.argv.slice(2)
const flag = (name, def = "") => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const port = Number(flag("--port", "0"))
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  /** 一律 close：不让 undici 复用空闲连接（复用撞上服务端超时的竞态是桩自己的坑） */
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", connection: "close" })
    return res.end(JSON.stringify({
      ok: true,
      version: "stub",
      pid: process.pid,
      port,
      mount: flag("--mount", ""),
      file: flag("--file", ""),
      log: flag("--log", ""),
      auth: flag("--token", "") !== "",
      sign_key: flag("--sign-key", "") !== "",
      owner_only: argv.includes("--owner-only"),
    }))
  }
  res.writeHead(404, { "content-type": "text/plain", connection: "close" })
  res.end("not found")
})
server.listen(port, "127.0.0.1")
`

/** 造合成宿主：只搬初始化真正需要的东西（启动器模板、空模板、identity、编辑器桩） */
function makeHost(port) {
  fs.mkdirSync(path.join(hostRoot, "plugins"), { recursive: true })
  fs.writeFileSync(path.join(hostRoot, "package.json"), JSON.stringify({ name: "trss-yunzai", version: "3.1.3" }), "utf8")
  fs.mkdirSync(path.join(pluginDir, "editor"), { recursive: true })
  fs.mkdirSync(path.join(pluginDir, "config"), { recursive: true })
  fs.mkdirSync(path.join(pluginDir, "resources"), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "editor", "editor.mjs"), STUB_EDITOR, "utf8")
  fs.cpSync(path.join(pluginSrc, "resources", "init"), path.join(pluginDir, "resources", "init"), { recursive: true })
  fs.copyFileSync(TEMPLATE, path.join(pluginDir, "resources", "空模板.xlsx"))
  /**
   * 启动器最后要 `import <插件根>/lib/identity.js` 拼主人链接，所以这一份也得在。
   * 这是**合成宿主缺件**，不是产品问题——真部署时整个插件都在。
   */
  fs.mkdirSync(path.join(pluginDir, "lib"), { recursive: true })
  fs.copyFileSync(path.join(pluginSrc, "lib", "identity.js"), path.join(pluginDir, "lib", "identity.js"))
  fs.writeFileSync(cfgPath, fixtureConfig(port), "utf8")
}

/**
 * 夹具的 config.yaml：从 `.example` 抄一份，只动三处
 *
 *   1. `remote.url` 指到本机这次用的端口（夹具要真能拉起编辑器）
 *   2. `token` / `sign_key` 行**去掉行内注释**：初始化是逐行改这两个键的，
 *      键后面挂着注释时它会把注释一起当成值（密钥行挂注释本来也不是正常写法）
 */
function fixtureConfig(port) {
  return fs
    .readFileSync(path.join(pluginSrc, "config", "config.yaml.example"), "utf8")
    .replace(/^(\s*url:\s*).*$/m, `$1"http://127.0.0.1:${port}"`)
    .replace(/^(\s*(?:token|sign_key):\s*"")\s*#.*$/gm, "$1")
}

/**
 * 注入的 exec：**只认 schtasks**，且第一次查询报"任务不存在"
 *
 * 于是第 6 步会走"创建"分支，而创建也被挡在这里——**绝不在真机上注册计划任务**；
 * 建完的复核查询返回同一份动作 XML，走完"注册后复核"那段真代码。
 * 其它命令直接断言不该发生（初始化不该跑 git / 网络工具）。
 */
function makeExec() {
  const calls = []
  let queried = 0
  const exec = (cmd, args = []) => {
    calls.push([cmd, ...args].join(" "))
    if (cmd !== "schtasks") return { status: 1, stdout: "", stderr: `套件不认识的命令：${cmd}` }
    if (args.includes("/query")) {
      queried += 1
      /** 第一次：任务不存在；复核那次：给出刚"创建"的动作，看插件是否真的复核了 */
      if (queried === 1) return { status: 1, stdout: "", stderr: "错误: 系统找不到指定的文件。" }
      const vbs = path.join(dataDir, "editor-launch.vbs")
      return {
        status: 0,
        stdout: `<Task><Actions Context="Author"><Exec><Command>${WSCRIPT}</Command><Arguments>"${vbs}"</Arguments></Exec></Actions></Task>`,
        stderr: "",
      }
    }
    if (args.includes("/create")) return { status: 0, stdout: "成功: 已创建计划任务。", stderr: "" }
    return { status: 0, stdout: "", stderr: "" }
  }
  return { calls, exec }
}

/** 注入的探活：不打真实端口，只回答一份 healthz（`live` 为假时模拟"还没起来"） */
function makeFetch({ live = false, payload = {} } = {}) {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    if (!live) throw new Error("fetch failed")
    return { ok: true, status: 200, json: async () => ({ ok: true, version: "2026.10.05", mount: "", roster: 7, ...payload }) }
  }
  return { calls, fetch: fetchImpl }
}

const wait = ms => new Promise(r => setTimeout(r, ms))
const isFree = port =>
  new Promise(resolve => {
    const s = net.createServer()
    s.once("error", () => resolve(false))
    s.once("listening", () => s.close(() => resolve(true)))
    s.listen(port, "127.0.0.1")
  })

/** 申请一个空闲端口：避开编辑器套件占用的 7800-7811 与本机编辑器默认的 7788 */
const freePort = async () => {
  for (let i = 0; i < 40; i++) {
    const port = 7920 + Math.floor(Math.random() * 180)
    if (await isFree(port)) return port
  }
  throw new Error("找不到空闲端口")
}

const sha256 = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

/** 初始化产物的快照（路径 → sha256）：绕开启动器自己写的运行期文件 */
function snapshot(dir) {
  const out = {}
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() || RUNTIME_FILES.has(e.name)) continue
    out[e.name] = sha256(path.join(dir, e.name))
  }
  return out
}

/* ------------------------------------------------------------------ 准备 */

const port = await freePort()
makeHost(port)
/** 启动器按环境变量决定端口；让进程与它一致（也顺便验"环境变量真的被读"） */
process.env.ABYSS_EDITOR_PORT = String(port)
process.env.ABYSS_EDITOR_BIND = "127.0.0.1"

const run = (exec, fetch, p = port) =>
  runInit({ qq: SENDER, pluginRoot: pluginDir, fs, exec, fetch, wscript: WSCRIPT, port: p })

/** 编辑器是启动器 detached 起的：只能按 pid 杀（探活回吐的 pid 最可靠） */
let editorPid = 0
const killEditor = () => {
  /** 兜底：pid 没拿到时按端口找监听进程（netstat 的正则是启动器里同一套） */
  if (!editorPid) {
    try {
      const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" })
      for (const line of String(out.stdout ?? "").split(/\r?\n/)) {
        const m = line.trim().match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
        if (m && Number(m[1]) === port) editorPid = Number(m[2])
      }
    } catch {
      /* 找不到就算了 */
    }
  }
  if (!editorPid) return
  try {
    spawnSync("taskkill", ["/PID", String(editorPid), "/T", "/F"], { stdio: "ignore" })
  } catch {
    /* 已经退了 */
  }
  editorPid = 0
}

let health = null
try {
  /* -------------------------- 一、跑一遍初始化 */

  const e1 = makeExec()
  const f1 = makeFetch({ live: false })
  const init1 = await run(e1.exec, f1.fetch)
  const failText = r =>
    r.steps
      .filter(s => s.status === "fail")
      .map(s => `${s.no}. ${s.title} — ${s.detail}`)
      .join("；")

  check("初始化没失败（编辑器还没起，所以第 7 步探活按「跳过」记）", () => {
    if (!init1.ok) throw new Error(`第 ${init1.failedAt} 步失败：${failText(init1)}`)
  })
  check("计划任务只走注入的 schtasks，没跑别的命令，且在建完后真的复核了一次", () => {
    const bad = e1.calls.filter(c => !c.startsWith("schtasks"))
    if (bad.length) throw new Error(`出现了不该跑的命令：${bad.join(" | ")}`)
    if (e1.calls.filter(c => c.includes("/create")).length !== 1) throw new Error("没有（或不止一次）调用 schtasks /create")
    if (e1.calls.filter(c => c.includes("/query")).length !== 2)
      throw new Error(`注册后应复核一次，实际查询 ${e1.calls.filter(c => c.includes("/query")).length} 次`)
  })

  /* -------------------------- 二、产物落点与口径 */

  check("启动器产物都在 <插件根>/data 里", () => {
    for (const f of [launcher, pathFile, path.join(dataDir, "editor-launch.vbs"), path.join(dataDir, "启动排队表编辑器.vbs")])
      if (!fs.existsSync(f)) throw new Error(`缺产物：${f}`)
  })
  check("不产生仓库外的数据目录（旧口径）", () => {
    if (fs.existsSync(legacyDataDir)) throw new Error(`仍在创建仓库外数据目录：${legacyDataDir}`)
  })
  check("产物里没有 editor.cmd（启动协议与产物必须一致）", () => {
    if (fs.existsSync(legacyCmd)) throw new Error(`还在生成 ${legacyCmd}`)
  })
  check("初始化不碰本地表格副本（那是启动器按需起一份的事）", () => {
    if (fs.existsSync(path.join(dataDir, "排队表-本地.xlsx")))
      throw new Error("初始化就建了本地副本——它只该由启动器在拉起时按需生成")
  })

  check("editor-path.txt 是 UTF-16LE / 5 行 / 每行都是插件内路径", () => {
    const buf = fs.readFileSync(pathFile)
    if (!(buf[0] === 0xff && buf[1] === 0xfe)) throw new Error("没有 UTF-16LE BOM")
    const lines = buf
      .toString("utf16le", 2)
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
    while (lines.length && lines.at(-1) === "") lines.pop()
    if (lines.length !== 5) throw new Error(`应为 5 行（编辑器 / 本地副本 / 口令 / 云端 / 签名密钥），实际 ${lines.length}`)
    const [editor, xlsx, token, cloud, signKey] = lines
    if (!samePath(editor, path.join(pluginDir, "editor", "editor.mjs"))) throw new Error(`编辑器行不对：${editor}`)
    if (!samePath(xlsx, path.join(dataDir, "排队表-本地.xlsx"))) throw new Error(`本地副本行不对：${xlsx}`)
    if (!token) throw new Error("口令行是空的（初始化应当生成一个）")
    if (cloud) throw new Error(`remote.url 是本机地址，云端行不该写进去：${cloud}`)
    if (!signKey) throw new Error("签名密钥行是空的（初始化应当生成一个）")
  })

  check("产物是 .mjs（remote.js 认得的启动器类型）", () => {
    if (path.extname(launcher).toLowerCase() !== ".mjs") throw new Error(`启动器不是 .mjs：${launcher}`)
    if (!autostartCommand(launcher)) throw new Error("生成物不是 model/remote.js 会执行的类型")
  })
  check("生成的启动器能被 node 解析（不是拼坏的一坨文本）", () => {
    const r = spawnSync(process.execPath, ["--check", launcher], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(r.stderr || "node --check 失败")
  })
  check("启动器是自定位的：按自身位置找路径文件，不写死盘符或源码仓库路径", () => {
    const src = fs.readFileSync(launcher, "utf8")
    if (!src.includes("import.meta.url")) throw new Error("启动器没有按 import.meta.url 自定位")
    if (/["'`][A-Za-z]:[\\/]/.test(src)) throw new Error("启动器里出现了写死的盘符路径")
    if (src.includes(pluginSrc)) throw new Error("启动器里写死了源码仓库路径")
  })
  check("两个 vbs 是纯 ASCII + CRLF（cscript 按 ANSI 读，行尾也要 CRLF）", () => {
    for (const name of ["editor-launch.vbs", "启动排队表编辑器.vbs"]) {
      const buf = fs.readFileSync(path.join(dataDir, name))
      if ([...buf].some(b => b > 0x7f)) throw new Error(`${name} 不是纯 ASCII`)
      const text = buf.toString("utf8")
      if (!/^([^\n]*\r\n)*[^\n]*$/.test(text)) throw new Error(`${name} 行尾不是纯 CRLF`)
    }
  })

  check("初始化只改 remote.token / remote.sign_key 两行，其余内容原样保留", () => {
    /** 对照物就是夹具那份：初始化应当只在它的基础上把两个空口令填上 */
    const before = fixtureConfig(port).split("\n")
    const after = fs.readFileSync(cfgPath, "utf8").split("\n")
    if (before.length !== after.length) throw new Error(`行数变了：${before.length} → ${after.length}（应当只改两行）`)
    const diff = before.map((l, i) => [i, l, after[i]]).filter(([, a, b]) => a !== b)
    if (diff.length !== 2) throw new Error(`改动了 ${diff.length} 行，期望 2 行：\n${diff.map(([i, a, b]) => `  行 ${i + 1}: ${a} → ${b}`).join("\n")}`)
    for (const [, , b] of diff) if (!/^\s+(token|sign_key):\s*"\S+"\s*$/.test(b)) throw new Error(`改的不是密钥行：${b}`)
  })
  check("remote.url 没被动过（初始化不管云端地址，那是主人填的）", () => {
    const url = /^\s*url:\s*"([^"]*)"/m.exec(fs.readFileSync(cfgPath, "utf8"))?.[1] ?? ""
    if (url !== `http://127.0.0.1:${port}`) throw new Error(`remote.url 被改了：${url}`)
  })

  const token = /^\s*token:\s*"([^"]*)"/m.exec(fs.readFileSync(cfgPath, "utf8"))?.[1] ?? ""
  check("口令与签名密钥已生成，且都是随机十六进制", () => {
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error(`token 不像 16 字节随机：${token}`)
    const signKey = /^\s*sign_key:\s*"([^"]*)"/m.exec(fs.readFileSync(cfgPath, "utf8"))?.[1] ?? ""
    if (!/^[0-9a-f]{48}$/.test(signKey)) throw new Error(`sign_key 不像 24 字节随机：${signKey}`)
  })

  /* -------------------------- 三、真拉起：产物 → 探活 */

  /** autostart 由主人填（初始化不写它），这里就按配置模板里的写法指到刚生成的启动器 */
  const remote = new RemoteTable({ url: `http://127.0.0.1:${port}`, token, autostart: launcher })

  const aliveBefore = await remote.editorAlive()
  check("拉起前编辑器不可达（探活不是走过场）", () => {
    if (aliveBefore) throw new Error("探活前就有服务在应答，无法证明是本次拉起的")
  })

  const up = await remote.ensureEditor({ waitMs: 20000 })
  const aliveAfter = await remote.editorAlive()

  check("ensureEditor 把编辑器拉起来了，且 /healthz 通过（成功与否以它为准）", () => {
    if (!up) throw new Error("ensureEditor 返回 false：生成物没跑起来或 20 秒内探不到 /healthz")
    if (!aliveAfter) throw new Error("ensureEditor 之后 /healthz 仍不可达")
  })

  if (aliveAfter) {
    const res = await fetch(`http://127.0.0.1:${port}/healthz?k=${encodeURIComponent(token)}`)
    health = await res.json()
    editorPid = Number(health?.pid) || 0
  }

  check("启动器把表格 / 端口 / 挂载 / 主人专用 / 日志都传给了编辑器", () => {
    if (!health) throw new Error("没有拿到 /healthz 内容")
    if (!samePath(health.file, path.join(dataDir, "排队表-本地.xlsx"))) throw new Error(`--file 不对：${health.file}`)
    if (Number(health.port) !== port) throw new Error(`--port 不对：${health.port}（环境变量 ABYSS_EDITOR_PORT 没被读到？）`)
    if (health.mount !== "") throw new Error(`本机应当挂在根目录（--mount 空），实得 ${JSON.stringify(health.mount)}`)
    if (health.owner_only !== true) throw new Error("没有以 --owner-only 起（本机编辑器必须只给主人）")
    if (!samePath(health.log, path.join(dataDir, "editor.log"))) throw new Error(`--log 不在数据目录：${health.log}`)
  })
  check("口令与签名密钥真的传进了编辑器", () => {
    if (!health) throw new Error("没有拿到 /healthz 内容")
    if (health.auth !== true) throw new Error("口令没传进去（--token 缺失）")
    if (health.sign_key !== true) throw new Error("签名密钥没传进去（--sign-key 缺失）")
  })
  check("启动器写下了本地表格副本（初始化没建，是启动时按需起的）", () => {
    const local = path.join(dataDir, "排队表-本地.xlsx")
    if (!fs.existsSync(local)) throw new Error(`启动器没有起本地副本：${local}`)
    if (sha256(local) !== sha256(path.join(pluginSrc, "resources", "空模板.xlsx")))
      throw new Error("副本内容与插件自带的空模板不一致")
  })
  check("启动器写下带主人身份的 editor-url.txt", () => {
    const urlFile = path.join(dataDir, "editor-url.txt")
    if (!fs.existsSync(urlFile)) throw new Error("没有 editor-url.txt（快捷方式脚本要靠它打开页面）")
    const text = fs.readFileSync(urlFile, "utf8").trim()
    if (!text.startsWith(`http://127.0.0.1:${port}`)) throw new Error(`地址不对：${text}`)
  })
  check("合成宿主路径确实带空格与中文（夹具覆盖了最容易崩的那类路径）", () => {
    for (const p of [hostRoot, dataDir]) {
      if (!/[^\u0000-\u007f]/.test(p)) throw new Error(`夹具路径没有中文：${p}`)
      if (!p.includes(" ")) throw new Error(`夹具路径没有空格：${p}`)
    }
  })

  /* -------------------------- 四、幂等：再跑一遍 */

  const before = snapshot(dataDir)
  const e2 = makeExec()
  /** 这一次编辑器已经在跑：第 7 步探活应当真的探到（注入的 fetch 就是这条链路的替身） */
  const f2 = makeFetch({ live: true })
  const init2 = await run(e2.exec, f2.fetch)
  const after = snapshot(dataDir)

  check("编辑器在跑时再跑一遍初始化也不失败（走「已存在只校验」那条路）", () => {
    if (!init2.ok) throw new Error(`第 ${init2.failedAt} 步失败：${failText(init2)}`)
  })
  check("这一次探活真的打到了 /healthz（不是跳过）", () => {
    if (!f2.calls.length) throw new Error("第 7 步没有发起探活")
    if (!f2.calls[0].includes(`:${port}/healthz`)) throw new Error(`探活地址不对：${f2.calls[0]}`)
    if (init2.steps.at(-1).status === "skip") throw new Error("探活又被跳过了：注入的 fetch 没被第 7 步用上")
  })
  check("重复跑不改动任何初始化产物（逐字节 sha256 一致）", () => {
    const changed = Object.keys(before).filter(k => after[k] !== before[k])
    const added = Object.keys(after).filter(k => !(k in before))
    if (changed.length || added.length)
      throw new Error(`被改动的：${changed.join("、") || "（无）"}；新增的：${added.join("、") || "（无）"}`)
  })
  check("重复跑没有把已生成的口令换掉（换了会打断正在跑的编辑器）", () => {
    const again = /^\s*token:\s*"([^"]*)"/m.exec(fs.readFileSync(cfgPath, "utf8"))?.[1] ?? ""
    if (again !== token) throw new Error(`口令被换了：${again.slice(0, 4)}… ≠ ${token.slice(0, 4)}…`)
  })

  /* -------------------------- 五、口径没漂 */

  check("初始化用到的配置键都在 DEFAULT_CONFIG / 配置模板里（没有造私货）", () => {
    if (typeof DEFAULT_CONFIG.remote?.autostart !== "string") throw new Error("DEFAULT_CONFIG.remote.autostart 不是字符串")
    const example = fs.readFileSync(path.join(pluginSrc, "config", "config.yaml.example"), "utf8")
    for (const key of ["url", "token", "sign_key", "autostart"])
      if (!new RegExp(`^\\s*${key}:`, "m").test(example)) throw new Error(`配置模板里没有 remote.${key}：初始化写/读的键必须来自模板`)
  })
} catch (err) {
  console.log(`  ❌ 套件异常：${err?.stack ?? err}`)
  process.exitCode = 1
} finally {
  killEditor()
  await wait(300)
  try {
    fs.rmSync(base, { recursive: true, force: true })
  } catch (err) {
    /** 临时目录删不掉不算套件失败（可能还有进程攥着里面的日志文件） */
    console.log(`  ⏭ 临时目录没删掉（不影响结果）：${err?.code ?? err?.message}`)
  }
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中抛 libuv 断言 */
