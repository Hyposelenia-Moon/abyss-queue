/**
 * 漏配就"起不来"，而不是"敞着门"（fail closed）
 *
 * 三类最要命的漏配，都在启动时拦掉：
 *   - **没配访问口令** → 谁来都是管理员（能覆盖整张表、改白名单、回退版本），所以拒绝启动；
 *     本机裸跑测试要放行必须显式 `--allow-no-token`。
 *   - **口令被复用成特权凭证**（缺独立 SIGN_KEY / SIGN_KEY 或 ADMIN_TOKEN 等于 TOKEN）→
 *     拿到链接的人能签出主人身份或直接当主人使唤，对外部署必须拒绝启动；
 *     本机联调要退回用口令签，必须**同时**满足"回环绑定 + ABYSS_EDITOR_TEST_PATHS=1"。
 *   - 开了 `--owner-only` 却没有 owner 名单 → 谁都进不来（那条在 owner-only.test.mjs 里）。
 *
 * 这里不需要真实表格：拿仓库里的空模板就够（本套件不该因为缺数据而跳过）。
 *
 * 用法：node editor/test/fail-closed.test.mjs
 */
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { PLUGIN_DIR } from "./plugin.mjs"

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

/**
 * 「表落在插件 data 内」的那一份副本：**只给"测试开关没开"那条用例用**
 *
 * 为什么要专门造它：`createConfig` 里"数据不许出插件"的闸门排在密钥闸门前面，表放在系统临时目录时
 * 会先撞上前者——那样测出来的就不是"密钥复用要拒"，而是"路径要拒"了。要让两个条件都成立
 * （回环绑定 + **没有**测试开关），表就必须真的在 `<插件根>/data` 里。
 * `data/` 是运行期目录（已 gitignore），这份临时副本用完即删。
 */
const dataDir = path.join(PLUGIN_DIR, "data")
const insideFixture = path.join(dataDir, `.failclosed-${process.pid}.xlsx`)
fs.mkdirSync(dataDir, { recursive: true })
fs.copyFileSync(TEMPLATE, insideFixture)

const wait = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`)
  }
}

/** 要一个空闲端口（让系统挑）：套件之间不抢固定端口，也不用赌某个端口没被别的套件占着 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })

/**
 * 起一个进程
 *
 * @param {string[]} args 编辑器参数（脚本路径在前）
 * @param {object} [env] 追加/覆盖的环境变量（默认就是"回归套件那种"：临时目录 + 测试开关）
 * @param {string} [cwd] 工作目录（默认套件目录）
 */
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

  await expectRefused("没配口令 + 不显式放行", [editor, "--file", fixture, "--port", "7810"], {}, "访问口令")
  {
    const child = launch([editor, "--file", fixture, "--port", "7810"])
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

  /* ------------------- 口令不许被复用成特权凭证（S02） ------------------- */

  /**
   * 对外部署（非回环绑定）+ 三者独立：**正常配置必须能起**
   *
   * 先验这条，后面几条"拒绝了"才有意义——否则"全拒"也能让断言全绿。
   */
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
    [editor, "--file", fixture, "--port", "7812", "--bind", "0.0.0.0", "--token", TOKEN],
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
    [editor, "--file", fixture, "--port", "7813", "--bind", "0.0.0.0", "--token", TOKEN, "--sign-key", TOKEN],
    {},
    "SIGN_KEY 与 TOKEN 相同",
  )

  /** ADMIN_TOKEN 等于 TOKEN：签名密钥再独立也没用，普通口令直接是完整主人能力 */
  await expectRefused(
    "对外绑定 + ADMIN_TOKEN 等于 TOKEN",
    [editor, "--file", fixture, "--port", "7814", "--bind", "0.0.0.0", "--token", TOKEN, "--sign-key", SIGN_KEY, "--admin-token", TOKEN],
    {},
    "ADMIN_TOKEN 与 TOKEN 相同",
  )

  /** 特权凭证之间也不许复用：管理口令与签名密钥同值，等于把两个职责压成一段字符串 */
  await expectRefused(
    "对外绑定 + ADMIN_TOKEN 等于 SIGN_KEY",
    [editor, "--file", fixture, "--port", "7816", "--bind", "0.0.0.0", "--token", TOKEN, "--sign-key", SIGN_KEY, "--admin-token", SIGN_KEY],
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

  /**
   * 回环 + **没有**测试开关：一样要拒（两个条件缺一不可）
   *
   * 表落在插件 data 内（`insideFixture`），否则会先被"数据不许出插件"那条拦下，测不到这条规则。
   */
  await expectRefused(
    "回环绑定 + 没开测试开关 + 没独立 SIGN_KEY",
    [editor, "--file", insideFixture, "--port", "7815", "--token", TOKEN],
    { ABYSS_EDITOR_TEST_PATHS: "" },
    "测试开关未开",
  )
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  for (const child of children) child.kill()
  await wait(300)
  fs.rmSync(insideFixture, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 漏配自检失败 ${failed} 项` : "\n✅ 漏配自检通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
