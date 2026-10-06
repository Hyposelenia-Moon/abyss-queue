/**
 * 三路深渊排队 —— 插件入口（薄加载器）
 *
 * 框架的 loader 只认插件根目录的 `index.js`：一旦它存在，loader 就**只导入这一个文件**、不扫 `apps/`
 * （`lib/plugins/loader.js:55-58`），并从 `module.apps` 取入口类逐个实例化
 * （`loader.js:117-118`）。因此本文件的职责只有四件：
 *   1. 首启生成配置
 *   2. 启动装配（退出钩子/重启标记，`boot()`）
 *   3. 配置热重载（盯住配置文件，改了就就地重读）
 *   4. 动态发现 `apps/` 下的入口类并聚合导出
 *
 * 为什么用动态发现而不是逐个静态 import：新增一个 app 文件不用再改这里，
 * 也不会把某个 app 的加载期副作用（如 ts 级别的顶层 await）带进入口。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureConfig, watchConfig } from "./components/config.js"
import { boot } from "./components/boot.js"
import { log } from "./components/logger.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 首启生成 config/config.yaml（幂等；config.js 导入时也会尝试一次） */
ensureConfig()

/**
 * 启动装配：装退出钩子（进程退出留下重启标记，启动器据此判断重启还是停服）+ 清理过期标记。
 * 必须在**插件加载期**做（幂等），不能等某个 app 实例化才做。
 */
boot()

/**
 * 配置热重载：`config.yaml` 一改（锅巴保存、手工编辑、`#排队初始化` 写密钥）就就地重读。
 *
 * 在**加载期**挂上（幂等）：机器人先起来、再改配置，也照样生效。
 * 唯一例外是 `notify.cron`（定时任务的周期在插件实例化时交给框架），改动要重启。
 */
const closeConfigWatcher = watchConfig()

/** 退出时收掉 watcher：别让它把进程吊住（框架退出流程之后进程就该走） */
process.once("exit", () => {
  void closeConfigWatcher?.()
})

/**
 * 是否是插件 class
 *
 * class 的 `prototype` 属性不可写；普通函数 / 箭头函数都不是插件 class。
 * 框架侧同样以 `p?.prototype` 作判据（`lib/plugins/loader.js:135`），取法必须一致。
 * @param {*} v 模块导出值
 */
const isPluginClass = v =>
  typeof v === "function" && Object.getOwnPropertyDescriptor(v, "prototype")?.writable === false

/** apps 目录：按入口文件自身位置推导，不依赖 `process.cwd()` */
const appsDir = path.join(__dirname, "apps")

const files = await fs.promises.readdir(appsDir).catch(err => {
  log("error", `[abyss-queue] 读取 apps/ 失败：${err?.message ?? err}`)
  return []
})

/**
 * 只保留 `.js`，且 import 数组与下面的命名遍历**同源**：
 * 直接用 readdir 的结果做索引，目录里一旦多出非 JS 文件（`.md` / `.d.ts`）就会索引错位，
 * 表现为"某个 app 静默没注册"。
 */
const appFiles = files.filter(file => file.endsWith(".js"))

const ret = await Promise.allSettled(appFiles.map(file => import(`./apps/${file}`)))

/** key = 文件名（去 `.js`），value = 该文件导出的插件 class */
const apps = {}
for (let i = 0; i < appFiles.length; i++) {
  const name = appFiles[i].replace(".js", "")
  if (ret[i].status !== "fulfilled") {
    log("error", `[abyss-queue] 载入失败：${name}`)
    log("error", ret[i].reason)
    continue
  }
  /**
   * 挑插件 class **不能用 `Object.keys(mod)[0]`**：ESM 命名空间对象的 key 按名字排序
   * （大写在前），模块里多导出一个常量就会顶掉 class；而无效导出会被框架静默跳过
   * （`loader.js:135` 的 `if (!p?.prototype) return`），表现为整条规则不注册。
   */
  const AppClass = Object.values(ret[i].value).find(isPluginClass)
  if (!AppClass) {
    log("error", `[abyss-queue] 载入失败：${name}（模块未导出插件 class）`)
    continue
  }
  apps[name] = AppClass
  /** 逐条打印注册结果：漏注册时能一眼看出是哪个文件 */
  log("info", `[abyss-queue] 载入: ${name}`)
}

export { apps }
