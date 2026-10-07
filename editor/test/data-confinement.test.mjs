/**
 * 数据只能待在插件里（生产口径）+ 测试模式的放行开关
 *
 * 为什么单独一个套件：编辑器与插件都按"数据落点"派生出**一整套**文件（表 / .bak / 绑定 / 锁 /
 * 白名单 / 群名单 / versions / archives / 进度快照）。落点只要能被配置指到插件外面，
 * 更新（`#更新 abyss` 只动代码）、备份、迁移就会各按各的路径找，哪一份都不是完整的。
 * 所以生产口径是"固定在 `<插件根>\data`，指到外面就拒绝/回落"，而回归套件必须能用系统临时目录
 * （绝不动仓库里的真表），于是留一个**只给套件**的开关。
 *
 * 钉住四条，任何一条松掉就红：
 *   ① 生产模式：`--file` 指到插件外 → 进程拒绝启动，并写清"必须留在插件目录内"与解析出的路径
 *   ② 同一份文件 + `ABYSS_EDITOR_TEST_PATHS=1` → 照旧能起（测试模式放行插件外的落点）
 *   ③ 生产模式：`ABYSS_EDITOR_VERSIONS_DIR` 指到插件外 → 被忽略，写表落进 `<插件根>\data\versions`
 *   ④ 插件侧数据落点**是常量**：`data/` 下拼出来，配置里没有对应的键（见 components/config.js）；
 *      `ABYSS_QUEUE_*` 那组环境变量只给套件用，不在测试模式下设了也会被挡回插件内并记 error
 *
 * ③ 为什么用**临时插件根**：编辑器按自身位置自定位插件根，只有真换一个插件根（把插件代码拷过去、
 * 把空模板复制成它 `data/queue.xlsx`），才能证明"生产落点跟着插件根走、不跟着配置走"。
 *
 * 用法：node editor/test/data-confinement.test.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { PLUGIN_DIR } from "./plugin.mjs"
/** 要一个空闲端口：实现与别的套件共用一份（见 test/_helper.mjs） */
import { freePort } from "../../test/_helper.mjs"

const TEMPLATE = path.join(PLUGIN_DIR, "resources", "空模板.xlsx")
if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 套件跳过：找不到空模板（${TEMPLATE}）`)
  process.exit(0)
}

const EDITOR = path.resolve(import.meta.dirname, "..", "editor.mjs")
const TOKEN = "confinement-token"
/** 签名密钥必须独立于口令：S02 之后"口令复用成特权凭证"会被拒绝启动（回环 + 没开测试开关时） */
const SIGN_KEY = "confinement-sign-key"
const ADMIN_TOKEN = "confinement-admin-token"

/**
 * 生产环境：显式把开关清空
 *
 * run.mjs 是原样传递环境变量的，套件不能假设"外面没设过"——设了就等于把被测规则让开了。
 */
const PROD_ENV = { ...process.env, ABYSS_EDITOR_TEST_PATHS: "" }
/** 测试模式：套件用的那个开关 */
const TEST_ENV = { ...process.env, ABYSS_EDITOR_TEST_PATHS: "1" }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-confinement-"))
/** 插件外的临时工作区：生产模式该被拒 */
const outside = path.join(root, "outside")
fs.mkdirSync(outside, { recursive: true })
const fixture = path.join(outside, "queue.xlsx")
fs.copyFileSync(TEMPLATE, fixture)
/** 被忽略的覆盖落点：一个文件都不该在它下面出现 */
const elsewhere = path.join(root, "somewhere-else")

let failed = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`)
  }
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

const wait = ms => new Promise(r => setTimeout(r, ms))

/** 起一个编辑器进程；输出收集起来给断言用 */
const launch = (args, env) => {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", d => (out += d))
  child.stderr.on("data", d => (out += d))
  child.exited = new Promise(resolve => child.on("close", code => resolve(code)))
  child.text = () => out
  return child
}

/** 等进程自己退出；到了 ms 还没退（= 起来了）就杀掉并返回 null */
const exitWithin = async (child, ms) => {
  const code = await Promise.race([child.exited, wait(ms).then(() => null)])
  if (code === null) {
    child.kill()
    await wait(300)
  }
  return code
}

/** 等 `/healthz` 应答；进程先退出了就直接返回 null（别白等） */
const waitHealth = async (child, port, ms = 15000) => {
  for (let i = 0; i < Math.ceil(ms / 300); i++) {
    await wait(300)
    if (child.exitCode !== null) return null
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz?k=${TOKEN}`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
  }
  return null
}

const children = []
try {
  /* ------------------------- ① 生产模式：插件外一律拒绝 ------------------------- */

  const port1 = await freePort()
  const prod = launch([EDITOR, "--file", fixture, "--port", String(port1), "--token", TOKEN, "--sign-key", SIGN_KEY], PROD_ENV)
  children.push(prod)
  const code1 = await exitWithin(prod, 15000)
  check("生产模式：--file 指到插件外 → 拒绝启动（退出码 1）", code1 === 1, `退出码 ${code1}\n${prod.text().slice(-400)}`)
  check(
    "拒绝时写清了「必须留在插件目录内」与解析出的路径",
    prod.text().includes("必须留在插件目录内") && prod.text().toLowerCase().includes(fixture.toLowerCase()),
    prod.text().slice(-500),
  )

  /* ------------------------- ② 测试模式：同一份文件照旧能起 ------------------------- */

  const port2 = await freePort()
  const test = launch([EDITOR, "--file", fixture, "--port", String(port2), "--token", TOKEN, "--sign-key", SIGN_KEY, "--mount", ""], TEST_ENV)
  children.push(test)
  const health2 = await waitHealth(test, port2)
  check("测试模式（ABYSS_EDITOR_TEST_PATHS=1）：同一份临时表能正常起来", Boolean(health2?.ok), test.text().slice(-400))
  check(
    "测试模式的落点仍跟着表（临时目录），不写插件内的 data/",
    test.text().includes("数据目录：") && test.text().toLowerCase().includes(outside.toLowerCase()),
    test.text().slice(-400),
  )
  test.kill()
  await wait(400)

  /* ------------------------- ③ 生产模式：临时插件根 + 出圈的覆盖目录 ------------------------- */

  const pluginRoot = path.join(root, "plugins", "abyss-queue")
  fs.mkdirSync(path.join(pluginRoot, "data"), { recursive: true })
  for (const dir of ["components", "model", "modules", "config", "editor", "resources"])
    fs.cpSync(path.join(PLUGIN_DIR, dir), path.join(pluginRoot, dir), { recursive: true })
  /** 插件根还得有 package.json：`components/pluginVersion.js` 靠它读版本号（缺了编辑器起不来） */
  fs.copyFileSync(path.join(PLUGIN_DIR, "package.json"), path.join(pluginRoot, "package.json"))
  /** 运行时的真配置带口令，别复制进临时目录 */
  fs.rmSync(path.join(pluginRoot, "config", "config.yaml"), { force: true })
  const pluginXlsx = path.join(pluginRoot, "data", "queue.xlsx")
  fs.copyFileSync(TEMPLATE, pluginXlsx)
  /** 依赖不复制：用目录连接点指回真仓库的 node_modules（ESM 会按真实路径解析，只影响依赖，不影响插件根） */
  let linked = true
  try {
    fs.symlinkSync(path.join(PLUGIN_DIR, "node_modules"), path.join(pluginRoot, "node_modules"), "junction")
  } catch (err) {
    linked = false
    check("临时插件根用上依赖（junction node_modules）", false, err.message)
  }

  const port3 = await freePort()
  const confined = launch(
    [path.join(pluginRoot, "editor", "editor.mjs"), "--file", pluginXlsx, "--port", String(port3), "--token", TOKEN, "--sign-key", SIGN_KEY, "--admin-token", ADMIN_TOKEN, "--mount", ""],
    { ...PROD_ENV, ABYSS_EDITOR_VERSIONS_DIR: elsewhere, ABYSS_EDITOR_ADMINS_FILE: path.join(elsewhere, "admins.json") },
  )
  children.push(confined)
  const health3 = linked ? await waitHealth(confined, port3) : null
  check("生产模式：插件内的表能正常起来（表在它自己的 data/ 下）", Boolean(health3?.ok), confined.text().slice(-500))
  check(
    "启动日志打印了「数据目录」与「表文件」两行，且数据目录就是插件内的 data",
    confined.text().includes("数据目录：") && confined.text().includes("表文件：") && confined.text().toLowerCase().includes(path.join(pluginRoot, "data").toLowerCase()),
    confined.text().slice(-600),
  )
  check(
    "生产模式忽略 ABYSS_EDITOR_VERSIONS_DIR（版本目录仍在插件内）",
    confined.text().toLowerCase().includes(path.join(pluginRoot, "data", "versions").toLowerCase()) &&
      !confined.text().toLowerCase().includes(elsewhere.toLowerCase()),
    confined.text().slice(-600),
  )

  /** 真写一次表：能不能落进插件内的 data，光看日志不算数 */
  let uploaded = null
  if (health3?.ok) {
    try {
      const res = await fetch(`http://127.0.0.1:${port3}/api/upload?k=${encodeURIComponent(TOKEN)}&a=${encodeURIComponent(ADMIN_TOKEN)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: fs.readFileSync(TEMPLATE),
      })
      uploaded = await res.json().catch(() => null)
    } catch (err) {
      uploaded = { ok: false, error: err.message }
    }
  }
  check("写一次表（上传覆盖）成功", Boolean(uploaded?.ok), JSON.stringify(uploaded))

  const versionDir = path.join(pluginRoot, "data", "versions")
  const versions = fs.existsSync(versionDir) ? fs.readdirSync(versionDir).filter(f => /^queue-\d{8}-\d{6}(-\d+)?\.xlsx$/.test(f)) : []
  check("历史版本落在 <临时插件根>\\data\\versions", versions.length > 0, `versions=${versions.join("、") || "（空）"}`)
  check(
    "绑定与锁也落在 <临时插件根>\\data",
    fs.existsSync(path.join(pluginRoot, "data", "abyss-editor-bindings.json")) && fs.existsSync(path.join(pluginRoot, "data", "abyss-editor-locks.json")),
    fs.readdirSync(path.join(pluginRoot, "data")).join("、"),
  )
  check("被忽略的覆盖目录（ABYSS_EDITOR_VERSIONS_DIR）下一个文件都没建", !fs.existsSync(elsewhere), elsewhere)

  /* ------------- ④ 插件侧：落点是常量；环境变量只给套件，出圈仍被挡 ------------- */

  const outsideStore = path.join(outside, "bindings.json")
  const outsideBackup = path.join(outside, "backup")
  const outsideState = path.join(outside, "progress.json")
  globalThis.logger = { error: () => {}, warn: () => {}, info: () => {} }
  const { config, reloadConfig, pluginRoot: realRoot, dataDir } = await import(pathToFileURL(path.join(PLUGIN_DIR, "components", "config.js")).href)

  /** 生产：不设任何套件开关与变量 —— 三个落点都是 data/ 下的常量 */
  delete process.env.ABYSS_QUEUE_TEST_PATHS
  delete process.env.ABYSS_QUEUE_STORE_FILE
  delete process.env.ABYSS_QUEUE_BACKUP_DIR
  delete process.env.ABYSS_QUEUE_STATE_FILE
  delete process.env.ABYSS_QUEUE_XLSX_PATH
  process.env.ABYSS_QUEUE_CONFIG = path.join(root, "plugin-config.yaml")
  fs.writeFileSync(process.env.ABYSS_QUEUE_CONFIG, "default_sheet: 幽境危战\n", "utf8")
  reloadConfig()

  check(
    "插件侧绑定落点是 data/ 下的常量（配置里没有这个键）",
    same(config.storePath, path.join(realRoot, "data", "bindings.json")),
    `storePath=${config.storePath}`,
  )
  check(
    "插件侧快照备份落点是 data/backup（配置里没有这个键）",
    same(config.backupDir, path.join(realRoot, "data", "backup")),
    `backupDir=${config.backupDir}`,
  )
  check(
    "插件侧进度快照落点是 data/progress.json（配置里没有这个键）",
    same(config.notifyStatePath, path.join(dataDir, "progress.json")),
    `notifyStatePath=${config.notifyStatePath}`,
  )
  check("插件内默认值就在 <插件根>\\data 下（不是仓库外）", same(dataDir, path.join(realRoot, "data")), dataDir)

  /** 非测试模式：套件那组变量一律不认（设了也还是插件内的常量） */
  process.env.ABYSS_QUEUE_STORE_FILE = outsideStore
  process.env.ABYSS_QUEUE_BACKUP_DIR = outsideBackup
  process.env.ABYSS_QUEUE_STATE_FILE = outsideState
  process.env.ABYSS_QUEUE_XLSX_PATH = path.join(outside, "queue.xlsx")
  reloadConfig()
  check(
    "生产模式：ABYSS_QUEUE_* 指到插件外 → 一律不认，仍是插件内常量",
    same(config.storePath, path.join(realRoot, "data", "bindings.json")) &&
      same(config.backupDir, path.join(realRoot, "data", "backup")) &&
      same(config.notifyStatePath, path.join(dataDir, "progress.json")) &&
      !config.xlsxPath,
    `storePath=${config.storePath} backupDir=${config.backupDir} notifyStatePath=${config.notifyStatePath} xlsxPath=${config.xlsxPath}`,
  )

  /** 测试模式：套件要能把数据放进临时目录，那一组变量必须放行 */
  process.env.ABYSS_QUEUE_TEST_PATHS = "1"
  reloadConfig()
  check(
    "测试模式（ABYSS_QUEUE_TEST_PATHS=1）：插件侧认 ABYSS_QUEUE_* 那份临时路径",
    same(config.storePath, outsideStore) && same(config.backupDir, outsideBackup) && same(config.notifyStatePath, outsideState),
    `storePath=${config.storePath} backupDir=${config.backupDir} notifyStatePath=${config.notifyStatePath}`,
  )
  delete process.env.ABYSS_QUEUE_TEST_PATHS
  delete process.env.ABYSS_QUEUE_STORE_FILE
  delete process.env.ABYSS_QUEUE_BACKUP_DIR
  delete process.env.ABYSS_QUEUE_STATE_FILE
  delete process.env.ABYSS_QUEUE_XLSX_PATH
  delete process.env.ABYSS_QUEUE_CONFIG
  reloadConfig()
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err?.stack ?? err}`)
} finally {
  for (const child of children) if (child.exitCode === null) child.kill()
  await wait(400)
  /** 连接点先摘掉再删目录，别让 rmSync 顺着它往真仓库里走 */
  try {
    fs.unlinkSync(path.join(root, "plugins", "abyss-queue", "node_modules"))
  } catch {
    /* 没建成就没什么可摘 */
  }
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 数据落点收紧失败 ${failed} 项` : "\n✅ 数据落点收紧通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
