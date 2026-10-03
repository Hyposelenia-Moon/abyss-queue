/**
 * 编辑器回归套件运行器：顺序跑本目录的 *.test.mjs，汇总结果并按失败数退出
 *
 * 用法：
 *   node test/run.mjs            # 跑全部（editor / identity）
 *   node test/run.mjs identity   # 只跑文件名含关键词的套件
 *
 * 需要插件目录在场（默认同级 `../abyss-queue`，可用 ABYSS_PLUGIN_DIR 覆盖）：
 * 表格读写与断言脚手架都在插件里，只有一份实现。
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_DIR } from "./plugin.mjs"

const dir = path.dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2).filter(a => !a.startsWith("--"))

if (!fs.existsSync(PLUGIN_DIR)) {
  console.error(`找不到插件目录：${PLUGIN_DIR}\n用 ABYSS_PLUGIN_DIR 指定，或把编辑器放在插件同级目录。`)
  process.exit(1)
}

const suites = fs
  .readdirSync(dir)
  .filter(f => f.endsWith(".test.mjs"))
  .sort()
  .filter(f => !filters.length || filters.some(k => f.includes(k)))

if (process.argv.includes("--list")) {
  for (const f of suites) console.log(f)
  process.exit(0)
}
if (!suites.length) {
  console.log("没有匹配的套件")
  process.exit(filters.length ? 1 : 0)
}

const run = file =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(dir, file)], { stdio: "inherit" })
    child.on("error", err => resolve({ file, code: 1, error: err.message }))
    child.on("close", code => resolve({ file, code: code ?? 1 }))
  })

console.log(`编辑器回归套件：${suites.length} 个（插件目录 ${PLUGIN_DIR}）\n${"═".repeat(46)}`)

const failed = []
for (const file of suites) {
  console.log(`\n▶ ${file}`)
  console.log("─".repeat(46))
  const r = await run(file)
  if (r.error) console.error(`  ❌ 启动失败：${r.error}`)
  if (r.code !== 0) failed.push(file)
}

console.log(`\n${"═".repeat(46)}`)
if (failed.length) {
  console.error(`❌ ${failed.length}/${suites.length} 个套件失败：${failed.join(", ")}`)
  process.exit(1)
}
console.log(`✅ 全部 ${suites.length} 个套件通过`)
