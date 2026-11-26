/** 三路深渊排队 —— 插件入口（薄加载器） */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureConfig, watchConfig } from "./components/config.js"
import { boot } from "./components/boot.js"
import { log } from "./components/logger.js"
import { startEditorHost } from "./modules/editor-host.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

ensureConfig()

boot()

await startEditorHost()

const closeConfigWatcher = watchConfig()

process.once("exit", () => {
  void closeConfigWatcher?.()
})

const isPluginClass = v =>
  typeof v === "function" && Object.getOwnPropertyDescriptor(v, "prototype")?.writable === false
const appsDir = path.join(__dirname, "apps")

const files = await fs.promises.readdir(appsDir).catch(err => {
  log("error", `[abyss-queue] 读取 apps/ 失败：${err?.message ?? err}`)
  return []
})

const appFiles = files.filter(file => file.endsWith(".js"))

const ret = await Promise.allSettled(appFiles.map(file => import(`./apps/${file}`)))

const apps = {}
for (let i = 0; i < appFiles.length; i++) {
  const name = appFiles[i].replace(".js", "")
  if (ret[i].status !== "fulfilled") {
    log("error", `[abyss-queue] 载入失败：${name}`)
    log("error", ret[i].reason)
    continue
  }
  const AppClass = Object.values(ret[i].value).find(isPluginClass)
  if (!AppClass) {
    log("error", `[abyss-queue] 载入失败：${name}（模块未导出插件 class）`)
    continue
  }
  apps[name] = AppClass
  log("info", `[abyss-queue] 载入: ${name}`)
}

export { apps }
