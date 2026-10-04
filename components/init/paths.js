/**
 * 组装这次初始化要用的所有路径（唯一的口径来源）
 *
 * 数据目录**固定在插件里**：`<插件根>/data`（硬约定）——没有"挪到别处"的口子。
 */
import path from "node:path"
import { LOCAL_XLSX_NAME } from "./shared.js"

export function initPaths(pluginRoot) {
  const data = path.join(pluginRoot, "data")
  return {
    pluginRoot,
    dataDir: data,
    configPath: path.join(pluginRoot, "config", "config.yaml"),
    templateXlsx: path.join(pluginRoot, "resources", "空模板.xlsx"),
    editorPath: path.join(pluginRoot, "editor", "editor.mjs"),
    localXlsx: path.join(data, LOCAL_XLSX_NAME),
    pathFile: path.join(data, "editor-path.txt"),
    launcherMjs: path.join(data, "editor-launch.mjs"),
    launcherVbs: path.join(data, "editor-launch.vbs"),
    startVbs: path.join(data, "启动排队表编辑器.vbs"),
    adminsFile: path.join(data, "abyss-editor-admins.json"),
    taskXmlTmp: path.join(data, "abyss-editor-task.tmp.xml"),
  }
}
