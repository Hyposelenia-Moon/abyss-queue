/**
 * 编辑器随机器人启动：`RemoteTable.ensureEditor()`
 *
 * 单机部署（机器人 + 编辑器同一台）时，编辑器不必再单独注册服务：
 * 插件加载后探一次 `/healthz`，没起来就按 `remote.autostart` 拉起来。
 * 这里用一个**会写标记文件的临时启动器**当替身，验证关键行为：
 *   - 编辑器已经活着 → 不重复拉起（不许把已经在跑的实例再多起一个）
 *   - 编辑器没起来 → 按配置拉起，**并且以 /healthz 探活确认成功**
 *   - 只拉起成功、服务没起来 / 启动器类型与部署产物不匹配 → 不算成功
 *   - `.mjs`（部署脚本的产物）走 node、`.vbs` 走 wscript、`.cmd` 交给 cmd.exe
 *
 * 用法：node test/autostart.test.mjs
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { createChecker } from "./_helper.mjs"
import { RemoteTable, autostartCommand } from "../model/remote.js"

const { check, finish } = createChecker("编辑器随机器人启动")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-autostart-"))
/**
 * `markerUp` = "假编辑器的端口已经应答了"：假服务只在它存在时才 200。
 * 每个"服务应当不可达"的场景先删掉它，再由替身启动器写回来——
 * 这样就真的走了一遍"拉起 → 探活"的时序，而不是靠提前摆好的健康状态蒙过去。
 */
const markerUp = path.join(tmp, "up.txt")
const markerAlive = path.join(tmp, "alive.txt")
const markerStuck = path.join(tmp, "stuck.txt")

const writeLauncher = (file, marker) =>
  fs.writeFileSync(file, `import fs from "node:fs"\nfs.writeFileSync(${JSON.stringify(marker)}, "ok")\n`, "utf8")

const launchAlive = path.join(tmp, "launch-alive.mjs")
const launchDown = path.join(tmp, "launch-down.mjs")
const launchStuck = path.join(tmp, "launch-stuck.mjs")
const launchCmd = path.join(tmp, "launch-cmd.cmd")
writeLauncher(launchAlive, markerAlive)
writeLauncher(launchDown, markerUp)
writeLauncher(launchStuck, markerStuck)
fs.writeFileSync(launchCmd, `@echo off\r\necho ok>"${markerUp}"\r\n`, "ascii")

const wait = ms => new Promise(r => setTimeout(r, ms))
const alive = file => fs.existsSync(file)
const offline = () => fs.rmSync(markerUp, { force: true })

/** 假编辑器：`/healthz` 只在"服务标记"存在时才 200（真实服务也是这样：进程起来端口才应答） */
const server = http.createServer((req, res) => {
  const ready = alive(markerUp)
  const code = req.url.startsWith("/healthz") && ready ? 200 : 503
  res.writeHead(code, { "content-type": "text/plain" })
  res.end(code === 200 ? "ok" : "not ready")
})
await new Promise(r => server.listen(0, "127.0.0.1", r))
const port = server.address().port
const health = `http://127.0.0.1:${port}`

try {
  /** 1) 编辑器活着：不该再拉一个起来 */
  fs.writeFileSync(markerUp, "ok")
  const whenAlive = new RemoteTable({ url: health, token: "t", autostart: launchAlive })
  await check("编辑器活着：探到就不重复拉起", async () => {
    const up = await whenAlive.ensureEditor({ waitMs: 500 })
    if (up !== false) throw new Error("已经在跑却还是拉起了")
    if (alive(markerAlive)) throw new Error("不该有启动标记")
  })

  /** 2) 编辑器没起来：按配置拉起，并以探活确认 */
  offline()
  const whenDown = new RemoteTable({ url: health, token: "t", autostart: launchDown })
  await check("编辑器没起来：按 remote.autostart 拉起并探活成功", async () => {
    const up = await whenDown.ensureEditor({ waitMs: 8000 })
    if (up !== true) throw new Error("拉起后探活没通过")
    if (!alive(markerUp)) throw new Error("替身没被拉起（没有标记文件）")
    if (!(await whenDown.editorAlive())) throw new Error("/healthz 仍不可达")
  })

  /** 3) 拉起成功但服务始终没起来：必须返回 false（不能只看 spawn 成功） */
  offline()
  const stuck = new RemoteTable({ url: "http://127.0.0.1:1", token: "t", autostart: launchStuck })
  await check("只拉起成功、/healthz 起不来：返回 false（不能只看 spawn）", async () => {
    const up = await stuck.ensureEditor({ waitMs: 1500 })
    if (!alive(markerStuck)) throw new Error("替身没有被执行，用例前提不成立")
    if (up !== false) throw new Error("服务没起来却报告启动了")
  })

  /** 4) 部署脚本生成的是 .mjs；`.cmd` 丢给 Node 跑第一行就会语法错误 */
  offline()
  const cmdLauncher = new RemoteTable({ url: health, token: "t", autostart: launchCmd })
  await check(".cmd 启动器交给 cmd.exe（不再当成 JavaScript 丢给 Node）", async () => {
    const up = await cmdLauncher.ensureEditor({ waitMs: 8000 })
    if (up !== true) throw new Error("cmd 启动器没被正确执行/探活失败")
    if (!alive(markerUp)) throw new Error("cmd 启动器没有跑起来（标记文件缺失）")
  })

  /** 5) 没配 autostart（编辑器单独部署）：什么都不做，也不报错 */
  const standalone = new RemoteTable({ url: "http://127.0.0.1:1", token: "t", autostart: "" })
  await check("没配 autostart：直接跳过（不报错）", async () => {
    if ((await standalone.ensureEditor()) !== false) throw new Error("没配也拉起了")
  })

  /** 6) autostart 指向不存在的文件：安全返回 false，不抛 */
  const broken = new RemoteTable({ url: "http://127.0.0.1:1", token: "t", autostart: path.join(tmp, "nope.mjs") })
  await check("autostart 指向不存在的文件：返回 false，不抛异常", async () => {
    if ((await broken.ensureEditor()) !== false) throw new Error("应当返回 false")
  })

  /** 7) 不认识的类型：明确拒绝，不瞎猜着执行 */
  const weird = new RemoteTable({ url: "http://127.0.0.1:1", token: "t", autostart: path.join(tmp, "launch.ps1") })
  fs.writeFileSync(path.join(tmp, "launch.ps1"), "# not a launcher\n", "utf8")
  await check("不支持的启动器类型：拒绝执行并返回 false", async () => {
    if ((await weird.ensureEditor({ waitMs: 500 })) !== false) throw new Error("应当返回 false")
  })

  check("启动器类型 → 执行方式的映射（部署产物与启动协议对齐）", () => {
    if (autostartCommand(launchDown)[0] !== process.execPath) throw new Error(".mjs 应当用当前 node 跑")
    if (autostartCommand("x.vbs")[0] !== "wscript.exe") throw new Error(".vbs 应当用 wscript")
    if (autostartCommand("x.cmd")[0] !== "cmd.exe") throw new Error(".cmd 应当交给 cmd.exe")
    if (autostartCommand("x.bat")[0] !== "cmd.exe") throw new Error(".bat 应当交给 cmd.exe")
    if (autostartCommand("x.ps1") !== null) throw new Error("不支持的类型应当明确返回 null")
  })
} finally {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
