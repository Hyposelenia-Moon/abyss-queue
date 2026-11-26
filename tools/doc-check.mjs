#!/usr/bin/env node
/**
 * 文档一致性自检：改完文档跑一次，别让口径飘回旧版本。
 *
 * 只查能客观判定的四件事（主观措辞不归它管）：
 *  1. 反引号里写的文件路径必须真实存在（`data/` 下的运行期文件、`.dsh/` 这类上游文件放行）；
 *  2. 反引号里写的 `#命令` 必须在 `apps/*.js` 或 `resources/queue/help-cfg.js` 里出现过
 *     （框架命令、被别的插件抢走的裸榜名在放行名单里，见 ALLOW_COMMANDS）；
 *  3. 套件总数与两侧拆分必须一致（63 = 29 + 34）；
 *  4. 已下线的名字不许再出现——除非整行是在说「没有这一层」（历史沿革与 CHANGELOG 不在扫描范围）。
 *
 * 用法：node tools/doc-check.mjs        # 有问题时退出码 1
 * 它不进 `pnpm test`：文档改动才需要跑。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** 参与检查的文档：不含历史沿革（历史行只追加、允许旧名字）。 */
const docsOf = () => {
  const out = ["README.md", "AGENTS.md", "editor/README.md", "editor/DEPLOY.md", "test/README.md", "docs/旧编号对照.md"]
  for (const name of fs.readdirSync(path.join(root, "docs"))) {
    if (!name.endsWith(".md") || name.startsWith("历史沿革") || name === "旧编号对照.md") continue
    out.push(`docs/${name}`)
  }
  return out.map(rel => ({ rel, text: fs.readFileSync(path.join(root, rel), "utf8") }))
}

/** 框架命令 + 被别的插件抢走的裸榜名（文档里只作「被抢」说明用）。 */
const ALLOW_COMMANDS = new Set([
  "#更新",
  "#强制更新",
  "#全部更新",
  "#帮助",
  "#幽境危战",
  "#幻想真境剧诗",
  "#深境螺旋",
  "#深渊",
  "#危战",
  "#剧诗",
])

const escapes = /\.(?:m?js|html|json|ya?ml|md|xlsx|css)$/
const dirs = ["", "docs", "editor", "editor/http", "editor/test", "test", "components", "model", "modules", "apps", "tools", "guoba", "resources", "resources/queue", "defSet"]
/** 仓库外的路径与整行命令：`data/`、`config/`、`plugins/` 是运行期或框架目录，`node …` 是命令不是路径。 */
const freePrefix = ["data/", "config/", "plugins/", ".dsh/", "~/", "<"]
const commandLine = /^(?:node|pnpm|npm|npx|git|curl)\s/

const exists = target =>
  freePrefix.some(p => target.startsWith(p)) || dirs.some(dir => fs.existsSync(path.join(root, dir, target)))

const knownCommands = (() => {
  const text = []
  for (const dir of ["apps", "resources/queue"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (!name.endsWith(".js")) continue
      text.push(fs.readFileSync(path.join(root, dir, name), "utf8"))
    }
  }
  return text.join("\n")
})()

const SUITES = { total: 63, plugin: 29, editor: 34 }
const DEAD = ["#更新排队", "#排队强制更新", "#排队初始化", "components/init", "init.test.mjs", "abyss-editor-claims", "x-abyss-device", "#v="]
const DEAD_SUITES = [
  "test/aliases.test.mjs",
  "test/check-write.test.mjs",
  "test/check-done.test.mjs",
  "test/inserter.test.mjs",
  "test/leave-row.test.mjs",
  "test/locate-self.test.mjs",
  "test/progress.test.mjs",
  "test/cycle-clear.test.mjs",
  "test/anchor-counts.test.mjs",
  "test/doc-import.test.mjs",
  "test/live-dedupe.test.mjs",
  "test/open-reminder.test.mjs",
  "editor/test/anchor-add.test.mjs",
  "editor/test/delete-compact.test.mjs",
  "editor/test/empty-nick.test.mjs",
  "editor/test/move-row.test.mjs",
  "editor/test/status-rename.test.mjs",
  "editor/test/tidy.test.mjs",
  "editor/test/write-queue.test.mjs",
]
/** 整行在说明「没有这一层」时不算问题。 */
const negation = /(没有|不再|不种|不存|不写|删掉|删了|下线|废弃|已移除|不认)/

const problems = []
const add = (rel, line, kind, detail) => problems.push({ rel, line, kind, detail })

for (const { rel, text } of docsOf()) {
  const lines = text.split("\n")
  lines.forEach((raw, i) => {
    const line = i + 1
    for (const m of raw.matchAll(/`([^`\n]+)`/g)) {
      const token = m[1].trim()
      if (escapes.test(token) && token.includes("/") && !token.includes("*") && !token.includes("<") && !token.includes("{") && !commandLine.test(token)) {
        const clean = token.replace(/^\.\//, "").replace(/[:：].*$/, "").replace(/[),，。]+$/, "")
        if (!exists(clean)) add(rel, line, "路径不存在", clean)
      }
    }
    for (const m of raw.matchAll(/`(#[\u4e00-\u9fa5]{2,})`/g)) {
      const cmd = m[1]
      // 已下线的命令由下面的 DEAD 检查单独报（那一处会按「整行在说没有这一层」放行），这里别重复报。
      if (DEAD.includes(cmd)) continue
      if (ALLOW_COMMANDS.has(cmd) || knownCommands.includes(cmd)) continue
      add(rel, line, "命令没注册", cmd)
    }
    for (const dead of DEAD) {
      if (!raw.includes(dead)) continue
      // 整行在说「这一层没了 / 删掉了」就放行（历史沿革与 CHANGELOG 本来不扫）。
      if (negation.test(raw)) continue
      add(rel, line, "已下线名字", dead)
    }
    for (const dead of DEAD_SUITES) {
      if (raw.includes(dead)) add(rel, line, "旧套件名", dead)
    }
    for (const m of raw.matchAll(/(\d{2})\s*套/g)) {
      const n = Number(m[1])
      if (n === SUITES.total || n === SUITES.plugin || n === SUITES.editor || n >= 70) continue
      add(rel, line, "套件数可疑", `${n} 套`)
    }
  })
}

if (problems.length === 0) {
  console.log(`✅ 文档一致性：路径、命令、套件数（${SUITES.total} = ${SUITES.plugin} + ${SUITES.editor}）、下线名字都对得上`)
  process.exit(0)
}

const grouped = new Map()
for (const p of problems) {
  const key = `${p.kind}｜${p.detail}`
  if (!grouped.has(key)) grouped.set(key, [])
  grouped.get(key).push(`${p.rel}:${p.line}`)
}
console.log(`❌ 文档一致性：${problems.length} 处问题`)
for (const [key, where] of [...grouped.entries()].sort()) {
  console.log(`  ${key}  <-  ${where.slice(0, 5).join(", ")}${where.length > 5 ? ` …(+${where.length - 5})` : ""}`)
}
process.exit(1)