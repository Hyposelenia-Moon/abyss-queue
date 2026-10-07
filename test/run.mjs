/**
 * 回归套件运行器：顺序跑 test/*.test.mjs 与 editor/test/*.test.mjs，汇总结果并按失败数退出
 *
 * 用法：
 *   node test/run.mjs               # 跑全部
 *   node test/run.mjs --list        # 只列清单
 *   node test/run.mjs cache verify  # 只跑文件名含这些关键词的套件
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Paths } from "./_helper.mjs"

const here = path.dirname(process.argv[1] ?? path.join(Paths.root, "test", "run.mjs"))
const filters = process.argv.slice(2).filter(a => !a.startsWith("--"))

/**
 * 单个套件的超时（毫秒，可用 `ABYSS_TEST_TIMEOUT_MS` 调）
 *
 * 为什么要有：套件会起真实子进程（编辑器、宿主的 HTTP server），一个吊住的进程会让 `pnpm test`
 * **永远不返回**——本地看着像"还在跑"，CI 上就是纯卡死，而卡住与慢下来在输出里长得一样。
 * 超时按**失败**计（不是跳过："没跑完"不等于"通过"），并把**整棵进程树**杀掉：
 * Windows 上 `child.kill()` 只杀直接子进程，套件里的编辑器进程会变成孤儿继续占着那张表，
 * 后面每个套件都会跟着红。
 *
 * 默认 120 秒对最慢的表格层套件（约 5 秒）留了几十倍余量，只有真吊住才会撞上。
 */
const TIMEOUT_MS = Number(process.env.ABYSS_TEST_TIMEOUT_MS ?? 120000)
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  console.error(`ABYSS_TEST_TIMEOUT_MS 不是正数：${process.env.ABYSS_TEST_TIMEOUT_MS}`)
  process.exit(2)
}

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

/**
 * 跑一个套件：把输出**同时**打出来并收集起来
 *
 * 收集是为了分辨"整套跳过"（缺前置，见 _helper.mjs 的 `⏭ 套件跳过`）与"通过"——
 * 两者都只按退出码 0 判的话，汇总会把没跑的套件算成通过（外部审核报告点过这条）。
 */
/**
 * 杀掉一棵进程树
 *
 * Windows 上 `child.kill()` 只作用于直接子进程：套件里的编辑器 / 假云端是孙进程，会活下来
 * 继续占着那张表（下一个套件于是莫名其妙地红）。`taskkill /T` 才能连根杀。
 */
const killTree = child => {
  if (!child.pid) return
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  else child.kill("SIGKILL")
}

const run = file =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, TIMEOUT_MS)
    child.stdout.on("data", d => {
      out += d
      process.stdout.write(d)
    })
    child.stderr.on("data", d => {
      out += d
      process.stderr.write(d)
    })
    child.on("error", err => {
      clearTimeout(timer)
      resolve({ file, code: 1, error: err.message, out, timedOut })
    })
    child.on("close", code => {
      clearTimeout(timer)
      if (timedOut) console.error(`  ⏱ 超过 ${TIMEOUT_MS / 1000} 秒没结束，已杀掉整棵进程树`)
      resolve({ file, code: code ?? 1, out, timedOut })
    })
  })

/** 整套跳过：印过"套件跳过"标记，或一条 ✅ 断言都没有（编辑器套件是自己印 ⏭ 后 exit 0） */
const isSkipped = out => /⏭\s*套件跳过/.test(out) || !/✅/.test(out)

console.log(`回归套件：${suites.length} 个（单套上限 ${TIMEOUT_MS / 1000} 秒）\n${"═".repeat(46)}`)

const failed = []
const skipped = []
const timedOut = []
for (const { rel, file } of suites) {
  console.log(`\n▶ ${rel}`)
  console.log("─".repeat(46))
  const r = await run(file)
  if (r.error) console.error(`  ❌ 启动失败：${r.error}`)
  if (r.timedOut) timedOut.push(rel)
  if (r.code !== 0) failed.push(rel)
  else if (isSkipped(r.out)) skipped.push(rel)
}

console.log(`\n${"═".repeat(46)}`)
const passed = suites.length - failed.length - skipped.length
if (skipped.length) console.error(`⏭ ${skipped.length} 个套件因缺前置没跑（不算失败，但也**不算通过**）：${skipped.join(", ")}`)
if (failed.length) {
  console.error(`❌ ${failed.length}/${suites.length} 个套件失败：${failed.join(", ")}`)
  if (timedOut.length)
    console.error(`⏱ 其中超时被杀的：${timedOut.join(", ")}（上限 ${TIMEOUT_MS / 1000} 秒，可用 ABYSS_TEST_TIMEOUT_MS 调）`)
  process.exit(1)
}
console.log(`✅ ${passed} 个套件通过${skipped.length ? `（另 ${skipped.length} 个跳过）` : ""}`)
