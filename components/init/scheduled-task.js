/**
 * 第 4 步：计划任务 —— 没有才注册；已存在则校验动作指向同一份 vbs
 *
 * **「在不在」只认退出码，不认报错文案**：schtasks 的报错随系统语言与代码页变
 * （本机实测：查不存在的任务 → 退出码 1、stderr 是 GBK 的「错误: 系统找不到指定的文件。」），
 * 拿文案当判据在别的语言 / 别的编码上必废 —— 具体口径见 `stepScheduledTask` 里那段注释。
 */
import path from "node:path"
import { FAIL, OK, SKIP, TASK_NAME, oneLine, samePath } from "./common.js"

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

/**
 * 全量枚举里有没有**根目录**下的这个任务
 *
 * `schtasks /query /fo CSV /nh` 每行形如 `"\AbyssQueueEditor","N/A","就绪"`：第一列是任务路径，
 * **不随系统语言变**（表头已经用 `/nh` 去掉了，状态列本地化也不看）。子目录里的同名任务
 * （`\Foo\AbyssQueueEditor`）不算 —— 我们建的就是根目录那一份。
 */
const listedAtRoot = (csv, name) => {
  const want = name.toLowerCase()
  for (const line of String(csv ?? "").split(/\r?\n/)) {
    const cell = /^\s*"((?:[^"]|"")*)"/.exec(line)?.[1]
    if (cell === undefined) continue
    const taskPath = cell.replace(/""/g, '"').trim().toLowerCase()
    if (taskPath === `\\${want}` || taskPath === want) return true
  }
  return false
}

/**
 * "任务不存在"的已知文案 —— **只做最后的兜底**，主判据是退出码
 *
 * 只有"枚举探针也跑不起来"时才回头认它。字节已经由 `index.js` 的 `decodeConsoleOutput`
 * 按 GBK/936 解好，所以中文原文与英文报错都能匹配（这就是"英文回退"）。
 */
const NOT_FOUND_TEXT = /找不到|cannot find|does not exist/i

/** 4) 计划任务：没有才注册；已存在则校验动作指向同一份 vbs */
export function stepScheduledTask(ctx) {
  const { launcherVbs, taskXmlTmp } = ctx.paths
  const expectArgs = `"${launcherVbs}"`
  const query = ctx.exec("schtasks", ["/query", "/tn", TASK_NAME, "/xml"])

  if (query.status === 0) {
    const found = queryAction(query.stdout)
    if (!found.args)
      return FAIL(`计划任务 ${TASK_NAME} 查得到但解析不出动作（XML 里没有 <Arguments>）：插件不自动改写，请主人决定`)
    if (path.basename(found.command).toLowerCase() !== "wscript.exe")
      return FAIL(`计划任务 ${TASK_NAME} 的动作不是 wscript.exe（是 ${found.command || "（空）"}）：插件不自动改写，请主人决定`)
    if (!samePath(found.args.replace(/^"|"$/g, ""), launcherVbs))
      return FAIL(`计划任务 ${TASK_NAME} 的动作指向 ${found.args}，而数据目录里那份是 ${expectArgs}：插件不自动改写，请主人决定`)
    return SKIP(`已存在且动作一致：wscript.exe ${found.args}`)
  }

  /**
   * 查不到 ≠ 不存在：**退出码非零既可能是"任务不存在"，也可能是 schtasks 本身跑不起来**
   * （权限不足、服务不可用），而 schtasks 的退出码只有 0/1，单看第一个查询分不出来。
   * 所以再跑一次**不依赖任何文案**的能力探针：枚举本机根目录的全部任务（退出码 0 = schtasks 可用）。
   *   探针成功 + 列表里没有它  ⇒ 真的不存在 → 去建
   *   探针成功 + 列表里有它    ⇒ /query 却查不到，状态可疑 → ❌（硬建会用 /f 覆盖掉一个我们没看清的任务）
   *   探针失败                ⇒ schtasks 本身可疑：除非报错文案明说"找不到"（最后兜底），否则 ❌
   */
  const probe = ctx.exec("schtasks", ["/query", "/fo", "CSV", "/nh"])
  const probeOut = oneLine(probe.stderr) || oneLine(probe.stdout) || "（无输出）"
  if (probe.status === 0) {
    if (listedAtRoot(probe.stdout, TASK_NAME))
      return FAIL(
        `计划任务 ${TASK_NAME} 在全量枚举里查得到，按名查询却失败（退出码 ${query.status}）：状态可疑，` +
          `不敢当成"不存在"去创建：${oneLine(query.stderr) || "（无输出）"}`,
      )
  } else if (!NOT_FOUND_TEXT.test(`${query.stderr ?? ""}\n${query.stdout ?? ""}`)) {
    return FAIL(
      `查询计划任务 ${TASK_NAME} 失败，不敢当成"不存在"去创建：` +
        `按名查询退出码 ${query.status}（${oneLine(query.stderr) || "（无输出）"}）；` +
        `枚举本机任务也不成功，退出码 ${probe.status}（${probeOut}）`,
    )
  }

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
  if (create.status !== 0)
    return FAIL(`注册计划任务 ${TASK_NAME} 失败：${oneLine(create.stderr) || oneLine(create.stdout) || `退出码 ${create.status}`}`)

  /** 注册完再查一次：确认建出来的确实是我们要的动作（XML 没被 schtasks 改样） */
  const after = queryAction(ctx.exec("schtasks", ["/query", "/tn", TASK_NAME, "/xml"]).stdout)
  if (!samePath(after.args.replace(/^"|"$/g, ""), launcherVbs))
    return FAIL(`注册后复核失败：任务动作是 ${after.args || "（空）"}，期望 ${expectArgs}`)
  return OK(`已注册：wscript.exe ${expectArgs}（无触发器，由 启动排队表编辑器.vbs 按需触发）`)
}
