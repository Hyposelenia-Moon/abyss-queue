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
 */
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import nodeFs from "node:fs"
import path from "node:path"

/** 计划任务名（`启动排队表编辑器.vbs` 里是同一个常量，两处必须一致） */
export const TASK_NAME = "AbyssQueueEditor"

/** 非主人一律回这一句（回归断言引用它，别在测试里手抄字符串） */
export const INIT_DENIED = "只有机器人的主人才能用 #排队初始化"

/** 本地表格副本名（与 editor-launch.mjs 的默认值一致：数据目录里的 排队表-本地.xlsx） */
export const LOCAL_XLSX_NAME = "排队表-本地.xlsx"

/** 编辑器默认端口（与 editor-launch.mjs / editor.mjs 的默认值一致） */
export const DEFAULT_PORT = 7788

/** 探活的超时：几秒即可，编辑器不在就直接跳过这一步 */
const PROBE_TIMEOUT_MS = 5000

/** 七步的标题（顺序即执行顺序；"未做"列表也按它报） */
const STEP_TITLES = [
  "数据目录",
  "本地表格副本",
  "访问口令 / 签名密钥",
  "启动器产物",
  "编辑器白名单",
  "计划任务",
  "编辑器探活",
]

/* ------------------------------------------------------------ 小工具 */

const OK = detail => ({ status: "done", detail })
const SKIP = detail => ({ status: "skip", detail })
const FAIL = detail => ({ status: "fail", detail })

/** 报告里的路径：在插件根里就写相对路径（不把主人的盘符路径发到群里） */
const rel = (ctx, p) => {
  const r = path.relative(ctx.pluginRoot, p)
  return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : p
}

/**
 * Windows 路径比较（大小写不敏感、忽略结尾斜杠）
 *
 * 这套东西本来就是 Windows 专用的（vbs / schtasks），所以按 Windows 的规矩比。
 */
const samePath = (a, b) =>
  path.resolve(String(a ?? "")).replace(/[\\/]+$/, "").toLowerCase() ===
  path.resolve(String(b ?? "")).replace(/[\\/]+$/, "").toLowerCase()

/** 密钥只报前几位（报告可能发在群里，不能把口令整条打出去） */
const mask = v => (v ? `${String(v).slice(0, 4)}…（${String(v).length} 位）` : "（空）")

const oneLine = s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200)

/** 随机 hex（口令 16 字节 / 签名密钥 24 字节，与工具的既有口径一致） */
const randomHex = n => randomBytes(n).toString("hex")

/** 逗号分隔的步骤号列表（报告里"未做：3、4、5"） */
const list = arr => arr.join("、")

/* ------------------------------------------------------------ config.yaml */

/**
 * remote 段的行范围
 *
 * 只在 `remote:` 这一层里动键：配置文件里别处也可能有 `token` 之类的键，
 * 全局正则替换会连带改错（tools/deploy-windows.ps1 的老写法就是这么干的）。
 */
function remoteBlockRange(lines) {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const top = /^([A-Za-z0-9_.-]+):/.exec(lines[i].replace(/\r$/, ""))
    if (!top) continue
    if (top[1] === "remote") {
      start = i
      continue
    }
    if (start >= 0) return { start, end: i }
  }
  return start >= 0 ? { start, end: lines.length } : null
}

/** 读 remote 段的三个键（口令 / 签名密钥 / 云端地址） */
export function readRemoteKeys(text) {
  const lines = String(text ?? "").split("\n")
  const range = remoteBlockRange(lines)
  if (!range) return null
  const out = { token: "", sign_key: "", url: "" }
  for (let i = range.start + 1; i < range.end && i < lines.length; i++) {
    const m = /^\s+([A-Za-z0-9_]+):(\s*)(.*)$/.exec(lines[i].replace(/\r$/, ""))
    if (!m) continue
    const key = m[1]
    if (!(key in out)) continue
    out[key] = /^"(.*)"\s*$/.exec(m[3])?.[1] ?? m[3].trim()
  }
  return out
}

/**
 * 改（或补）remote 段里的 token / sign_key，**其余部分一个字节都不动**
 *
 * 为什么不用 YAML.stringify 整份重写：那会丢掉全部注释、重排键序。主人的配置里写满了
 * "为什么这么填"的注释，重写一遍等于毁掉它。
 * 逐行处理，并保留每行自己的行尾（按 `\n` 切分，CRLF 行尾的 `\r` 留在行里）。
 * @returns {string|null} 新文本；没有 remote 段时返回 null
 */
export function patchRemoteSecrets(text, { token, signKey }) {
  const lines = String(text ?? "").split("\n")
  const range = remoteBlockRange(lines)
  if (!range) return null

  const scan = key => {
    for (let i = range.start + 1; i < range.end && i < lines.length; i++) {
      const raw = lines[i]
      const m = /^(\s+)([A-Za-z0-9_]+):(\s*)(.*)$/.exec(raw.replace(/\r$/, ""))
      if (m && m[2] === key) return { i, indent: m[1], eol: raw.endsWith("\r") ? "\r" : "" }
    }
    return null
  }
  const tokenAt = scan("token")
  const signAt = scan("sign_key")
  const eol = lines[range.start]?.endsWith("\r") ? "\r" : ""

  /** 先改既有行（改内容不影响下标），再补缺行（插入会挪下标，所以要累计偏移） */
  if (tokenAt) lines[tokenAt.i] = `${tokenAt.indent}token: "${token}"${tokenAt.eol}`
  if (signAt) lines[signAt.i] = `${signAt.indent}sign_key: "${signKey}"${signAt.eol}`

  const values = { token, sign_key: signKey }
  const inserts = []
  let offset = 0
  for (const key of ["token", "sign_key"]) {
    if (key === "token" ? tokenAt : signAt) continue
    const anchor = key === "sign_key" ? tokenAt : null
    const indent = anchor?.indent ?? signAt?.indent ?? "  "
    inserts.push({
      at: (anchor ? anchor.i + 1 : range.start + 1) + offset,
      line: `${indent}${key}: "${values[key]}"${anchor?.eol ?? eol}`,
    })
    offset += 1
  }
  for (const ins of inserts) lines.splice(ins.at, 0, ins.line)
  return lines.join("\n")
}

/* ------------------------------------------------------------ 七步 */

/** 1) 数据目录（固定在插件里：`<插件根>/data`） */
function stepDataDir(ctx) {
  if (ctx.fs.existsSync(ctx.paths.dataDir)) return SKIP(`已存在：${rel(ctx, ctx.paths.dataDir)}`)
  ctx.fs.mkdirSync(ctx.paths.dataDir, { recursive: true })
  return OK(`已创建：${rel(ctx, ctx.paths.dataDir)}`)
}

/** 2) 本地表格副本：**存在就绝不覆盖**（本机那份可能已经有数据） */
function stepLocalXlsx(ctx) {
  const { localXlsx, templateXlsx } = ctx.paths
  if (ctx.fs.existsSync(localXlsx)) return SKIP(`已存在（不覆盖）：${rel(ctx, localXlsx)}`)
  if (!ctx.fs.existsSync(templateXlsx)) return FAIL(`找不到空模板：${rel(ctx, templateXlsx)}（插件里的 resources/空模板.xlsx 是不是没同步过去？）`)
  ctx.fs.copyFileSync(templateXlsx, localXlsx)
  return OK(`已从空模板复制：${rel(ctx, localXlsx)}`)
}

/** 3) 口令 / 签名密钥：为空才生成，且**只改这两行** */
function stepSecrets(ctx) {
  const { configPath } = ctx.paths
  if (!ctx.fs.existsSync(configPath)) return FAIL(`找不到配置文件：${rel(ctx, configPath)}（先启动一次机器人，它会从 config.yaml.example 生成一份）`)
  const text = ctx.fs.readFileSync(configPath, "utf8")
  const cur = readRemoteKeys(text)
  if (!cur) return FAIL(`config.yaml 里没有 remote: 段（口令与签名密钥写在它下面）：${rel(ctx, configPath)}`)

  const token = cur.token || randomHex(16)
  const signKey = cur.sign_key || randomHex(24)
  /** 云端地址行：本机地址（127.0.0.1/localhost）不写进去 —— 让启动器"从自己拉快照"没有意义 */
  const cloud = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(cur.url) ? "" : cur.url
  ctx.secrets = { token, signKey, cloud }

  const made = []
  if (!cur.token) made.push("remote.token（16 字节随机）")
  if (!cur.sign_key) made.push("remote.sign_key（24 字节随机）")
  if (!made.length) return SKIP(`已有 remote.token ${mask(token)} 与 remote.sign_key ${mask(signKey)}，未改动`)

  const next = patchRemoteSecrets(text, { token, signKey })
  if (next === null) return FAIL(`改不了 remote 段（没有它）：${rel(ctx, configPath)}`)
  ctx.fs.writeFileSync(configPath, next, "utf8")
  return OK(`已生成并只改这两行：${made.join("、")}；其余注释与内容原样保留`)
}

/**
 * 4) 启动器产物：editor-path.txt（UTF-16LE/5 行/CRLF）+ editor-launch.mjs + 两个 vbs
 *
 * 不存在才生成；已存在则**校验**：路径 / 密钥要与当前配置一致，vbs 必须还是纯 ASCII + CRLF
 * （cscript 按 ANSI 读，被编辑器存成 UTF-8 就整个废掉）。不一致就 ❌ 让主人决定。
 */
function stepLauncherArtifacts(ctx) {
  const p = ctx.paths
  const { token, signKey, cloud } = ctx.secrets
  const made = []
  const kept = []

  if (!ctx.fs.existsSync(p.editorPath)) return FAIL(`插件里没有编辑器：${rel(ctx, p.editorPath)}（启动器要指向它）`)

  /** 4.1 editor-path.txt */
  if (!ctx.fs.existsSync(p.pathFile)) {
    const text = [p.editorPath, p.localXlsx, token, cloud, signKey].join("\r\n") + "\r\n"
    const bom = Buffer.from([0xff, 0xfe])
    ctx.fs.writeFileSync(p.pathFile, Buffer.concat([bom, Buffer.from(text, "utf16le")]))
    made.push(rel(ctx, p.pathFile))
  } else {
    const buf = ctx.fs.readFileSync(p.pathFile)
    if (!(buf[0] === 0xff && buf[1] === 0xfe))
      return FAIL(`${rel(ctx, p.pathFile)} 不是 UTF-16LE（没有 BOM）：启动器按 utf16le 读，读出来会是乱码。请主人决定怎么处理，插件不自动覆盖`)
    const fields = buf
      .toString("utf16le", 2)
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
    while (fields.length && fields.at(-1) === "") fields.pop()
    if (fields.length !== 5)
      return FAIL(`${rel(ctx, p.pathFile)} 不是 5 行（编辑器 / 本地副本 / 口令 / 云端 / 签名密钥），实际 ${fields.length} 行`)
    const [editor, xlsx, tk, cl, sk] = fields
    const diff = []
    if (!samePath(editor, p.editorPath)) diff.push(`编辑器：文件里是 ${editor}，当前应是 ${p.editorPath}`)
    if (!samePath(xlsx, p.localXlsx)) diff.push(`本地副本：文件里是 ${xlsx}，当前应是 ${p.localXlsx}`)
    if (tk !== token) diff.push(`口令：文件里是 ${mask(tk)}，config.yaml 里是 ${mask(token)}`)
    if (sk !== signKey) diff.push(`签名密钥：文件里是 ${mask(sk)}，config.yaml 里是 ${mask(signKey)}`)
    if (diff.length)
      return FAIL(`${rel(ctx, p.pathFile)} 与当前配置不一致，插件不自动覆盖：\n    ${diff.join("\n    ")}\n  （云端行：文件里是 ${cl || "（空）"}，配置里是 ${cloud || "（空）"}——只报告，不拦）`)
    kept.push(`${rel(ctx, p.pathFile)}（路径与密钥一致）`)
  }

  /** 4.2 editor-launch.mjs（自定位：DATA_DIR 取 import.meta.url） */
  const asset = name => path.join(ctx.assetsDir, name)
  if (!ctx.fs.existsSync(p.launcherMjs)) {
    if (!ctx.fs.existsSync(asset("editor-launch.mjs"))) return FAIL(`找不到启动器模板：resources/init/editor-launch.mjs`)
    const text = ctx.fs.readFileSync(asset("editor-launch.mjs"), "utf8").replace(/\r\n/g, "\n")
    ctx.fs.writeFileSync(p.launcherMjs, text, "utf8")
    made.push(rel(ctx, p.launcherMjs))
  } else {
    const text = ctx.fs.readFileSync(p.launcherMjs, "utf8")
    const missing = ["import.meta.url", "editor-path.txt", "editor-url.txt", "--owner-only", "api/snapshot"].filter(m => !text.includes(m))
    if (missing.length)
      return FAIL(`${rel(ctx, p.launcherMjs)} 不像本机编辑器那份启动器（缺少 ${missing.join("、")}）：插件不自动覆盖，请主人决定`)
    kept.push(`${rel(ctx, p.launcherMjs)}（自定位 + 主人专用）`)
  }

  /** 4.3 两个 vbs：纯 ASCII + CRLF，自定位调旁边的启动器 / 触发计划任务 */
  for (const [file, need] of [
    [p.launcherVbs, "editor-launch.mjs"],
    [p.startVbs, TASK_NAME],
  ]) {
    const name = path.basename(file)
    if (ctx.fs.existsSync(file)) {
      const buf = ctx.fs.readFileSync(file)
      if ([...buf].some(b => b > 0x7f)) return FAIL(`${rel(ctx, file)} 不是纯 ASCII（cscript 按 ANSI 读，中文会变乱码）：插件不自动覆盖，请主人决定`)
      const text = buf.toString("utf8")
      if (!/^([^\n]*\r\n)*[^\n]*$/.test(text)) return FAIL(`${rel(ctx, file)} 行尾不是纯 CRLF：插件不自动覆盖，请主人决定`)
      if (!text.includes(need)) return FAIL(`${rel(ctx, file)} 里没有 ${need}：插件不自动覆盖，请主人决定`)
      kept.push(`${name}（ASCII + CRLF）`)
      continue
    }
    const tpl = asset(name)
    if (!ctx.fs.existsSync(tpl)) return FAIL(`找不到模板：resources/init/${name}`)
    /** 一律按 CRLF 写出去：模板在 git 里可能被行尾规范化过，而 cscript 要 CRLF */
    const text = ctx.fs.readFileSync(tpl, "utf8").replace(/\r\n|\r|\n/g, "\r\n")
    ctx.fs.writeFileSync(file, text, "utf8")
    made.push(`${name}`)
  }

  const parts = []
  if (made.length) parts.push(`已生成：${made.join("、")}`)
  if (kept.length) parts.push(`已存在并校验通过：${kept.join("、")}`)
  return made.length ? OK(parts.join("；")) : SKIP(parts.join("；") || "产物都在")
}

/**
 * 5) 白名单：没有 owner 才写（发送者 QQ 当 owner + admins）
 *
 * 权限只认 QQ（AGENTS.md 九-1）：写昵称等于写一个可以随时改掉的"身份"。
 */
function stepWhitelist(ctx) {
  const { adminsFile } = ctx.paths
  const qq = String(ctx.qq ?? "").trim()
  if (!qq) return FAIL("拿不到发送者的 QQ，无法写白名单")

  if (ctx.fs.existsSync(adminsFile)) {
    const raw = ctx.fs.readFileSync(adminsFile, "utf8")
    let cur = null
    try {
      cur = JSON.parse(raw.replace(/^\uFEFF/, ""))
    } catch (err) {
      /** 不是合法 JSON 时**不敢覆盖**：可能是主人手改坏了，覆盖掉就再也找不回来 */
      return FAIL(`${rel(ctx, adminsFile)} 不是合法 JSON，插件不敢覆盖（${oneLine(err?.message)}）：请主人先修好或删掉它`)
    }
    const owners = (Array.isArray(cur?.owner) ? cur.owner : []).map(s => String(s).trim()).filter(Boolean)
    if (owners.length) return SKIP(`已有 owner：${owners.join("、")}，未改动（增删管理员请手工编辑 ${path.basename(adminsFile)}，或走编辑器的 /api/admins）`)
    /** 有 admins 没 owner：补 owner，并把发送者并进 admins（**不丢**已有的管理员） */
    const admins = [...new Set([...(Array.isArray(cur?.admins) ? cur.admins : []), qq])]
    ctx.fs.writeFileSync(adminsFile, JSON.stringify({ ...cur, owner: [qq], admins }, null, 2) + "\n", "utf8")
    return OK(`没有 owner，已补上：owner = ${qq}（admins 保留原有条目并加入发送者）`)
  }

  ctx.fs.writeFileSync(adminsFile, JSON.stringify({ owner: [qq], admins: [qq] }, null, 2) + "\n", "utf8")
  return OK(`已写入：owner / admins = ${qq}`)
}

/**
 * 计划任务 XML
 *
 * 照抄本机那份的形态：**没有触发器**（只由 `启动排队表编辑器.vbs` 里 `schtasks /run` 按需触发），
 * `InteractiveToken`（在主人的交互会话里跑，编辑器才有桌面/用户环境），
 * `MultipleInstancesPolicy=IgnoreNew`（连着点两次不会起两个编辑器）。
 */
function taskXml({ vbsPath, wscript }) {
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>本机排队表编辑器（abyss-queue）：由 启动排队表编辑器.vbs 按需触发，无触发器</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers />
  <Actions Context="Author">
    <Exec>
      <Command>${esc(wscript)}</Command>
      <Arguments>"${esc(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

/** 从 `schtasks /query /xml` 的输出里取动作（program + arguments） */
const queryAction = stdout => {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(String(stdout ?? ""))?.[1]?.trim() ?? ""
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(String(stdout ?? ""))?.[1]?.trim() ?? ""
  return { command, args }
}

/** 6) 计划任务：没有才注册；已存在则校验动作指向同一份 vbs */
function stepScheduledTask(ctx) {
  const { launcherVbs, taskXmlTmp } = ctx.paths
  const expectArgs = `"${launcherVbs}"`
  const query = ctx.exec("schtasks", ["/query", "/tn", TASK_NAME, "/xml"])
  const found = queryAction(query.stdout)

  if (query.status === 0 && found.args) {
    if (path.basename(found.command).toLowerCase() !== "wscript.exe")
      return FAIL(`计划任务 ${TASK_NAME} 的动作不是 wscript.exe（是 ${found.command || "（空）"}）：插件不自动改写，请主人决定`)
    if (!samePath(found.args.replace(/^"|"$/g, ""), launcherVbs))
      return FAIL(`计划任务 ${TASK_NAME} 的动作指向 ${found.args}，而数据目录里那份是 ${expectArgs}：插件不自动改写，请主人决定`)
    return SKIP(`已存在且动作一致：wscript.exe ${found.args}`)
  }

  /**
   * 查不到 ≠ 不存在：只有"任务不存在"才敢去建。
   * 其它错误（权限、服务不可用）一律 ❌ —— 硬建会用 /f 覆盖掉一个我们没看清的任务。
   */
  const blob = `${query.stderr ?? ""}\n${query.stdout ?? ""}`
  if (query.status !== 0 && !/找不到|cannot find|does not exist|系统找不到/i.test(blob))
    return FAIL(`查询计划任务 ${TASK_NAME} 失败，不敢当成"不存在"去创建：${oneLine(blob) || `退出码 ${query.status}`}`)

  const xml = taskXml({ vbsPath: launcherVbs, wscript: ctx.wscript })
  ctx.fs.writeFileSync(taskXmlTmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]))
  let create
  try {
    create = ctx.exec("schtasks", ["/create", "/tn", TASK_NAME, "/xml", taskXmlTmp, "/f"])
  } finally {
    try {
      ctx.fs.rmSync(taskXmlTmp, { force: true })
    } catch {
      /* 删不掉就留着，不影响结果（下次 /f 覆盖） */
    }
  }
  if (create.status !== 0) return FAIL(`注册计划任务 ${TASK_NAME} 失败：${oneLine(create.stderr) || oneLine(create.stdout) || `退出码 ${create.status}`}`)

  /** 注册完再查一次：确认建出来的确实是我们要的动作（XML 没被 schtasks 改样） */
  const after = queryAction(ctx.exec("schtasks", ["/query", "/tn", TASK_NAME, "/xml"]).stdout)
  if (!samePath(after.args.replace(/^"|"$/g, ""), launcherVbs))
    return FAIL(`注册后复核失败：任务动作是 ${after.args || "（空）"}，期望 ${expectArgs}`)
  return OK(`已注册：wscript.exe ${expectArgs}（无触发器，由 启动排队表编辑器.vbs 按需触发）`)
}

/** 7) 探活：没跑也只报告（不重启机器人、不 kill 进程——那些是主人的决定） */
async function stepHealth(ctx) {
  const { token } = ctx.secrets
  const url = `http://127.0.0.1:${ctx.port}/healthz?k=${encodeURIComponent(token)}`
  let res
  try {
    res = await ctx.fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    return SKIP(`编辑器没在跑（${oneLine(err?.message) || "连不上"}）：下一步要么重启机器人（remote.autostart 会把它拉起来），要么双击 data/${path.basename(ctx.paths.startVbs)}`)
  }
  if (!res?.ok) return SKIP(`编辑器有应答但 /healthz 返回 HTTP ${res?.status}：先看一眼它的日志 data/editor.log`)
  let h = {}
  try {
    h = await res.json()
  } catch (err) {
    return SKIP(`/healthz 的响应不是 JSON（${oneLine(err?.message)}）：可能端口上是别的东西`)
  }
  return OK(`编辑器在跑：版本 ${h.version ?? "?"} · mount ${h.mount || "（根目录）"} · 群名单 ${h.roster ?? "?"} 人`)
}

/* ------------------------------------------------------------ 主流程 */

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

/** 组装这次要用的所有路径（唯一的口径来源） */
function initPaths(pluginRoot) {
  /** 数据目录**固定在插件里**：`<插件根>/data`（硬约定 11）——没有"挪到别处"的口子 */
  const data = path.join(pluginRoot, "data")
  return {
    pluginRoot,
    dataDir: data,
    configPath: path.join(pluginRoot, "config", "config.yaml"),
    templateXlsx: path.join(pluginRoot, "resources", "空模板.xlsx"),
    editorPath: path.join(pluginRoot, "editor", "editor.mjs"),
    localXlsx: path.join(data, LOCAL_XLSX_NAME),
    pathFile: path.join(data, "editor-path.txt"),
    launcherMjs: path.join(data, "editor-launch.mjs"),
    launcherVbs: path.join(data, "editor-launch.vbs"),
    startVbs: path.join(data, "启动排队表编辑器.vbs"),
    adminsFile: path.join(data, "abyss-editor-admins.json"),
    taskXmlTmp: path.join(data, "abyss-editor-task.tmp.xml"),
  }
}

/**
 * 按顺序跑完七步，遇错即停
 *
 * @param {object} opts
 * @param {string} opts.qq 发送者 QQ（白名单只认 QQ）
 * @param {string} [opts.pluginRoot] 插件根（默认按本文件位置向上一级推导：components/ → 插件根）
 * @param {object} [opts.fs] 文件系统（默认 node:fs；注入桩即可全程不碰真实磁盘）
 * @param {(cmd:string,args:string[])=>{status:number,stdout:string,stderr:string}} [opts.exec] 计划任务用
 * @param {Function} [opts.fetch] 探活用（默认全局 fetch）
 * @param {string} [opts.wscript] 任务动作里的 wscript 路径
 * @param {number} [opts.port] 编辑器端口（默认 7788，与启动器一致）
 * @returns {Promise<{ok:boolean,failedAt:number|null,steps:Array<{no:number,title:string,status:string,detail:string}>}>}
 */
export async function runInit(opts = {}) {
  const pluginRoot = opts.pluginRoot || path.resolve(import.meta.dirname, "..")
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
    `已完成：${done.length ? list(done) : "（无）"}`,
    `未做：${todo.length ? list(todo) : "（无）"}`,
    "修掉上面的原因再发一次 #排队初始化；已经做好的产物不会被覆盖。",
  )
  return lines.join("\n")
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
