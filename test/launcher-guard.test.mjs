/**
 * 本机启动器（`resources/init/editor-launch.mjs`）的两条护栏：**端口不越权终止**与**快照验收**
 *
 * 这套补的是 init-launcher.test.mjs 没覆盖的一段：那个套件验的是"初始化产物 → 真拉起 → 探活"
 * 的顺风路径，而这里验的是两个坏条件下的行为（审核 S03 / S05 精确函数复现的那两处）：
 *
 *   1. **端口被占用**：必须**停下并明确报告**，绝不终止不认识的进程
 *      （占用者可能是别的服务，也可能是另一个账号在跑的东西，由主人自己决定怎么处理）。
 *   2. **坏快照**：替换本地表之前必须先过完整工作簿 / 业务结构验收（只看 HTTP 200 + ≥1KB
 *      的话，服务端返回的错误页就会被当成本地表，第二次拉取还会把坏掉的主文件复制进 `.bak`，
 *      有效备份与工作副本一起没了）。验收不过就另存诊断文件，主文件与 `.bak` 都不动。
 *
 * 做法：造一个**合成插件宿主**（只有启动器真正用到的东西：`editor/editor.mjs` 桩、`data/`、
 * `lib/`、`model/`、`resources/`），把**模板本身**复制成 `data/editor-launch.mjs`（与初始化
 * 产物的口径一致），再以真实子进程跑它。命令行参数只从 `ABYSS_EDITOR_PORT` / `editor-path.txt`
 * 来，所以夹具不必改启动器源码。
 *
 * 用法：node test/launcher-guard.test.mjs
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createChecker, Paths } from "./_helper.mjs"

const { check, finish } = createChecker("启动器护栏（端口 / 快照验收）")

/** 桩编辑器的代码：与"生成启动器能不能起来"无关的部分一律省掉，只看它收没收到表 */
const STUB_EDITOR = `import http from "node:http"
const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : ""
}
const server = http.createServer((req, res) => {
  if (new URL(req.url, "http://127.0.0.1").pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", connection: "close" })
    return res.end(JSON.stringify({ ok: true, pid: process.pid, file: flag("--file") }))
  }
  res.writeHead(404, { connection: "close" })
  res.end("not found")
})
server.listen(Number(flag("--port")), "127.0.0.1")
`
/** 空模板就是"结构齐全、没有成员行"的合法表：拿它当夹具里的有效工作副本 */
const TEMPLATE = path.join(Paths.root, "resources", "空模板.xlsx")
const LAUNCHER_TPL = path.join(Paths.root, "resources", "init", "editor-launch.mjs")

const base = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-launcher-guard-"))
const pluginDir = path.join(base, "plugins", "abyss-queue")
const dataDir = path.join(pluginDir, "data")
const launcher = path.join(dataDir, "editor-launch.mjs")
const pathFile = path.join(dataDir, "editor-path.txt")
const xlsx = path.join(dataDir, "排队表-本地.xlsx")
const bak = `${xlsx}.bak`

/** 起子进程 **不是** 用 shell，`kill()` 只杀到直接子进程；桩编辑器是 detached 起的，得按 pid 收 */
const started = []
const track = pid => {
  if (pid) started.push(pid)
}
const killAll = () => {
  if (!started.length) return
  spawnSync("taskkill", ["/PID", started.join(","), "/T", "/F"], { stdio: "ignore" })
  started.length = 0
}

/** 空闲端口：避开编辑器套件占用的 7800-7811 与本机编辑器默认的 7788 */
const freePort = async () => {
  for (let i = 0; i < 40; i++) {
    const port = 8000 + Math.floor(Math.random() * 400)
    const free = await new Promise(resolve => {
      const s = net.createServer()
      s.once("error", () => resolve(false))
      s.once("listening", () => s.close(() => resolve(true)))
      s.listen(port, "127.0.0.1")
    })
    if (free) return port
  }
  throw new Error("找不到空闲端口")
}

const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

/** 造合成宿主：把合成插件目录**放在真实源码树底下同名目录的兄弟位置**，依赖沿父目录解析回真仓库 */
function makeHost() {
  fs.mkdirSync(path.join(pluginDir, "editor"), { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(pluginDir, "resources"), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "editor", "editor.mjs"), STUB_EDITOR, "utf8")
  /** 只搬启动器验收真正会用到的两棵子树（`lib/` 的解析 + `model/` 建模），不搬无关源码 */
  fs.cpSync(path.join(Paths.root, "lib"), path.join(pluginDir, "lib"), { recursive: true })
  fs.cpSync(path.join(Paths.root, "model"), path.join(pluginDir, "model"), { recursive: true })
  fs.cpSync(path.join(Paths.root, "resources", "init"), path.join(pluginDir, "resources", "init"), { recursive: true })
  fs.copyFileSync(TEMPLATE, path.join(pluginDir, "resources", "空模板.xlsx"))
  fs.copyFileSync(LAUNCHER_TPL, launcher)
}

/** 写启动器读的 `editor-path.txt`（UTF-16LE、5 行，与初始化产物同一口径） */
const writePathFile = ({ token = "test-token", cloud = "" } = {}) => {
  const text = [path.join(pluginDir, "editor", "editor.mjs"), xlsx, token, cloud, ""].join("\r\n") + "\r\n"
  fs.writeFileSync(pathFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]))
}

/**
 * 真跑一次启动器（子进程 + 真退出码）
 *
 * `ABYSS_EDITOR_TEST_PATHS=1` 是编辑器自己那道"数据不许出插件"的闸在回归里的放行开关；
 * 桩编辑器只看 `--file` 收没收到，所以这里不需要它——但保留它更贴近部署里真实的启动环境。
 */
const runLauncher = (port, timeoutMs = 40000) =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [launcher], {
      cwd: pluginDir,
      env: {
        ...process.env,
        ABYSS_EDITOR_PORT: String(port),
        ABYSS_EDITOR_BIND: "127.0.0.1",
        ABYSS_EDITOR_TEST_PATHS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    const timer = setTimeout(() => {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      resolve({ code: null, out, timedOut: true })
    }, timeoutMs)
    child.stdout.on("data", d => (out += d))
    child.stderr.on("data", d => (out += d))
    child.on("error", err => {
      clearTimeout(timer)
      resolve({ code: 1, out: `${out}\n${err.message}`, timedOut: false })
    })
    child.on("close", code => {
      clearTimeout(timer)
      resolve({ code, out, timedOut: false })
    })
  })

/** 从启动器自己的输出里取它 detached 起的编辑器 PID（输出里就写着「已启动编辑器（PID …）」） */
const editorPidOf = out => Number(/已启动编辑器（PID (\d+)）/.exec(out)?.[1] ?? 0)

try {
  makeHost()

  /* ---------------------------- 一、端口被占用：停下并报告 ---------------------------- */

  const p1 = await freePort()
  writePathFile()
  /** 占用者是**本套件自己**起的服务：既能钉住"没被杀"，又不会碰到任何真实进程 */
  const holder = net.createServer(() => {})
  await new Promise(r => holder.listen(p1, "127.0.0.1", r))

  const r1 = await runLauncher(p1)
  check("端口被占用：明确报告并停止（不是默默清端口）", () => {
    if (r1.code === 0) throw new Error(`端口被占用时仍以 0 退出：\n${r1.out}`)
    if (!r1.out.includes("不会去杀")) throw new Error(`没有明确说明不终止未知进程：\n${r1.out}`)
    if (!r1.out.includes(String(p1))) throw new Error(`报告里没有端口号：\n${r1.out}`)
  })
  check("端口被占用：占用者进程一个都没被终止（不越权杀别人的进程）", () => {
    if (!holder.listening) throw new Error("占用端口的进程被启动器终止了")
  })
  check("端口被占用：没有留下编辑器进程", () => {
    if (fs.existsSync(path.join(dataDir, "editor-url.txt"))) throw new Error("还写下了 editor-url.txt（编辑器和它一起被起了）")
  })

  /* ---------------------------- 二、坏快照：验收不通过就不替换 ---------------------------- */

  const p2 = await freePort()
  let cloudHits = 0
  /** 假云端只有 `/api/snapshot` 一个口：长度远超 1KB 的错误页，专门用来试"200 + 够大"这种弱判定 */
  const cloud = http.createServer((req, res) => {
    if (new URL(req.url, "http://127.0.0.1").pathname === "/api/snapshot") {
      cloudHits++
      res.writeHead(200, { "content-type": "text/html" })
      return res.end(`<!DOCTYPE html><html><body>${"gateway error ".repeat(200)}</body></html>`)
    }
    res.writeHead(404)
    res.end("not found")
  })
  await new Promise(r => cloud.listen(0, "127.0.0.1", r))
  const cloudUrl = `http://127.0.0.1:${cloud.address().port}`

  /** 有效工作副本与一份"旧但有效"的备份：两者都不该被坏快照动到 */
  fs.copyFileSync(TEMPLATE, xlsx)
  fs.writeFileSync(bak, "上一份有效备份")
  const goodHash = sha(xlsx)
  const bakHash = sha(bak)

  writePathFile({ cloud: cloudUrl })
  const r2 = await runLauncher(p2)
  /** 诊断副本：主文件与 `.bak` 之外、文件名仍以本地副本开头的那些 */
  const diagnostics = fs
    .readdirSync(dataDir)
    .filter(f => f.startsWith("排队表-本地.xlsx") && f !== "排队表-本地.xlsx" && f !== "排队表-本地.xlsx.bak")

  check("坏快照：明确说明没通过验收（不是当成成功静默替换）", () => {
    if (!r2.out.includes("没通过工作簿验收")) throw new Error(`没有报出验收失败：\n${r2.out}`)
  })
  check("坏快照：本地工作副本一个字节都没动", () => {
    if (sha(xlsx) !== goodHash) throw new Error("本地工作副本被坏快照覆盖")
  })
  check("坏快照：有效 .bak 没被覆盖（也不新增 .bak）", () => {
    if (!fs.existsSync(bak)) throw new Error(".bak 不见了")
    if (sha(bak) !== bakHash) throw new Error(".bak 被换成了别的内容")
    if (fs.readFileSync(bak, "utf8") !== "上一份有效备份") throw new Error(".bak 内容被改写")
  })
  check("坏快照：另存了诊断副本，内容是拿到的那份字节（主人能自己看）", () => {
    if (!diagnostics.length) throw new Error(`没有在 ${dataDir} 留下诊断副本`)
    const body = fs.readFileSync(path.join(dataDir, diagnostics[0]))
    if (!body.toString("utf8").includes("gateway error")) throw new Error("诊断副本内容与云端返回的不一致")
  })
  check("坏快照：启动器照旧把编辑器拉起来了（拉不到新表不打断本机使用）", () => {
    if (r2.code !== 0) throw new Error(`失败路径也应当能起编辑器，实际退出码 ${r2.code}：\n${r2.out}`)
    if (!fs.existsSync(path.join(dataDir, "editor-url.txt"))) throw new Error("没有写下 editor-url.txt")
    if (!r2.out.includes("沿用本机现有那份")) throw new Error(`没有说明沿用了本机那份：\n${r2.out}`)
  })
  check("假云端确实被请求过（上面的断言不是「没发请求」蒙过去的）", () => {
    if (cloudHits < 1) throw new Error("启动器没有请求 /api/snapshot，坏快照路径根本没被走到")
  })

  track(editorPidOf(r2.out))
  cloud.close()
  await new Promise(r => holder.close(r))
} catch (err) {
  console.log(`  ❌ 套件异常：${err?.stack ?? err}`)
  process.exitCode = 1
} finally {
  killAll()
  await new Promise(r => setTimeout(r, 500))
  try {
    fs.rmSync(base, { recursive: true, force: true })
  } catch (err) {
    console.log(`  ⏭ 临时目录没删掉（不影响结果）：${err?.code ?? err?.message}`)
  }
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中抛 libuv 断言 */
