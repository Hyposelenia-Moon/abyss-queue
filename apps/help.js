/**
 * `#排队帮助` / `#排队菜单` / `#深渊帮助` —— 帮助页
 *
 * 内容与代码分离：`resources/queue/help-cfg.js` 每次动态 import（带时间戳绕过 ESM 缓存），
 * 改文案不用重启机器人；渲染失败回落同源文本（与 Meta-Plugin 的帮助页同一条口径）。
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderHelpImg } from "../components/render-html.js"
import { log } from "../components/logger.js"
import { AppBase } from "../components/base.js"

const HELP_FILE = path.join(import.meta.dirname, "..", "resources", "queue", "help-cfg.js")

/** 读帮助配置；文件坏了也返回一份能看的兜底，不让命令静默 */
async function loadHelp() {
  try {
    const mod = await import(`${pathToFileURL(HELP_FILE).href}?t=${Date.now()}`)
    const groups = (mod.helpList ?? [])
      .map(g => ({
        group: String(g?.group ?? "").trim(),
        list: (g?.list ?? [])
          .map(item => ({ title: String(item?.title ?? "").trim(), desc: String(item?.desc ?? "").trim() }))
          .filter(item => item.title),
      }))
      .filter(g => g.group && g.list.length)
    return { cfg: mod.helpCfg ?? {}, groups }
  } catch (err) {
    log("error", `[abyss-queue] 读取帮助配置失败：${err?.message ?? err}`)
    return { cfg: { title: "三路深渊排队 · 帮助" }, groups: [] }
  }
}

export class AbyssHelp extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [{ reg: "^#(?:排队|深渊)(?:帮助|菜单|说明)$", fnc: "help" }],
    })
  }

  async help() {
    return this.safe(async () => {
      const { cfg, groups } = await loadHelp()
      return renderHelpImg(this, this.e, { cfg, groups, version: versionFooter(PLUGIN_NAME) })
    })
  }
}
