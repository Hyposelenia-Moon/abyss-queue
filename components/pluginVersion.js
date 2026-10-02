/**
 * 插件版本号：供回复页脚使用（读 package.json，避免两处手改不同步）
 */
import { createRequire } from "node:module"

const pkg = createRequire(import.meta.url)("../package.json")

export const pluginVersion = pkg.version ?? "0.0.0"

/** 页脚文案：Created By Yz-Bot & <插件名> <版本> */
export const versionFooter = name => `Created By Yz-Bot & ${name} ${pluginVersion}`
