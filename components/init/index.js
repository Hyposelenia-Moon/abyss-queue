/**
 * `#排队初始化` —— 主人专用的一次性初始化（**三步 · 遇错即停**）
 *
 * 编辑器本身由 `modules/editor-host.js` 随框架启停（挂在 bot 自己的 HTTP server 上），
 * 所以这里只剩"没人会自动做"的三件事：
 *   1. **访问口令 / 签名密钥**：为空才生成，且只改 `remote` 段那两行
 *   2. **编辑器白名单**：没有 owner 就写上发送者 QQ（权限只认 QQ，昵称不算）
 *   3. **编辑器探活**：没在跑也只报告（不重启机器人、不 kill 进程——那些是主人的决定）
 *
 * 三条硬规矩（改这里之前先读）：
 *   1. **只认主人**：`e.isMaster` 不是 true 就直接拒绝（`runInitCommand`），
 *      连数据目录都不看一眼，一个字节都不写。
 *   2. **遇错即停**：任何一步 ❌ 立刻返回，后面的步骤一步都不做（把异常翻成 ❌ 也**只是停**，
 *      绝不吞掉继续往下——继续做才是真正的坑：半套产物比没有产物更难查）。
 *   3. **不覆盖既有产物**：文件已存在就只**校验 + 报告**，不一致宁可 ❌ 让主人自己决定。
 *
 * 副作用（读写文件、探活）全部走**注入的 deps**：回归套件用桩跑完整流程，
 * 不碰真实机器（见 test/init.test.mjs）。默认实现是 node:fs / fetch。
 *
 * 文件划分：本文件 = 编排（路径口径 + 按序跑三步 + 遇错即停 + 报告 + 指令入口）；
 * 步骤实现：`secrets.js`（第 1 步）/ `steps.js`（第 2、3 步）；跨步骤的小工具在 `common.js`。
 */
import nodeFs from "node:fs"
import path from "node:path"

import { pluginRoot as defaultPluginRoot } from "../config.js"
import { DEFAULT_PORT, FAIL, STEP_TITLES } from "./common.js"
import { stepHealth, stepWhitelist } from "./steps.js"
import { stepSecrets } from "./secrets.js"

/** 非主人一律回这一句（回归断言引用它，别在测试里手抄字符串） */
export const INIT_DENIED = "只有机器人的主人才能用 #排队初始化"

/** 组装这次要用的所有路径（唯一的口径来源） */
function initPaths(pluginRoot) {
  /** 数据目录**固定在插件里**：`<插件根>/data`（硬约定）——没有"挪到别处"的口子 */
  const data = path.join(pluginRoot, "data")
  return {
    pluginRoot,
    dataDir: data,
    configPath: path.join(pluginRoot, "config", "config.yaml"),
    adminsFile: path.join(data, "abyss-editor-admins.json"),
  }
}

/**
 * 按顺序跑完三步，遇错即停
 *
 * @param {object} opts
 * @param {string} opts.qq 发送者 QQ（白名单只认 QQ）
 * @param {string} [opts.pluginRoot] 插件根（默认取 components/config.js 的 pluginRoot）
 * @param {object} [opts.fs] 文件系统（默认 node:fs；注入桩即可全程不碰真实磁盘）
 * @param {Function} [opts.fetch] 探活用（默认全局 fetch）
 * @param {number} [opts.port] 探活端口（默认取框架 `cfg.server.port`，拿不到才用 7788；
 *   编辑器挂在 bot 自己的 server 上，所以正常情况下就是 bot 的端口）
 * @returns {Promise<{ok:boolean,failedAt:number|null,steps:Array<{no:number,title:string,status:string,detail:string}>}>}
 */
export async function runInit(opts = {}) {
  const pluginRoot = opts.pluginRoot || defaultPluginRoot
  const ctx = {
    qq: opts.qq,
    pluginRoot,
    fs: opts.fs ?? nodeFs,
    fetch: opts.fetch ?? globalThis.fetch,
    port: Number(opts.port ?? globalThis.cfg?.server?.port ?? DEFAULT_PORT),
    paths: initPaths(pluginRoot),
    secrets: null,
  }

  const runners = [stepSecrets, stepWhitelist, stepHealth]
  /** 少一个都会让"三步"名不副实：显式校验，别让缺实现变成静默少跑一步 */
  if (runners.length !== STEP_TITLES.length || runners.some(fn => typeof fn !== "function"))
    throw new Error(`初始化步骤装配不完整：${runners.length}/${STEP_TITLES.length}`)

  const steps = []
  for (let i = 0; i < runners.length; i++) {
    let out
    try {
      out = await runners[i](ctx)
    } catch (err) {
      /** 异常翻成 ❌ **只是为了停在这里**（下面立刻 return），不是吞掉错误：详情照原样报出去 */
      out = FAIL(`没预料到的异常：${err?.message ?? err}`)
    }
    steps.push({ no: i + 1, title: STEP_TITLES[i], status: out.status, detail: out.detail })
    if (out.status !== "fail") continue
    /** 遇错即停：后面的步骤一步都不做，只把它们标成"未做" */
    for (let j = i + 1; j < runners.length; j++)
      steps.push({ no: j + 1, title: STEP_TITLES[j], status: "todo", detail: "未做（上一步失败即停）" })
    return { ok: false, failedAt: i + 1, steps }
  }
  return { ok: true, failedAt: null, steps }
}

/** 把结果渲染成一条给主人看的消息（✅ 做了什么 / ⏭ 已存在跳过 / ❌ 失败原因） */
export function renderInitReport(result) {
  const mark = { done: "✅", skip: "⏭", fail: "❌", todo: "⏸" }
  const lines = ["【排队初始化】三步：口令与密钥 → 白名单 → 探活（主人专用 · 遇错即停）", ""]
  for (const s of result.steps) lines.push(`${s.no}. ${mark[s.status] ?? "·"} ${s.title}：${s.detail}`)

  if (result.ok) {
    lines.push("", "全部步骤完成。编辑器由机器人带着跑（随框架启停），改完配置重载即生效。")
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

/**
 * 指令入口：主人判定 + 跑一遍 + 回报告
 *
 * 主人判定用框架注入的 `e.isMaster`（`lib/plugins/loader.js` 按 cfg.master 打的标），
 * 不自己造一套。非主人**立刻拒绝**：不读配置、不建目录、一个字都不写。
 *
 * 顺带把 `initDeps` 之外的一切副作用收在 `runInit` 里：套件只替换 deps 就能跑完整流程。
 */
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
