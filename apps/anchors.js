/**
 * `#主播` —— 主播列表与单个主播详情
 *
 * 三种用法：
 *   `#主播`            三个榜的主播合并成一张表（同一主播只出现一次）
 *   `#主播 <榜>`       只列该榜的主播
 *   `#主播 <名字>`     文本输出这位主播的详情（专职、各榜强项、直播入口）
 *
 * 榜名优先：参数能解析成榜就当榜名用，否则按主播名找。
 */
import { config } from "../components/config.js"
import { PLUGIN_DSC, PLUGIN_NAME } from "../components/constants.js"
import { renderAnchorsImg } from "../components/render-html.js"
import { canonicalAnchor, compileAliases } from "../lib/aliases.js"
import { anchorDetailView, renderAnchorDetail } from "../lib/render.js"
import { resolveSheet, sheetChoices } from "../lib/router.js"
import { AppBase } from "../components/base.js"

/** 主播别名（配置里登记的其它写法） */
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
        if (sheet) return renderAnchorsImg(this, this.e, [models.get(sheet)])

        const detail = anchorDetailView([...models.values()], canonicalAnchor(arg, aliases()))
        if (!detail) return this.reply(`没找到「${arg}」这个榜或主播。榜：${sheetChoices(models).join("、")}`, true)
        return this.reply(renderAnchorDetail(detail), true)
      }

      return renderAnchorsImg(this, this.e, sheetChoices(models).map(n => models.get(n)))
    })
  }
}
