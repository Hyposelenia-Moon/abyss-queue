/**
 * 第 4 步：启动器产物
 *
 * editor-path.txt（UTF-16LE/5 行/CRLF）+ editor-launch.mjs + 两个 vbs。
 * 不存在才生成；已存在则**校验**：路径 / 密钥要与当前配置一致，vbs 必须还是纯 ASCII + CRLF
 * （cscript 按 ANSI 读，被编辑器存成 UTF-8 就整个废掉）。不一致就 ❌ 让主人决定。
 */
import path from "node:path"
import { FAIL, OK, SKIP, TASK_NAME, mask, rel, samePath } from "./common.js"

export function stepLauncherArtifacts(ctx) {
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
      return FAIL(
        `${rel(ctx, p.pathFile)} 不是 UTF-16LE（没有 BOM）：启动器按 utf16le 读，读出来会是乱码。请主人决定怎么处理，插件不自动覆盖`,
      )
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
      return FAIL(
        `${rel(ctx, p.pathFile)} 与当前配置不一致，插件不自动覆盖：\n    ${diff.join("\n    ")}\n  （云端行：文件里是 ${cl || "（空）"}，配置里是 ${cloud || "（空）"}——只报告，不拦）`,
      )
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
    const missing = ["import.meta.url", "editor-path.txt", "editor-url.txt", "--owner-only", "api/snapshot"].filter(
      m => !text.includes(m),
    )
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
      if ([...buf].some(b => b > 0x7f))
        return FAIL(`${rel(ctx, file)} 不是纯 ASCII（cscript 按 ANSI 读，中文会变乱码）：插件不自动覆盖，请主人决定`)
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
