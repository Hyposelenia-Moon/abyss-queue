/**
 * #排队初始化 —— 把「本机编辑器」那套手工初始化一次做完（**主人专用 · 遇错即停**）
 *
 * 为什么要有这条指令：换机 / 新部署时，本机编辑器这条链要手工摆好几样东西
 * （口令与签名密钥、editor-path.txt、两个 vbs、启动器 mjs、白名单、计划任务），顺序错了或漏一样，
 * 现象是"双击没反应"或"只有主人打不开"，排查成本远高于重做一遍。这里把它们按固定顺序做一遍，
 * 每步都留下 ✅/⏭/❌。
 *
 * **只做"没人会自动做"的那五步**：数据目录由编辑器写文件时 / 启动器复制表格时按需建，
 * 本地表格副本由启动器在"本机还没有表"时用 `resources/空模板.xlsx` 起一份——那两件事不需要指令代劳。
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
 * 文件划分：本文件 = 编排（路径口径 + 按序跑五步 + 遇错即停 + 报告 + 指令入口）；
 * 步骤实现按体量分在 `secrets.js`（第 1 步）/ `launcher.js`（第 2 步）/
 * `steps.js`（第 3、5 步）/ `scheduled-task.js`（第 4 步）；跨步骤的小工具在 `common.js`。
 */
import { spawnSync } from "node:child_process"
import nodeFs from "node:fs"
import path from "node:path"

import { pluginRoot as defaultPluginRoot } from "../config.js"
import { DEFAULT_PORT, FAIL, STEP_TITLES, TASK_NAME } from "./common.js"
import { stepHealth, stepWhitelist } from "./steps.js"
import { stepSecrets } from "./secrets.js"
import { stepLauncherArtifacts } from "./launcher.js"
import { stepScheduledTask } from "./scheduled-task.js"

/** 非主人一律回这一句（回归断言引用它，别在测试里手抄字符串） */
export const INIT_DENIED = "只有机器人的主人才能用 #排队初始化"

export { TASK_NAME }

/** 组装这次要用的所有路径（唯一的口径来源） */
function initPaths(pluginRoot) {
  /** 数据目录**固定在插件里**：`<插件根>/data`（硬约定）——没有"挪到别处"的口子 */
  const data = path.join(pluginRoot, "data")
  return {
    pluginRoot,
    dataDir: data,
    configPath: path.join(pluginRoot, "config", "config.yaml"),
    editorPath: path.join(pluginRoot, "editor", "editor.mjs"),
    localXlsx: path.join(data, "排队表-本地.xlsx"),
    pathFile: path.join(data, "editor-path.txt"),
    launcherMjs: path.join(data, "editor-launch.mjs"),
    launcherVbs: path.join(data, "editor-launch.vbs"),
    startVbs: path.join(data, "启动排队表编辑器.vbs"),
    adminsFile: path.join(data, "abyss-editor-admins.json"),
    taskXmlTmp: path.join(data, "abyss-editor-task.tmp.xml"),
  }
}

/**
 * 默认的 schtasks 执行器：拿原始字节自己解码
 *
 * **不能直接 `toString()`**：中文 Windows 上 schtasks 的报错走 ANSI 代码页（GBK/936），
 * 按 utf8 硬读会得到 `����: ϵͳ�Ҳ���ָ�����ļ���` 这种乱码，报给主人等于没说。
 * 实测（本机，`schtasks /query /tn <不存在的名> /fo LIST`）：退出码 1、stdout 空、
 * stderr 31 字节 `b4 ed ce f3 3a 20 cf b5 …`（无 BOM，GBK 的「错误: 系统找不到指定的文件。」）；
 * 查**存在**的任务时 stdout 同样是 GBK（`/fo LIST` 的字段名、`/xml` 里 `<Description>` 的中文都是，
 * 只有标签是 ASCII）—— 所以中文路径的 `<Arguments>` 也只有解对了才比得上。
 * 判定口径（`scheduled-task.js`）不依赖这些文案，但**展示给主人**的那句必须解对。
 *
 * 顺序：BOM / UTF-16 头 → 严格 UTF-8（GBK 的报错字节不是合法 UTF-8，会解失败）→ GBK(936) → 宽松 UTF-8 兜底。
 * 导出是给回归套件用的：`test/init.test.mjs` 拿上面那串真机字节钉住解码口径。
 */
const utf8Strict = new TextDecoder("utf-8", { fatal: true })
/** 少数 Node 构建没带 full-icu，`gbk` 会构造不出来 —— 那就只能退回旧行为（宽松 UTF-8） */
const gbk = (() => {
  try {
    return new TextDecoder("gbk")
  } catch {
    return null
  }
})()

export function decodeConsoleOutput(buf) {
  if (!buf || !buf.length) return ""
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le", 2)
  if (b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2))
    swapped.swap16()
    return swapped.toString("utf16le")
  }
  /** 没有 BOM 也要认：头部隔一个字节一个 0x00 就是 UTF-16LE */
  let nuls = 0
  const head = Math.min(b.length, 64)
  for (let i = 1; i < head; i += 2) if (b[i] === 0) nuls++
  if (nuls > head / 4) return b.toString("utf16le")

  try {
    return utf8Strict.decode(b)
  } catch {
    /* 不是合法 UTF-8：中文 Windows 上就是 GBK，换 936 再解一次 */
  }
  if (gbk) {
    try {
      return gbk.decode(b)
    } catch {
      /* ICU 里没有 GBK：只能退回宽松 UTF-8（乱码总比抛错好） */
    }
  }
  return b.toString("utf8")
}

function defaultExec(command, args) {
  const r = spawnSync(command, args, { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
  const stderr = decodeConsoleOutput(r.stderr)
  return {
    status: r.status ?? (r.error ? 1 : 0),
    stdout: decodeConsoleOutput(r.stdout),
    stderr: stderr || (r.error ? String(r.error.message ?? r.error) : ""),
  }
}

/**
 * 按顺序跑完五步，遇错即停
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

  const runners = [stepSecrets, stepLauncherArtifacts, stepWhitelist, stepScheduledTask, stepHealth]
  /** 少一个都会让"五步"名不副实：显式校验，别让缺实现变成静默少跑一步 */
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
  const lines = ["【排队初始化】把本机编辑器那套手工初始化走一遍（主人专用 · 遇错即停）", ""]
  for (const s of result.steps) lines.push(`${s.no}. ${mark[s.status] ?? "·"} ${s.title}：${s.detail}`)

  if (result.ok) {
    lines.push("", "全部步骤完成。")
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
 * 主人判定用框架注入的 `e.isMaster`（`lib/plugins/loader.js:425` 按 cfg.master 打的标），
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
