/**
 * 漏配就"起不来"，而不是"敞着门"（fail closed）
 *
 * 两条最要命的漏配，都在启动时拦掉：
 *   - **没配访问口令** → 谁来都是管理员（能覆盖整张表、改白名单、回退版本），所以拒绝启动；
 *     本机裸跑测试要放行必须显式 `--allow-no-token`。
 *   - 开了 `--owner-only` 却没有 owner 名单 → 谁都进不来（那条在 owner-only.test.mjs 里）。
 *
 * 这里不需要真实表格：拿仓库里的空模板就够（本套件不该因为缺数据而跳过）。
 *
 * 用法：node editor/test/fail-closed.test.mjs
 */
import fs from "node:fs"
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

const wait = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`)
  }
}

/** 起一个进程并等它退出（用来验证"拒绝启动"） */
const runToExit = async (args, env = {}) => {
  /** 临时目录里的表：漏配自检也在测试模式里跑（见 data-confinement.test.mjs） */
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", d => (out += d))
  child.stderr.on("data", d => (out += d))
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill()
      resolve("timeout")
    }, 15000)
    child.on("close", c => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  return { code, out }
}

try {
  const noToken = await runToExit([editor, "--file", fixture, "--port", "7810"])
  check("没配口令 + 不显式放行 → 拒绝启动（退出码 1）", noToken.code === 1, `退出码 ${noToken.code}\n${noToken.out.slice(-300)}`)
  check("拒绝启动时说清了原因（提到访问口令与 --allow-no-token）", noToken.out.includes("访问口令") && noToken.out.includes("--allow-no-token"), noToken.out.slice(-300))

  /** 显式放行（本机测试那种）：能起来，并且在 healthz 里标明"口令未启用" */
  const port = 7811
  const child = spawn(process.execPath, [editor, "--file", fixture, "--port", String(port), "--allow-no-token"], {
    env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", d => (out += d))
  child.stderr.on("data", d => (out += d))
  try {
    let health = null
    for (let i = 0; i < 30 && !health; i++) {
      await wait(400)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`)
        if (res.ok) health = await res.json()
      } catch {}
    }
    check("显式 --allow-no-token 时能起来（本机测试用）", Boolean(health?.ok), out.slice(-300))
    check("healthz 如实标明口令未启用", health?.auth === false, JSON.stringify(health))
  } finally {
    child.kill()
  }
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 漏配自检失败 ${failed} 项` : "\n✅ 漏配自检通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
