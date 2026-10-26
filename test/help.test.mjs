import { ensureEnv } from "./env.mjs"
/**
 * 帮助页：内容门禁与同源文本回退
 *
 * 参考 Meta-Plugin 的「帮助内容与代码分离」：内容在 `resources/queue/help-cfg.js`，
 * 这里只钉"文案别写歪"：命令以 # 开头、说明不太长、别把配置键写进面向群友的帮助里。
 */
import assert from "node:assert/strict"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("帮助页")
const ENV = await ensureEnv({ prefix: "abyss-help-" })
const { helpCfg, helpList } = await import("../resources/queue/help-cfg.js")
const { renderHelpText } = await import("../components/render-html.js")

console.log(`帮助配置：${helpCfg.title}\n`)

check("标题与分组齐全", () => {
  assert.ok(helpCfg.title, "缺标题")
  assert.ok(Array.isArray(helpList) && helpList.length >= 3, `分组应 ≥3，实际 ${helpList.length}`)
  for (const g of helpList) {
    assert.ok(String(g.group ?? "").trim(), "分组标题为空")
    assert.ok(g.list?.length, `「${g.group}」没有条目`)
    assert.ok(g.list.length <= 8, `「${g.group}」条目过多（${g.list.length}），帮助页会显得拥挤`)
  }
})

check("每条命令都以 # 开头、说明不超过 30 字", () => {
  for (const g of helpList) {
    for (const item of g.list) {
      assert.match(item.title, /^#/, `「${item.title}」不是命令写法`)
      assert.ok(item.desc, `「${item.title}」缺说明`)
      assert.ok([...item.desc].length <= 30, `「${item.title}」说明过长：${item.desc}`)
    }
  }
})

check("面向群友的帮助里不出现配置键 / 文件名", () => {
  const text = JSON.stringify({ helpCfg, helpList })
  assert.ok(!/config\.yaml|defSet|data\/|插件根/.test(text), "帮助里出现了开发者才需要知道的路径/配置键")
})

check("同源文本：分组、命令与说明都在，可作渲染失败的回退", () => {
  const text = renderHelpText(helpCfg, helpList)
  assert.ok(text.includes(helpCfg.title), text)
  for (const g of helpList) {
    assert.ok(text.includes(g.group), text)
    for (const item of g.list) assert.ok(text.includes(item.title) && text.includes(item.desc), text)
  }
})

await ENV.cloud?.close()
await finish()
