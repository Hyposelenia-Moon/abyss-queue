/**
 * 宿主根目录推导（审核「宿主目录与网络部署职责」问题 1）
 *
 * 补丁自检要校验的是**宿主框架**里的文件，所以"宿主根"必须是那套装 Yunzai 的根，
 * 而不是 `process.cwd()`（它由启动方式决定：计划任务、pm2、在别的目录手起都能不同），
 * 也不是维护者机器上写死的路径。
 *
 * 本套回归钉住：
 *   - 正常布局 `<宿主>/plugins/<插件>` → 从插件位置推出宿主根，并校验宿主标识
 *   - 推导不出来（独立源码目录 / 缺宿主标识）→ 明确报"不适用于部署"，不猜别的安装
 *   - **不看 cwd**：把 cwd 换成一个补丁齐全的宿主，自检仍然判定"不适用于部署"
 *     （老实现拿 cwd 当宿主根，这条会失败：它会报"补丁齐全"）
 *   - 显式传入宿主根的老调用方式保持可用（套件就是靠它造隔离宿主）
 *
 * 用法：node test/patches-host.test.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createChecker, Paths } from "./_helper.mjs"
import { checkPatches, patchNotice, resolveHostRoot } from "../lib/patches.js"

const { check, finish } = createChecker("部署补丁的宿主根推导")

const base = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-host-"))
/** 路径故意带空格与中文：部署路径里很常见 */
const hostRoot = path.join(base, "Yunzai 主 目录", "Yunzai")
const pluginDir = path.join(hostRoot, "plugins", "abyss-queue")

/** 造一个"补丁齐全"的合成宿主 */
const makeHost = dir => {
  fs.mkdirSync(path.join(dir, "plugins", "other"), { recursive: true })
  fs.mkdirSync(path.join(dir, "renderers", "puppeteer", "lib"), { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "trss-yunzai", version: "3.1.3" }), "utf8")
  fs.writeFileSync(path.join(dir, "app.js"), "", "utf8")
  fs.writeFileSync(
    path.join(dir, "plugins", "other", "update.js"),
    "const alias = { abyss: 'abyss-queue' }\nif (commitChanged) {}\n",
    "utf8",
  )
  fs.writeFileSync(path.join(dir, "renderers", "puppeteer", "lib", "puppeteer.js"), "page.setViewport({ deviceScaleFactor: data.sys.scale })\n", "utf8")
}

try {
  makeHost(hostRoot)
  fs.mkdirSync(pluginDir, { recursive: true })

  const inside = resolveHostRoot(pluginDir)

  check("正常布局：从插件位置推出宿主根（<宿主>/plugins/<插件>）", () => {
    if (inside.root !== hostRoot) throw new Error(`推导出 ${inside.root}，应为 ${hostRoot}`)
  })

  check("推导出的宿主根能通过补丁自检（宿主标识已校验）", () => {
    const r = checkPatches(hostRoot)
    if (!r.applicable) throw new Error(`不该判为不适用：${r.reason}`)
    if (r.missing.length) throw new Error(`合成宿主应当补丁齐全，缺：${r.missing.map(p => p.id).join(",")}`)
  })

  check("源码目录（插件不在 plugins 下）：明确报不适用于部署", () => {
    const r = resolveHostRoot(Paths.root)
    if (r.root !== null) throw new Error(`不该推出宿主根：${r.root}`)
    if (!/plugins/.test(r.reason)) throw new Error(`原因说不清楚：${r.reason}`)
  })

  check("插件在 plugins 下、但宿主缺 package.json：同样不适用（不猜另一套安装）", () => {
    const bogusHost = path.join(base, "随便一个目录")
    const bogusPlugin = path.join(bogusHost, "plugins", "abyss-queue")
    fs.mkdirSync(bogusPlugin, { recursive: true })
    const r = resolveHostRoot(bogusPlugin)
    if (r.root !== null) throw new Error(`不该推出宿主根：${r.root}`)
    if (!/package\.json/.test(r.reason)) throw new Error(`原因没点出缺什么：${r.reason}`)
  })

  check("无参调用：在源码仓库里跑属于「不适用于部署」，不报补丁缺失", () => {
    const r = checkPatches()
    if (r.applicable !== false) throw new Error("源码目录不该被当成部署宿主")
    if (r.missing.length) throw new Error("不适用时不该报缺失（会误导主人）")
    if (r.ok.length) throw new Error("不适用时不该报通过项")
  })

  check("不看 cwd：把 cwd 换成补丁齐全的宿主，无参调用仍判不适用", () => {
    const cwd = process.cwd()
    try {
      process.chdir(hostRoot)
      const r = checkPatches()
      if (r.applicable !== false)
        throw new Error(`拿 cwd（${hostRoot}）当宿主根了：补丁自检会去校验另一套安装`)
      if (r.missing.length) throw new Error("不适用时不该报缺失")
    } finally {
      process.chdir(cwd)
    }
  })

  check("显式传入宿主根的老调用方式仍可用（缺失要能报出来）", () => {
    const none = checkPatches(path.join(os.tmpdir(), "abyss-nonexistent-bot"))
    if (none.applicable !== true) throw new Error("显式传入时不该被宿主标识挡下")
    if (none.missing.length < 2) throw new Error("缺失环境应报出补丁缺失")
    if (!patchNotice(none.missing).includes("部署补丁缺失")) throw new Error("提示文案不对")
  })
} finally {
  fs.rmSync(base, { recursive: true, force: true })
}

await finish()
process.exit(process.exitCode || 0)
