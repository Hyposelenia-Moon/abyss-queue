/**
 * #排队初始化 —— 把「本机编辑器」那套手工初始化一次做完（**主人专用 · 遇错即停**）
 *
 * 为什么要有这条指令：换机 / 新部署时，本机编辑器这条链要手工摆七八样东西
 * （数据目录、本地表格副本、口令与签名密钥、editor-path.txt、两个 vbs、启动器 mjs、
 * 白名单、计划任务），顺序错了或漏一样，现象是"双击没反应"或"只有主人打不开"，
 * 排查成本远高于重做一遍。这里把它们按固定顺序做一遍，每步都留下 ✅/⏭/❌。
 *
 * 三条硬规矩（改这里之前先读）：
 *   1. **只认主人**：见 `runInitCommand` —— `e.isMaster` 不是 true 就直接拒绝，
 *      连数据目录都不看一眼，一个字节都不写。
 *   2. **遇错即停**：任何一步 ❌ 立刻返回，后面的步骤一步都不做（把异常翻成 ❌ 也**只是停**，
 *      绝不吞掉继续往下——继续做才是真正的坑：半套产物比没有产物更难查）。
 *   3. **不覆盖既有产物**：文件 / 计划任务已存在就只**校验 + 报告**；与当前配置不一致宁可 ❌
 *      让主人自己决定，插件不自动覆盖（口令被换掉、任务被改写都会打断正在跑的编辑器）。
 *
 * 副作用（读写文件、注册计划任务、探活）全部走**注入的 deps**：回归套件用桩跑完整流程，
 * 不碰真实机器（见 test/init.test.mjs）。默认实现是 node:fs / schtasks / fetch。
 *
 * 文件划分：本文件只做**编排**（组装 ctx → 按序跑七步 → 遇错即停 → 出报告），
 * 每步的实现各占 `init/` 下的一个文件，共用的小工具在 `init/shared.js`。
 */
import { spawnSync } from "node:child_process"
import nodeFs from "node:fs"
import path from "node:path"

import { pluginRoot as defaultPluginRoot } from "../config.js"
import { DEFAULT_PORT, FAIL, STEP_TITLES, TASK_NAME } from "./shared.js"
import { initPaths } from "./paths.js"
import { stepDataDir } from "./step-data-dir.js"
import { stepLocalXlsx } from "./step-local-xlsx.js"
import { stepSecrets } from "./step-secrets.js"
import { stepLauncherArtifacts } from "./step-launcher-artifacts.js"
import { stepWhitelist } from "./step-whitelist.js"
import { stepScheduledTask } from "./step-scheduled-task.js"
import { stepHealth } from "./step-health.js"
import { renderInitReport } from "./report.js"

/** 非主人一律回这一句（回归断言引用它，别在测试里手抄字符串） */
export const INIT_DENIED = "只有机器人的主人才能用 #排队初始化"

export { TASK_NAME, renderInitReport }
export { patchRemoteSecrets, readRemoteKeys } from "./step-secrets.js"

/** 默认的 schtasks 执行器：拿原始字节自己解码（中文 Windows 上 schtasks 会吐 UTF-16） */
function decodeText(buf) {
  if (!buf || !buf.length) return ""
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le", 2)
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString("utf16le")
  }
  /** 没有 BOM 也要认：头部隔一个字节一个 0x00 就是 UTF-16LE */
  let nuls = 0
  const head = Math.min(buf.length, 64)
  for (let i = 1; i < head; i += 2) if (buf[i] === 0) nuls++
  return nuls > head / 4 ? buf.toString("utf16le") : buf.toString("utf8")
}

function defaultExec(command, args) {
  const r = spawnSync(command, args, { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
  const stderr = decodeText(r.stderr)
  return {
    status: r.status ?? (r.error ? 1 : 0),
    stdout: decodeText(r.stdout),
    stderr: stderr || (r.error ? String(r.error.message ?? r.error) : ""),
  }
}

/**
 * 按顺序跑完七步，遇错即停
 *
 * @param {object} opts
 * @param {string} opts.qq 发送者 QQ（白名单只认 QQ）
 * @param {string} [opts.pluginRoot] 插件根（默认取 components/config.js 的 pluginRoot）
 * @param {object} [opts.fs] 文件系统（默认 node:fs；注入桩即可全程不碰真实磁盘）
 * @param {(cmd:string,args:string[])=>{status:number,stdout:string,stderr:string}} [opts.exec] 计划任务用
 * @param {Function} [opts.fetch] 探活用（默认全局 fetch）
 * @param {string} [opts.wscript] 任务动作里的 wscript 路径
 * @param {number} [opts.port] 编辑器端口（默认 7788，与启动器一致）
 * @returns {Promise<{ok:boolean,failedAt:number|null,steps:Array<{no:number,title:string,status:string,detail:string}>}>}
 */
export async function runInit(opts = {}) {
  const pluginRoot = opts.pluginRoot || defaultPluginRoot
  const ctx = {
    qq: opts.qq,
    pluginRoot,
    fs: opts.fs ?? nodeFs,
    exec: opts.exec ?? defaultExec,
    fetch: opts.fetch ?? globalThis.fetch,
    wscript: opts.wscript ?? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"),
    port: Number(opts.port ?? process.env.ABYSS_EDITOR_PORT ?? DEFAULT_PORT),
    assetsDir: path.join(pluginRoot, "resources", "init"),
    paths: initPaths(pluginRoot),
    secrets: null,
  }

  const runners = [stepDataDir, stepLocalXlsx, stepSecrets, stepLauncherArtifacts, stepWhitelist, stepScheduledTask, stepHealth]
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

/**
 * 指令入口：主人判定 + 跑一遍 + 回报告
 *
 * 主人判定用框架注入的 `e.isMaster`（`lib/plugins/loader.js:425` 按 cfg.master 打的标），
 * 不自己造一套。非主人**立刻拒绝**：不读配置、不建目录、一个字都不写。
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
