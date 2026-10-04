/**
 * 部署产物 → 健康检查（审核 AQ-11 + 「宿主目录与网络部署职责」三条边界）
 *
 * 这套回归不碰真实机器人：在一个**临时合成的 Yunzai 宿主**里放一份部署脚本副本，
 * 像真部署一样跑一遍，然后按插件自己的启动协议把生成物拉起来做探活。
 * 合成的宿主路径故意带**空格和中文**（`Yunzai 主 目录`），
 * 因为老实现生成 `.cmd` + 引号拼路径，这类路径最容易崩。
 *
 * 钉住四件事：
 *   1. 宿主根从脚本自身位置（$PSScriptRoot）推导，不问维护者路径、不看 cwd；
 *      数据目录固定在**插件内**（`<插件根>\data`）且**不可配置**（`-DataDir` 参数已删除，
 *      传了会被 PowerShell 直接拒绝），不再派生成宿主同级的仓库外目录——
 *      数据留在插件里 + `data/` 已被 git 忽略，`#更新 abyss` 才只动代码不动数据
 *   2. 部署产物必须是 `model/remote.js` 支持的启动器类型（`.mjs`），不再生成 `.cmd`
 *   3. 启动成功以 `/healthz` 探活为准：拉起后探不到就不算成功
 *   4. 脚本里不再有 nginx 配置生成、nginx 探测或重载指引（网络交给服务器所有者）
 *
 * 用法：node test/deploy-windows.test.mjs
 */
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createChecker, Paths, skip } from "./_helper.mjs"
import { RemoteTable, autostartCommand } from "../model/remote.js"

const { check, finish } = createChecker("部署产物 → 健康检查")

/** 5.1 / 7 都行：脚本要能在这台机器的 PowerShell 上跑 */
const PS = ["pwsh", "powershell"].find(c => spawnSync(c, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0)
if (!PS) skip("找不到 PowerShell（pwsh / powershell）")

const DEPLOY_SRC = path.join(Paths.root, "tools", "deploy-windows.ps1")
const TEMPLATE = path.join(Paths.root, "resources", "空模板.xlsx")
const EXAMPLE = path.join(Paths.root, "config", "config.yaml.example")
if (!fs.existsSync(DEPLOY_SRC) || !fs.existsSync(TEMPLATE) || !fs.existsSync(EXAMPLE))
  skip("缺少部署脚本 / 空模板 / 配置模板")

/** 合成的宿主：路径里同时有空格和中文 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-deploy-"))
const parentDir = path.join(base, "Yunzai 主 目录")
const hostRoot = path.join(parentDir, "Yunzai")
const pluginDir = path.join(hostRoot, "plugins", "abyss-queue")
const deployInHost = path.join(pluginDir, "tools", "deploy-windows.ps1")
const dataDir = path.join(pluginDir, "data") // 部署脚本按插件根推出的默认值（固定在插件内）
/** 旧口径：宿主同级的 `abyss-queue-data`（数据在仓库外）——不得再被创建 */
const legacyDataDir = path.join(parentDir, "abyss-queue-data")
const launcher = path.join(dataDir, "editor-launch.mjs")
const legacyCmd = path.join(dataDir, "editor.cmd")
const cfgPath = path.join(pluginDir, "config", "config.yaml")

/**
 * 路径比较**不能按字面比**：Windows 上同一个目录有「8.3 短名」与长名两种写法
 * （Node 的 `os.tmpdir()` 给 `AXIU-H~1`，PowerShell 的 `$PSScriptRoot` 给 `Axiu-Hyper-V`），
 * 字面不同却指向同一处。统一用 `realpath.native()` 展开成长名再比，全文件共用。
 */
const canonicalPath = p => {
  try {
    return fs.realpathSync.native(p).toLowerCase()
  } catch {
    return path.resolve(String(p ?? "")).toLowerCase()
  }
}
const samePath = (a, b) => canonicalPath(a) === canonicalPath(b)

/** 假编辑器：只回答 /healthz，用来验收"部署产物 → 启动 → 探活"整条链路 */
const STUB_EDITOR = `import http from "node:http"
const argv = process.argv.slice(2)
const flag = (name, def = "") => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const port = Number(flag("--port", "0"))
const mount = flag("--mount", "").replace(/\\/+$/, "")
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  const inner = mount && (url.pathname === mount || url.pathname.startsWith(mount + "/")) ? url.pathname.slice(mount.length) || "/" : url.pathname
  if (inner === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      ok: true,
      version: "stub",
      port,
      mount,
      auth: Boolean(process.env.ABYSS_EDITOR_TOKEN),
      sign_key: Boolean(process.env.ABYSS_EDITOR_SIGN_KEY),
      roster_qq: process.env.ABYSS_EDITOR_ROSTER_QQ || "",
    }))
  }
  res.writeHead(404, { "content-type": "text/plain" })
  res.end("not found")
})
server.listen(port, "127.0.0.1")
`

fs.mkdirSync(path.join(hostRoot, "plugins"), { recursive: true })
fs.writeFileSync(path.join(hostRoot, "package.json"), JSON.stringify({ name: "trss-yunzai", version: "3.1.3" }), "utf8")
fs.writeFileSync(path.join(hostRoot, "app.js"), "", "utf8")
fs.mkdirSync(path.join(pluginDir, "tools"), { recursive: true })
fs.copyFileSync(DEPLOY_SRC, deployInHost)
fs.mkdirSync(path.join(pluginDir, "config"), { recursive: true })
fs.copyFileSync(EXAMPLE, cfgPath)
fs.mkdirSync(path.join(pluginDir, "resources"), { recursive: true })
fs.copyFileSync(TEMPLATE, path.join(pluginDir, "resources", path.basename(TEMPLATE)))
fs.mkdirSync(path.join(pluginDir, "editor"), { recursive: true })
fs.writeFileSync(path.join(pluginDir, "editor", "editor.mjs"), STUB_EDITOR, "utf8")

const wait = ms => new Promise(r => setTimeout(r, ms))
const isFree = port =>
  new Promise(resolve => {
    const s = net.createServer()
    s.once("error", () => resolve(false))
    s.once("listening", () => s.close(() => resolve(true)))
    s.listen(port, "127.0.0.1")
  })

/** 申请一个空闲端口：避开编辑器套件占用的 7800-7811 */
const freePort = async () => {
  for (let i = 0; i < 30; i++) {
    const port = 7910 + Math.floor(Math.random() * 190)
    if (await isFree(port)) return port
  }
  throw new Error("找不到空闲端口")
}

const runDeploy = port =>
  spawnSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", deployInHost, "-Yes", "-Port", String(port), "-Mount", "/queue"], {
    encoding: "utf8",
    timeout: 120000,
  })

const killEditor = () => {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, "editor.pid"), "utf8").trim())
    if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
  } catch {
    /* 没有 pid 文件就没得杀 */
  }
}

let port = 0
let deploy = { status: -1, stdout: "", stderr: "" }
let oldNodeDeploy = { status: 0, stdout: "", stderr: "" }
let up = false
let aliveAfter = false
let aliveBefore = false
let healthJson = null

try {
  /** 端口冲突（EADDRINUSE）不是缺陷，换个端口重试；部署脚本成功但服务没起来也重试一次 */
  for (let attempt = 0; attempt < 3 && !up; attempt++) {
    if (attempt) {
      killEditor()
      await wait(5000) // 让别人占着的端口先释放
    }
    port = await freePort()
    deploy = runDeploy(port)
    if (deploy.status !== 0) break

    const cfgText = fs.readFileSync(`${cfgPath}`, "utf8")
    const token = /^\s*token:\s*"([^"]*)"/m.exec(cfgText)?.[1] ?? ""
    const autostart = (/^\s*autostart:\s*"([^"]*)"/m.exec(cfgText)?.[1] ?? "").replace(/\//g, "\\")
    const remote = new RemoteTable({ url: `http://127.0.0.1:${port}/queue`, token, autostart })

    aliveBefore = await remote.editorAlive()
    up = await remote.ensureEditor({ waitMs: 20000 })
    aliveAfter = await remote.editorAlive()
    if (up) {
      const res = await fetch(`http://127.0.0.1:${port}/queue/healthz?k=${token}`)
      healthJson = await res.json()
    }
  }

  const out = `${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`
  const cfgText = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : ""
  const autostartRaw = /^\s*autostart:\s*"([^"]*)"/m.exec(cfgText)?.[1] ?? ""
  const autostartPath = autostartRaw.replace(/\//g, "\\")
  const token = /^\s*token:\s*"([^"]*)"/m.exec(cfgText)?.[1] ?? ""
  const src = fs.readFileSync(deployInHost, "utf8")

  /** 再跑一遍：PATH 前面塞一个只会报旧版本的 node，检查版本判定真的会拦住部署 */
  const fakeBin = path.join(base, "假 node")
  fs.mkdirSync(fakeBin, { recursive: true })
  fs.writeFileSync(path.join(fakeBin, "node.cmd"), "@echo off\r\necho v18.0.0\r\n", "ascii")
  oldNodeDeploy = spawnSync(
    PS,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", deployInHost, "-Yes", "-Port", String(port), "-Mount", "/queue"],
    { encoding: "utf8", timeout: 120000, env: { ...process.env, PATH: `${fakeBin};${process.env.PATH ?? ""}` } },
  )
  const oldNodeOut = `${oldNodeDeploy.stdout ?? ""}\n${oldNodeDeploy.stderr ?? ""}`

  /** 编辑器已经在跑时再部署一次：幂等，而且这一步的健康探测要能真的探到 */
  const second = runDeploy(port)
  const secondOut = `${second.stdout ?? ""}\n${second.stderr ?? ""}`

  check("部署脚本在合成宿主里跑通（宿主根不问、不硬编码）", () => {
    if (deploy.status !== 0) throw new Error(`退出码 ${deploy.status}：${out.slice(-400)}`)
    if (!out.includes("plugin:")) throw new Error("输出里没有 plugin/host 推导结果")
  })

  /**
   * 口径断言：默认数据目录 == `<插件根>\data`
   *
   * 合成宿主的盘符/父目录都是临时目录（还带空格和中文），所以这里断言的是**相对插件根**，
   * 不写死维护者机器上的任何路径。旧口径（宿主同级的 `abyss-queue-data`）必须彻底消失：
   * 只要脚本还在仓库外建目录，这条就会红。
   */
  check("默认数据目录 == <插件根>/data（合成宿主内断言，不写死盘符）", () => {
    const expected = path.join(pluginDir, "data")
    if (!samePath(dataDir, expected)) throw new Error(`用例口径不是插件内：${dataDir}`)
    if (!fs.existsSync(expected)) throw new Error(`没有在插件内建数据目录：${expected}`)
    if (fs.existsSync(legacyDataDir)) throw new Error(`仍在创建仓库外数据目录（旧口径）：${legacyDataDir}`)
    if (!out.toLowerCase().includes(canonicalPath(expected)))
      throw new Error(`交接信息里的数据目录不是插件内那份：${expected}`)
    // 部署产物自己的落点也要在插件内：launcher 与它写下的 file/log/pidFile/editor 四个路径
    const cfg = JSON.parse(/const cfg = (\{.*\})/.exec(fs.readFileSync(launcher, "utf8"))?.[1] ?? "{}")
    if (!samePath(cfg.file ?? "", path.join(expected, "queue.xlsx"))) throw new Error(`启动器的表不在插件内：${cfg.file}`)
    if (!samePath(cfg.log ?? "", path.join(expected, "editor.log"))) throw new Error(`启动器的日志不在插件内：${cfg.log}`)
    if (!samePath(cfg.pidFile ?? "", path.join(expected, "editor.pid"))) throw new Error(`启动器的 pid 不在插件内：${cfg.pidFile}`)
    if (!samePath(cfg.editor ?? "", path.join(pluginDir, "editor", "editor.mjs")))
      throw new Error(`启动器没指向插件内编辑器：${cfg.editor}`)
  })

  check("空模板被复制成插件内数据目录的 queue.xlsx（数据目录固定，没有可传的覆盖项）", () => {
    if (!fs.existsSync(dataDir)) throw new Error(`没有在派生位置建数据目录：${dataDir}`)
    if (!fs.existsSync(path.join(dataDir, "queue.xlsx"))) throw new Error("没有从空模板复制出 queue.xlsx")
  })

  /**
   * 数据目录**不可配置**：`-DataDir` 这个参数必须彻底消失
   *
   * 老口径能 `-DataDir D:\somewhere` 把数据放到插件外；编辑器的生产口径已经拒绝这种启动
   * （表不在 `<插件根>\data` 里就报错退出），所以留着这个参数只会生成一个起不来的启动器。
   * 两条断言：源码里没有它；传了它会被 PowerShell 直接拒绝（不是静默忽略）。
   */
  check("部署脚本里没有 -DataDir 覆盖参数，数据目录固定为 <插件根>\\data", () => {
    if (/\[string\]\s*\$DataDir/.test(src)) throw new Error("仍有 -DataDir 参数：数据目录必须固定在插件内")
    if (/-DataDir/.test(src)) throw new Error("脚本里仍提到 -DataDir")
    if (/Ask\s+"data dir/.test(src)) throw new Error("仍在询问数据目录（它不该是可选项）")
    if (!/^\s*\$DataDir\s*=\s*Join-Path\s+\$PluginDir\s+"data"\s*$/m.test(src))
      throw new Error("没有把数据目录固定写成 <插件根>\\data")
  })

  check("传 -DataDir 会被拒绝（参数已删除，不是静默忽略）", () => {
    const stray = path.join(base, "elsewhere")
    const r = spawnSync(
      PS,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", deployInHost, "-Yes", "-DataDir", stray],
      { encoding: "utf8", timeout: 120000 },
    )
    const msg = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    if (r.status === 0) throw new Error("脚本仍然接受 -DataDir（数据就能被放到插件外）")
    if (!/DataDir/i.test(msg)) throw new Error(`拒绝理由没提到 DataDir：${msg.slice(-300)}`)
    if (fs.existsSync(stray)) throw new Error(`仍按 -DataDir 在插件外建目录：${stray}`)
  })

  check("部署产物是 .mjs（remote.js 支持的启动器类型），不再生成 editor.cmd", () => {
    if (fs.existsSync(legacyCmd)) throw new Error("还在生成 editor.cmd：启动协议与部署产物不一致")
    if (!fs.existsSync(launcher)) throw new Error(`没有生成 ${launcher}`)
    if (path.extname(launcher).toLowerCase() !== ".mjs") throw new Error(`启动器不是 .mjs：${launcher}`)
    if (!autostartCommand(launcher)) throw new Error("生成物不是 model/remote.js 认识并会执行的启动器类型")
  })

  check("config.yaml 的 remote.autostart / remote.url 指向本机应用", () => {
    if (!autostartPath) throw new Error("config.yaml 里没有 autostart")
    if (!samePath(autostartPath, launcher)) throw new Error(`autostart 指向 ${autostartPath}`)
    if (autostartRaw.includes("\\")) throw new Error("YAML 里应写 posix 路径（反斜杠在 YAML 里是转义）")
    const url = /^\s*url:\s*"([^"]*)"/m.exec(cfgText)?.[1] ?? ""
    if (!url.startsWith(`http://127.0.0.1:${port}`)) throw new Error(`remote.url 不是本机应用地址：${url}`)
    if (!token) throw new Error("没有生成 remote.token")
  })

  check("部署输出只有应用交接信息（本机地址/端口/挂载/上传上限/健康接口）", () => {
    if (!out.includes("handover")) throw new Error("没有交接信息段")
    for (const need of ["listen", "mount", "upload cap", "health", "launcher", "data dir"])
      if (!out.includes(need)) throw new Error(`交接信息缺少 ${need}`)
  })

  check("部署工具不再碰网络基础设施：输出里没有 nginx 配置/检查/重载", () => {
    if (/nginx/i.test(out)) throw new Error("输出里仍有 nginx 内容（配置生成 / 探测 / 重载指引）")
    if (/nginx/i.test(src)) throw new Error("脚本源码里仍有 nginx 逻辑")
    if (/-s\s+reload|-t\b/.test(src) && /proxy_pass/.test(src)) throw new Error("仍在生成反向代理配置")
  })

  check("脚本里没有维护者机器的绝对路径，也不再询问宿主根", () => {
    if (/D:\\Program Files/i.test(src)) throw new Error("仍硬编码维护者机器的路径")
    if (/\$BotDir/.test(src)) throw new Error("仍在询问/接收 Yunzai root")
  })

  check("Node 检查只验证可执行文件与最低版本（20.11）", () => {
    if (!/node:/.test(out)) throw new Error("没有报告 node 可执行文件")
    if (!/20\.11 OK/.test(out)) throw new Error("没有按最低版本 20.11 做判定")
  })

  check("node 版本低于 20.11 时部署被拒绝（版本判定是硬的）", () => {
    if (oldNodeDeploy.status === 0) throw new Error("旧版本 node 竟然部署成功了")
    if (!/too old|20\.11/.test(oldNodeOut)) throw new Error(`拒绝理由没说清版本要求：${oldNodeOut.slice(-200)}`)
  })

  check("重复部署是幂等的，且能探到已在跑的应用（交接信息里的健康接口真能用）", () => {
    if (second.status !== 0) throw new Error(`第二次部署退出码 ${second.status}`)
    if (!/app healthz OK/.test(secondOut))
      throw new Error(`应用在跑，健康探测却没通过：${secondOut.slice(-300)}`)
    if (!/keeping configured remote\.url/.test(secondOut))
      throw new Error("第二次部署没有保留已配置的 remote.url（可能把公网地址改掉）")
    const again = (/^\s*token:\s*"([^"]*)"/m.exec(fs.readFileSync(cfgPath, "utf8"))?.[1] ?? "")
    if (again !== token) throw new Error("重复部署把已生成的口令换掉了（会打断已在跑的编辑器）")
  })

  check("生成的启动器能被 node 解析（不是拼坏的一坨文本）", () => {
    const r = spawnSync(process.execPath, ["--check", launcher], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(r.stderr || "node --check 失败")
  })

  check("启动前编辑器不可达（探活不是走过场）", () => {
    if (aliveBefore) throw new Error("探活前就有服务在应答，无法证明是本次拉起的")
  })

  check("拉起来并探活成功：启动成功与否以 /healthz 为准", () => {
    if (!up) throw new Error("ensureEditor 返回 false：生成物没跑起来或探活没通过")
    if (!aliveAfter) throw new Error("ensureEditor 之后 /healthz 仍不可达")
  })

  check("启动器把口令 / 签名密钥 / 名单 QQ 传给了编辑器（含空格与中文路径）", () => {
    if (!healthJson) throw new Error("没有拿到 /healthz 内容")
    if (healthJson.auth !== true) throw new Error("ABYSS_EDITOR_TOKEN 没传进去")
    if (healthJson.sign_key !== true) throw new Error("ABYSS_EDITOR_SIGN_KEY 没传进去")
    if (!healthJson.roster_qq) throw new Error("ABYSS_EDITOR_ROSTER_QQ 没传进去")
    if (healthJson.mount !== "/queue") throw new Error(`挂载路径不对：${healthJson.mount}`)
    if (Number(healthJson.port) !== port) throw new Error(`端口不对：${healthJson.port}`)
    for (const p of [hostRoot, dataDir]) {
      if (!/[^\u0000-\u007f]/.test(p) || !p.includes(" ")) throw new Error(`夹具路径没覆盖空格/中文：${p}`)
    }
  })

  check("启动器写下 pid 文件（运维可定位、可清理）", () => {
    const pidFile = path.join(dataDir, "editor.pid")
    if (!fs.existsSync(pidFile)) throw new Error("没有 pid 文件")
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
    if (!pid) throw new Error("pid 文件内容不是一个进程号")
    try {
      process.kill(pid, 0)
    } catch {
      throw new Error(`pid ${pid} 已经不是活着的进程`)
    }
  })
} finally {
  killEditor()
  fs.rmSync(base, { recursive: true, force: true })
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
