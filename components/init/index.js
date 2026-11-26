/** `#排队初始化` —— 主人专用的一次性初始化（**三步 · 遇错即停**） */
import nodeFs from "node:fs"
import path from "node:path"

import { pluginRoot as defaultPluginRoot } from "../config.js"
import { FAIL, STEP_TITLES } from "./common.js"
import { stepHealth, stepWhitelist } from "./steps.js"
import { stepSecrets } from "./secrets.js"

export const INIT_DENIED = "只有机器人的主人才能用 #排队初始化"

function initPaths(pluginRoot) {
  const data = path.join(pluginRoot, "data")
  return {
    pluginRoot,
    dataDir: data,
    configPath: path.join(pluginRoot, "config", "config.yaml"),
    adminsFile: path.join(data, "abyss-editor-admins.json"),
  }
}

export async function runInit(opts = {}) {
  const pluginRoot = opts.pluginRoot || defaultPluginRoot
  const ctx = {
    qq: opts.qq,
    pluginRoot,
    fs: opts.fs ?? nodeFs,
    fetch: opts.fetch ?? globalThis.fetch,
    port: Number(opts.port ?? globalThis.cfg?.server?.port),
    paths: initPaths(pluginRoot),
    secrets: null,
  }
  const runners = [stepSecrets, stepWhitelist, stepHealth]
  if (runners.length !== STEP_TITLES.length || runners.some(fn => typeof fn !== "function"))
    throw new Error(`初始化步骤装配不完整：${runners.length}/${STEP_TITLES.length}`)
  const steps = []
  for (let i = 0; i < runners.length; i++) {
    let out
    try {
      out = await runners[i](ctx)
    } catch (err) {
      out = FAIL(`没预料到的异常：${err?.message ?? err}`)
    }
    steps.push({ no: i + 1, title: STEP_TITLES[i], status: out.status, detail: out.detail })
    if (out.status !== "fail") continue
    for (let j = i + 1; j < runners.length; j++)
      steps.push({ no: j + 1, title: STEP_TITLES[j], status: "todo", detail: "未做（上一步失败即停）" })
    return { ok: false, failedAt: i + 1, steps }
  }
  return { ok: true, failedAt: null, steps }
}

export function renderInitReport(result) {
  const mark = { done: "✅", skip: "⏭", fail: "❌", todo: "⏸" }
  const lines = ["【排队初始化】三步：口令与密钥 → 白名单 → 探活（主人专用 · 遇错即停）", ""]
  for (const s of result.steps) lines.push(`${s.no}. ${mark[s.status] ?? "·"} ${s.title}：${s.detail}`)
  if (result.ok) {
    lines.push(
      "",
      "全部步骤完成。**重启一次机器人**，编辑器就会随框架挂起来（它挂在 bot 自己的 server 上）；",
      "凭证与页脚是在插件加载时交给编辑器的，改完也要重启才生效。",
    )
    return lines.join("\n")
  }
  const done = result.steps.filter(s => s.no < result.failedAt).map(s => s.no)
  const todo = result.steps.filter(s => s.status === "todo").map(s => s.no)
  lines.push(
    "",
    `❌ 第 ${result.failedAt} 步失败，已按「遇错即停」停在原地（后面一步都没做）`,
    `已完成：${done.length ? done.join("、") : "（无）"}`,
    `未做：${todo.length ? todo.join("、") : "（无）"}`,
    "修掉上面的原因再发一次 #排队初始化；已经做好的产物不会被覆盖。",
  )
  return lines.join("\n")
}

export async function runInitCommand(e, { reply, ...deps } = {}) {
  const send = text => (reply ? reply(text) : e?.reply?.(text))
  if (e?.isMaster !== true) {
    send(INIT_DENIED)
    return { ok: false, denied: true, failedAt: null, steps: [] }
  }
  const result = await runInit({ ...deps, qq: String(e?.user_id ?? "").trim() })
  send(renderInitReport(result))
  return result
}
