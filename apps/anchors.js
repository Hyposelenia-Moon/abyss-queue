/** `#主播` —— 主播列表与单个主播详情 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { versionFooter } from "../components/pluginVersion.js"
import { renderAnchorsImg } from "../components/render-html.js"
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { anchorDetailView, renderAnchorDetail } from "../components/render.js"
import { resolveSheet, sheetChoices } from "../modules/router.js"
import { liveLookup } from "../modules/anchor-live.js"
import { AppBase } from "../components/base.js"

const aliases = () => compileAliases(config.anchor_aliases)

export class AbyssAnchorList extends AppBase {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: PLUGIN_DSC,
      event: "message",
      priority: 4000,
      rule: [{ reg: "^#主播(\\s+\\S+)?$", fnc: "anchors" }],
    })
  }
  async anchors() {
    return this.safe(async () => {
      const arg = /^#主播(?:\s+(\S+))?$/.exec(this.e.msg.trim())?.[1]
      const models = await this.models()
      if (arg) {
        const sheet = resolveSheet(arg, models)
        if (sheet)
          return renderAnchorsImg(this, this.e, [models.get(sheet)], {
            version: versionFooter(PLUGIN_NAME),
            liveLookup,
          })
        const detail = anchorDetailView([...models.values()], canonicalAnchor(arg, aliases()), { liveLookup })
        if (!detail) return this.reply(`没找到「${arg}」这个榜或主播。榜：${sheetChoices(models).join("、")}`, true)
        return this.reply(renderAnchorDetail(detail), true)
      }
      return renderAnchorsImg(this, this.e, sheetChoices(models).map(n => models.get(n)), {
        version: versionFooter(PLUGIN_NAME),
        liveLookup,
      })
    })
  }
}
