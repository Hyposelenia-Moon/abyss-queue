/**
 * 编辑器随机器人启动：`RemoteTable.ensureEditor()`
 *
 * 单机部署（机器人 + 编辑器同一台）时，编辑器不必再单独注册服务：
 * 插件加载后探一次 `/healthz`，没起来就按 `remote.autostart` 拉起来。
 * 这里用一个**会写标记文件的临时启动器**当替身，验证两条关键行为：
 *   - 编辑器已经活着 → 不重复拉起（不许把已经在跑的实例再多起一个）
 *   - 编辑器没起来 → 按配置拉起（替身写出标记文件）
 *
 * 用法：node test/autostart.test.mjs
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { createChecker } from "./_helper.mjs"
import { RemoteTable } from "../model/remote.js"

const { check, finish } = createChecker("编辑器随机器人启动")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-autostart-"))
const marker = path.join(tmp, "spawned.txt")
/** 临时启动器：被拉起就写个标记（真实部署里这里是 editor-launch.mjs / .vbs） */
const launcher = path.join(tmp, "launch.mjs")
fs.writeFileSync(launcher, `import fs from "node:fs"\nfs.writeFileSync(${JSON.stringify(marker)}, "ok")\n`, "utf8")

const wait = ms => new Promise(r => setTimeout(r, ms))
const alive = async () => fs.existsSync(marker)

/** 假编辑器：只回答 /healthz */
const server = http.createServer((req, res) => {
  res.writeHead(req.url.startsWith("/healthz") ? 200 : 404, { "content-type": "text/plain" })
  res.end(req.url.startsWith("/healthz") ? "ok" : "no")
})
await new Promise(r => server.listen(0, "127.0.0.1", r))
const port = server.address().port

try {
  /** 1) 编辑器活着：不该再拉一个起来 */
  const whenAlive = new RemoteTable({ url: `http://127.0.0.1:${port}`, token: "t", autostart: launcher })
  await check("编辑器活着：探到就不重复拉起", async () => {
    const up = await whenAlive.ensureEditor({ waitMs: 200 })
    if (up !== false) throw new Error("已经在跑却还是拉起了")
    if (await alive()) throw new Error("不该有启动标记")
  })

  /** 2) 编辑器没起来：按配置拉起 */
  const whenDown = new RemoteTable({ url: "http://127.0.0.1:1", token: "t", autostart: launcher })
  await check("编辑器没起来：按 remote.autostart 拉起", async () => {
    const up = await whenDown.ensureEditor({ waitMs: 1500 })
    if (up !== true) throw new Error("没拉起来")
    for (let i = 0; i < 20 && !(await alive()); i++) await wait(100)
    if (!(await alive())) throw new Error("替身没被拉起（没有标记文件）")
  })

  /** 3) 没配 autostart（编辑器单独部署）：什么都不做，也不报错 */
  const standalone = new RemoteTable({ url: "http://127.0.0.1:1", token: "t", autostart: "" })
  await check("没配 autostart：直接跳过（不报错）", async () => {
    if ((await standalone.ensureEditor()) !== false) throw new Error("没配也拉起了")
  })

  /** 4) autostart 指向不存在的文件：安全返回 false，不抛 */
  const broken = new RemoteTable({ url: "http://127.0.0.1:1", token: "t", autostart: path.join(tmp, "nope.mjs") })
  await check("autostart 指向不存在的文件：返回 false，不抛异常", async () => {
    if ((await broken.ensureEditor()) !== false) throw new Error("应当返回 false")
  })
} finally {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

await finish()
process.exit(process.exitCode || 0)
