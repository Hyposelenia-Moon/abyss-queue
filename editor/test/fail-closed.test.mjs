/** 漏配就"起不来"，而不是"敞着门"（fail closed） */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { PLUGIN_DIR } from "./plugin.mjs"
import { createSoftChecker } from "../../test/_helper.mjs"

const TEMPLATE = path.join(PLUGIN_DIR, "resources", "空模板.xlsx")
if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 找不到空模板（${TEMPLATE}），跳过漏配自检`)
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-failclosed-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(TEMPLATE, fixture)
const cfg = path.join(tmp, "config.yaml")
/** 数据落点：测试模式下派生自表格所在目录（表格就在这个临时目录里），配置里没有路径键 */
fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")
const editor = path.resolve(import.meta.dirname, "..", "editor.mjs")

const TOKEN = "failclosed-token"
const SIGN_KEY = "failclosed-sign-key"
const ADMIN_TOKEN = "failclosed-admin-token"

// 「表落在插件 data 内」的那一份副本：**只给"测试开关没开"那条用例用**
const dataDir = path.join(PLUGIN_DIR, "data")
const insideFixture = path.join(dataDir, `.failclosed-${process.pid}.xlsx`)
fs.mkdirSync(dataDir, { recursive: true })
fs.copyFileSync(TEMPLATE, insideFixture)

const wait = ms => new Promise(r => setTimeout(r, ms))
const { check, finish } = createSoftChecker("漏配自检")

/** 要一个空闲端口：套件之间不抢固定端口，也不用赌某个端口没被别的套件占着（实现与别的套件共用一份） */
const { freePort } = await import("../../test/_helper.mjs")

// 起一个进程
const launch = (args, env = {}, cwd = import.meta.dirname) => {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", d => (out += d))
  child.stderr.on("data", d => (out += d))
  child.exited = new Promise(resolve => child.on("close", code => resolve(code)))
  child.text = () => out
  return child
}

/** 等进程自己退出；到点还没退（= 起起来了）就杀掉并返回 null */
const exitWithin = async (child, ms = 15000) => {
  const code = await Promise.race([child.exited, wait(ms).then(() => null)])
  if (code === null) {
    child.kill()
    await wait(300)
  }
  return code
}

/** 等 `/healthz` 应答；进程先退出了就直接返回 null（别白等，也顺便证明"没起来"） */
const waitHealth = async (child, port, ms = 15000) => {
  for (let i = 0; i < Math.ceil(ms / 300); i++) {
    await wait(300)
    if (child.exitCode !== null) return null
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz?k=${encodeURIComponent(TOKEN)}`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
  }
  return null
}

/** 起一个"应该被拒"的进程：退出码 1 且输出点明了原因 */
const expectRefused = async (label, args, env = {}, keyword = "") => {
  const child = launch(args, env)
  const code = await exitWithin(child, 15000)
  const out = child.text()
  check(`${label} → 拒绝启动（退出码 1）`, code === 1, `退出码 ${code}\n${out.slice(-400)}`)
  if (keyword) check(`${label}：原因点明了「${keyword}」`, out.includes(keyword), out.slice(-500))
  return out
}

const children = []
try {
  /* ------------------------------ 口令 ------------------------------ */
  await expectRefused("没配口令 + 不显式放行", [editor, "--file", fixture, "--port", String(await freePort())], {}, "访问口令")
  {
    const child = launch([editor, "--file", fixture, "--port", String(await freePort())])
    const code = await exitWithin(child, 15000)
    const out = child.text()
    check(
      "没配口令：提醒了显式放行开关（--allow-no-token）",
      code === 1 && out.includes("--allow-no-token"),
      `退出码 ${code}\n${out.slice(-400)}`,
    )
  }
  /** 显式放行（本机测试那种）：能起来，并且在 healthz 里标明"口令未启用" */
  {
    const port = await freePort()
    const child = launch([editor, "--file", fixture, "--port", String(port), "--allow-no-token"])
    children.push(child)
    const health = await waitHealth(child, port)
    check("显式 --allow-no-token 时能起来（本机测试用）", Boolean(health?.ok), child.text().slice(-300))
    check("healthz 如实标明口令未启用", health?.auth === false, JSON.stringify(health))
  }
  /* ------------------- 缺表：新装还没放表时，必须给出下一步动作 ------------------- */
  // 缺表不是"漏配"，而是"新装/换月还没放表"——日志里只回一句"表格不存在"等于让部署方去猜。
  {
    const missing = path.join(dataDir, `.failclosed-missing-${process.pid}.xlsx`)
    const out = await expectRefused(
      "表不存在（新装还没放表）",
      [editor, "--file", missing, "--allow-no-token", "--port", String(await freePort())],
      {},
      "表格不存在",
    )
    check(
      "缺表：提示点明了「从哪复制到哪」（下一步动作，不是一句表不存在）",
      out.includes(path.join(PLUGIN_DIR, "resources", "空模板.xlsx")) && out.includes(missing),
      out.slice(-500),
    )
  }
  /* ------------------- 口令不许被复用成特权凭证（S02） ------------------- */
  // 对外部署（非回环绑定）+ 三者独立：**正常配置必须能起**
  {
    const port = await freePort()
    const child = launch([
      editor,
      "--file", fixture,
      "--port", String(port),
      "--bind", "0.0.0.0",
      "--token", TOKEN,
      "--sign-key", SIGN_KEY,
      "--admin-token", ADMIN_TOKEN,
    ])
    children.push(child)
    const health = await waitHealth(child, port)
    check("对外绑定 + 三者各自独立 → 能起来", Boolean(health?.ok), child.text().slice(-400))
    check("healthz 表明签名密钥与口令不同", health?.sign_key === true, JSON.stringify(health))
    check("正常配置下没有「本机兼容模式」的放行提示", !child.text().includes("本机兼容模式"), child.text().slice(-400))
  }
  /** 缺独立 SIGN_KEY（只给口令）：拿到链接的人能签出主人身份 */
  const noSignKey = await expectRefused(
    "对外绑定 + 没配独立 SIGN_KEY",
    [editor, "--file", fixture, "--port", String(await freePort()), "--bind", "0.0.0.0", "--token", TOKEN],
    {},
    "SIGN_KEY 与 TOKEN 相同",
  )
  check(
    "缺独立 SIGN_KEY：说清了怎么补（--sign-key 另配一段随机串）",
    noSignKey.includes("--sign-key"),
    noSignKey.slice(-500),
  )
  /** 显式填成同一个值也算复用（"显式"不等于"安全"） */
  await expectRefused(
    "对外绑定 + SIGN_KEY 显式等于 TOKEN",
    [editor, "--file", fixture, "--port", String(await freePort()), "--bind", "0.0.0.0", "--token", TOKEN, "--sign-key", TOKEN],
    {},
    "SIGN_KEY 与 TOKEN 相同",
  )
  /** ADMIN_TOKEN 等于 TOKEN：签名密钥再独立也没用，普通口令直接是完整主人能力 */
  await expectRefused(
    "对外绑定 + ADMIN_TOKEN 等于 TOKEN",
    [editor, "--file", fixture, "--port", String(await freePort()), "--bind", "0.0.0.0", "--token", TOKEN, "--sign-key", SIGN_KEY, "--admin-token", TOKEN],
    {},
    "ADMIN_TOKEN 与 TOKEN 相同",
  )
  /** 特权凭证之间也不许复用：管理口令与签名密钥同值，等于把两个职责压成一段字符串 */
  await expectRefused(
    "对外绑定 + ADMIN_TOKEN 等于 SIGN_KEY",
    [editor, "--file", fixture, "--port", String(await freePort()), "--bind", "0.0.0.0", "--token", TOKEN, "--sign-key", SIGN_KEY, "--admin-token", SIGN_KEY],
    {},
    "ADMIN_TOKEN 与 SIGN_KEY 相同",
  )
  /* ------------------------ 本地兼容模式的两个条件 ------------------------ */
  /** 回环 + 测试开关：这是唯一允许"退回用口令签"的组合（本机联调） */
  {
    const port = await freePort()
    const child = launch([
      editor,
      "--file", fixture,
      "--port", String(port),
      "--token", TOKEN,
      // 不给 --sign-key：退回用口令签（本机兼容模式）
    ])
    children.push(child)
    const health = await waitHealth(child, port)
    check("回环绑定 + 测试开关 → 本地兼容模式放行（本机联调）", Boolean(health?.ok), child.text().slice(-500))
    check("healthz 如实表明签名密钥就是口令（没有假装独立）", health?.sign_key === false, JSON.stringify(health))
    check(
      "启动日志讲清了放行条件（回环 + ABYSS_EDITOR_TEST_PATHS=1）",
      child.text().includes("本机兼容模式") && child.text().includes("ABYSS_EDITOR_TEST_PATHS=1"),
      child.text().slice(-600),
    )
  }
  // 回环 + **没有**测试开关：一样要拒（两个条件缺一不可）
  await expectRefused(
    "回环绑定 + 没开测试开关 + 没独立 SIGN_KEY",
    [editor, "--file", insideFixture, "--port", String(await freePort()), "--token", TOKEN],
    { ABYSS_EDITOR_TEST_PATHS: "" },
    "测试开关未开",
  )
} catch (err) {
  check.fail()
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  for (const child of children) child.kill()
  await wait(300)
  fs.rmSync(insideFixture, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
}

/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */

await finish()
