/**
 * 三路深渊排队 —— 插件入口（薄加载器）
 *
 * 框架的 loader 只认插件根目录的 `index.js`：
 * 一旦它存在，loader 就**只导入这一个文件**，不会再扫 apps/（见 lib/plugins/loader.js:58-62），
 * 并从这里取 `module.apps`（loader.js:130）逐个实例化。
 * 因此本文件的职责只有两件：首启生成配置、把 apps/ 下的入口类聚合导出。
 */
import { ensureConfig } from "./components/config.js"

/** 首启生成 config/config.yaml（幂等；config.js 导入时也会尝试一次） */
ensureConfig()

/** 入口类集合：loader 会遍历这个对象里的每个 class */
export const apps = {
  ...(await import("./apps/queue.js")),
  ...(await import("./apps/join.js")),
  ...(await import("./apps/leave.js")),
  ...(await import("./apps/update.js")),
}
