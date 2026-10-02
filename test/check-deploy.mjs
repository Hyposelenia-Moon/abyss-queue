/**
 * 部署一致性自查：源码仓库 与 机器人部署目录 是否一致
 *
 * 为什么需要它：`#更新 abyss` 走的是 `git pull`，只要部署目录里有**未提交改动**或
 * **未跟踪文件**，git 就会拒绝快进并报「local changes would be overwritten」。
 * 这类脏改动几乎都来自「手工往部署目录拷文件」。本脚本把它变成一条命令能查出来的事。
 *
 * 用法：
 *   node test/check-deploy.mjs [部署目录]
 * 默认部署目录：见 DEPLOY_DEFAULT（可用 ABYSS_DEPLOY_DIR 覆盖）
 *
 * 退出码：0 = 一致；1 = 存在问题（会列出具体文件与处理办法）
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const DEPLOY_DEFAULT = "D:/Program Files/Yunzai/Yunzai/plugins/abyss-queue"
const deployDir = path.resolve(process.argv[2] ?? process.env.ABYSS_DEPLOY_DIR ?? DEPLOY_DEFAULT)
const srcDir = path.resolve(import.meta.dirname, "..")

/** 这些目录/文件是运行时产物或本地配置，不参与一致性比较 */
const SKIP = /\\node_modules\\|\\\.git\\|\\data\\|\\temp\\|\\config\\config\.yaml$|\\pnpm-lock\.yaml$/

const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
  } catch (err) {
    return `__ERR__${err.message}`
  }
}

/** 读文件并把行尾归一，避免 CRLF/LF 造成假差异 */
const readNormalized = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")

const problems = []
const notes = []

console.log(`源码仓库：${srcDir}`)
console.log(`部署目录：${deployDir}\n`)

if (!fs.existsSync(deployDir)) {
  console.error(`❌ 部署目录不存在：${deployDir}`)
  process.exit(1)
}

/* 1) 版本与工作区状态 */
for (const [label, dir] of [["源码", srcDir], ["部署", deployDir]]) {
  const head = git(dir, "log", "--oneline", "-1")
  const remote = git(dir, "log", "--oneline", "-1", "origin/main")
  const dirty = git(dir, "status", "--short")
  const untracked = git(dir, "ls-files", "--others", "--exclude-standard")
  console.log(`【${label}】HEAD ${head}`)
  console.log(`        远端 ${remote}`)

  if (dirty) {
    const lines = dirty.split("\n").filter(Boolean)
    console.log(`        工作区：${lines.length} 项改动`)
    /** 部署目录只要有任何改动，下一次 #更新 就可能被拒 */
    if (label === "部署") problems.push(`部署目录有 ${lines.length} 项未提交改动：\n      ${lines.join("\n      ")}`)
    else notes.push(`源码仓库有 ${lines.length} 项未提交改动（正常，push 后即消失）`)
  } else console.log("        工作区：干净")

  if (untracked && label === "部署")
    problems.push(`部署目录有未跟踪文件（最容易被「would be overwritten」拦下）：\n      ${untracked.split("\n").join("\n      ")}`)
  if (head !== remote) notes.push(`${label} 与 origin/main 不一致：${head} vs ${remote}`)
  console.log("")
}

/* 2) 两棵树的内容差异（行尾归一后比较） */
const collect = dir => {
  const out = new Map()
  const walk = cur => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name)
      if (SKIP.test(full)) continue
      if (e.isDirectory()) walk(full)
      else out.set(path.relative(dir, full), full)
    }
  }
  walk(dir)
  return out
}

const srcFiles = collect(srcDir)
const depFiles = collect(deployDir)
const onlySrc = [...srcFiles.keys()].filter(k => !depFiles.has(k))
const onlyDep = [...depFiles.keys()].filter(k => !srcFiles.has(k))
const changed = [...srcFiles.keys()].filter(
  k => depFiles.has(k) && readNormalized(srcFiles.get(k)) !== readNormalized(depFiles.get(k)),
)

console.log("【两棵树内容对比】（已按行尾归一，忽略 node_modules/data/运行时配置）")
for (const [label, list] of [["只在源码有", onlySrc], ["只在部署有", onlyDep], ["内容不同", changed]]) {
  if (!list.length) continue
  console.log(`  ${label}：${list.length} 个`)
  for (const f of list.slice(0, 20)) console.log(`    · ${f}`)
  if (list.length > 20) console.log(`    … 另有 ${list.length - 20} 个`)
}
if (!onlySrc.length && !onlyDep.length && !changed.length) console.log("  ✅ 内容完全一致")

/** 部署目录里多出来的文件：git 跟踪的会被 pull 一起删掉，只有未跟踪的才会挡住 #更新 */
const trackedInDeploy = rel => {
  try {
    execFileSync("git", ["-C", deployDir, "ls-files", "--error-unmatch", rel], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
const staleTracked = onlyDep.filter(trackedInDeploy)
const staleUntracked = onlyDep.filter(f => !staleTracked.includes(f))

if (onlySrc.length) notes.push(`只在源码有 ${onlySrc.length} 个文件：push 后在机器人里发 #更新 abyss 即会出现在部署目录`)
if (staleTracked.length)
  notes.push(`部署目录多出 ${staleTracked.length} 个文件（源码里已删除，pull 后会一起删掉）：${staleTracked.join("、")}`)
if (staleUntracked.length)
  problems.push(`部署目录有 ${staleUntracked.length} 个未跟踪文件（git 会判定为待删除冲突，挡住 #更新）：\n      ${staleUntracked.slice(0, 10).join("\n      ")}`)
if (changed.length) notes.push(`内容不同 ${changed.length} 个：源码侧若未提交，push 后用 #更新 abyss 同步`)

/* 3) 行尾策略 */
console.log("\n【行尾策略】")
for (const [label, dir] of [["源码", srcDir], ["部署", deployDir]]) {
  const crlf = git(dir, "config", "--get", "core.autocrlf") || "(未设置)"
  console.log(`  ${label} core.autocrlf = ${crlf}`)
  if (crlf === "true")
    problems.push(`${label}仓库 core.autocrlf=true：与 .gitattributes 的 eol=lf 叠加会产生「幻影本地改动」。处理：git -C "${dir}" config core.autocrlf false`)
}

/* 结论 */
console.log("\n" + "═".repeat(50))
for (const n of notes) console.log(`· ${n}`)
if (problems.length) {
  console.error("\n❌ 部署目录存在会挡住 #更新 的问题：")
  for (const p of problems) console.error(`  - ${p}`)
  console.error("\n处理办法（三选一，推荐第一条）：")
  console.error("  1. 丢弃部署目录改动（仅当内容已在源码/远端有）：")
  console.error(`     git -C "${deployDir}" checkout -- .`)
  console.error(`     git -C "${deployDir}" clean -fd`)
  console.error("  2. 到源码仓库提交并 push，然后在机器人里发 #更新 abyss")
  console.error("  3. 确认无害后再发 #强制更新 abyss（会 reset --hard，本地未推送提交会丢）")
  process.exit(1)
}
console.log("\n✅ 部署目录干净且与源码一致，#更新 abyss 可以正常快进")
