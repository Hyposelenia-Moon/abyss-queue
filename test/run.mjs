/**
 * 回归套件运行器：顺序跑 test/*.test.mjs 与 editor/test/*.test.mjs，汇总结果并按失败数退出
 *
 * 用法：
 *   node test/run.mjs               # 跑全部
 *   node test/run.mjs --list        # 只列清单
 *   node test/run.mjs cache verify  # 只跑文件名含这些关键词的套件
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Paths } from "./_helper.mjs"

const here = path.dirname(process.argv[1] ?? path.join(Paths.root, "test", "run.mjs"))
const filters = process.argv.slice(2).filter(a => !a.startsWith("--"))

/** 套件目录：插件自己的 test/，以及编辑器搬进插件之后的 editor/test/ */
const dirs = [here, path.join(Paths.root, "editor", "test")].filter(d => fs.existsSync(d))

const suites = dirs
  .flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith(".test.mjs")).map(f => ({ rel: path.relative(Paths.root, path.join(dir, f)), file: path.join(dir, f) })))
  .filter(s => !filters.length || filters.some(k => s.rel.includes(k)))
  .sort((a, b) => a.rel.localeCompare(b.rel))

if (process.argv.includes("--list")) {
  for (const s of suites) console.log(s.rel)
  process.exit(0)
}

if (!suites.length) {
  console.log("没有匹配的套件")
  process.exit(filters.length ? 1 : 0)
}

const run = file =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [file], { stdio: "inherit" })
    child.on("error", err => resolve({ file, code: 1, error: err.message }))
    child.on("close", code => resolve({ file, code: code ?? 1 }))
  })

console.log(`回归套件：${suites.length} 个\n${"═".repeat(46)}`)

const failed = []
for (const { rel, file } of suites) {
  console.log(`\n▶ ${rel}`)
  console.log("─".repeat(46))
  const r = await run(file)
  if (r.error) console.error(`  ❌ 启动失败：${r.error}`)
  if (r.code !== 0) failed.push(rel)
}

console.log(`\n${"═".repeat(46)}`)
if (failed.length) {
  console.error(`❌ ${failed.length}/${suites.length} 个套件失败：${failed.join(", ")}`)
  process.exit(1)
}
console.log(`✅ 全部 ${suites.length} 个套件通过`)
