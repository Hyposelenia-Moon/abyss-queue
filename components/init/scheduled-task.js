/**
 * 第 3 步：计划任务 —— 没有才注册；已存在则校验动作指向同一份 vbs
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

/** 3) 计划任务：没有才注册；已存在则校验动作指向同一份 vbs */
export function stepScheduledTask(ctx) {
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
  if (create.status !== 0)
    return FAIL(`注册计划任务 ${TASK_NAME} 失败：${oneLine(create.stderr) || oneLine(create.stdout) || `退出码 ${create.status}`}`)

  /** 注册完再查一次：确认建出来的确实是我们要的动作（XML 没被 schtasks 改样） */
  const after = queryAction(ctx.exec("schtasks", ["/query", "/tn", TASK_NAME, "/xml"]).stdout)
  if (!samePath(after.args.replace(/^"|"$/g, ""), launcherVbs))
    return FAIL(`注册后复核失败：任务动作是 ${after.args || "（空）"}，期望 ${expectArgs}`)
  return OK(`已注册：wscript.exe ${expectArgs}（无触发器，由 启动排队表编辑器.vbs 按需触发）`)
}
