/**
 * 渲染自查：把插件的三张模板渲染成图片，检查字体与版式是否正常
 *
 * 需要在**机器人根目录**执行（渲染模板与 art-template 都按调用方的环境解析）：
 *   node plugins/abyss-queue/test/render-check.mjs [输出目录]
 *
 * 产物为 PNG，默认写到系统临时目录的 abyss-render-check/。
 * 字体走 data/fonts 缓存（首次会自动从云端拉取），因此这条检查也顺便验证字体链路。
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const require = createRequire(path.join(process.cwd(), "package.json"))
const template = require("art-template")

const pluginRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const outDir = process.argv[2] ?? path.join(process.env.TEMP ?? "/tmp", "abyss-render-check")
fs.mkdirSync(outDir, { recursive: true })

const toUrl = p => pathToFileURL(p).href

// 字体：直接用缓存（找不到就退回系统字体，仍是有效渲染）
const fontDir = path.join(pluginRoot, "data", "fonts")
const font = name => {
  const p = path.join(fontDir, name)
  return fs.existsSync(p) ? toUrl(p) : ""
}

const theme = {
  /** 正文与标题同用汉仪文黑（原神标准字体），保证不出现斜体字形 */
  fontTitle: font("HYWH-65W.woff"),
  fontBody: font("HYWH-65W.woff"),
  fontNumber: font("tttgbnumber.woff"),
}

const cases = [
  {
    tpl: "queue/queue",
    data: {
      ...theme,
      name: "幽境危战",
      title: "2026年10月7.1幽境危战排队",
      total: 26,
      limit: 20,
      moreTotal: true,
      waitHint: "还有较多成员排队，请耐心等待",
      rows: [
        { seq: "1", nickname: "小伙01", status: "排队中", mine: false },
        { seq: "2", nickname: "拾起那梦与忆", status: "阿修Axiu", mine: false },
        { seq: "3", nickname: "测试昵称很长的用户", status: "本人已完成", mine: true },
      ],
      own: { seq: "3", row: 13, nickname: "测试昵称很长的用户", gameName: "玄不救非", anchor: "阿修Axiu", goal: "无畏(N5)", strength: "低配", status: "排队中", note: "打不过就试试 N4" },
    },
  },
  {
    tpl: "queue/anchors",
    data: {
      ...theme,
      total: 3,
      names: ["幻想真境剧诗", "幽境危战", "深境螺旋"],
      anchors: [
        { name: "阿修Axiu", recommend: "强烈推荐", duty: "幻想真境剧诗 / 幽境危战 / 深境螺旋", skills: "承接全类型账号，痛苦号专职；丝柯克专精（不会火神）", entry: "B站" },
        { name: "漠天秋", recommend: "提分推荐", duty: "幽境危战", skills: "玛拉妮、火神双重专精；擅长月草；阵容适应面广", entry: "B站 / 抖音（付费）" },
        { name: "听雨", recommend: "可选", duty: "幻想真境剧诗 / 深境螺旋", skills: "多角色精通（不含火神），操作手法娴熟，按需求开播", entry: "B站" },
      ],
    },
  },
  {
    tpl: "queue/menu",
    data: {
      ...theme,
      /* 混合状态按人数显示；整榜同一状态（如「等待开启」）显示该状态 */
      sheets: [
        { name: "幻想真境剧诗", count: 10, status: "" },
        { name: "幽境危战", count: 16, status: "" },
        { name: "深境螺旋", count: 6, status: "等待开启" },
      ],
      version: "Created By Yz-Bot & 三路深渊排队 1.0.0",
    },
  },
  {
    tpl: "queue/mine",
    data: {
      ...theme,
      qq: "1733491779",
      total: 2,
      active: [
        {
          sheet: "幽境危战",
          seq: "17",
          row: 27,
          nickname: "测试昵称很长的用户",
          gameName: "玄不救非",
          anchor: "阿修Axiu",
          anchorEntry: "B站 1960956034",
          goal: "无畏(N5)",
          strength: "低配",
          status: "排队中",
          note: "打不过就试试 N4",
        },
        {
          sheet: "幻想真境剧诗",
          seq: "11",
          row: 18,
          nickname: "测试昵称很长的用户",
          gameName: "玄不救非",
          anchor: "七笙",
          anchorEntry: "",
          goal: "12层满星",
          strength: "中配",
          status: "本人已完成",
          note: "",
        },
      ],
      invalid: [{ sheet: "深境螺旋", row: 14 }],
    },
  },
]

const browsers = [
  process.env.ABYSS_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
].filter(Boolean)

const browser = browsers.find(p => fs.existsSync(p))
if (!browser) {
  console.log(`⏭ 跳过：没找到可用的浏览器（可用 ABYSS_TEST_BROWSER 指定）`)
  process.exit(0)
}

let failed = 0
for (const c of cases) {
  const html = template.render(fs.readFileSync(path.join(pluginRoot, "resources", `${c.tpl}.html`), "utf8"), c.data)
  const name = c.tpl.replace(/\//g, "_")
  const htmlPath = path.join(outDir, `${name}.html`)
  const pngPath = path.join(outDir, `${name}.png`)
  fs.writeFileSync(htmlPath, html, "utf8")

  const leftover = html.match(/\{\{[^}]+\}\}/g)
  const hasFont = theme.fontTitle ? html.includes("HYWH-65W.woff") : true
  try {
    execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--screenshot=${pngPath}`, "--window-size=880,1200", pathToFileURL(htmlPath).href], { timeout: 60000, stdio: "ignore" })
  } catch (err) {
    failed++
    console.log(`❌ ${c.tpl} 截图失败：${err?.message ?? err}`)
    continue
  }
  const size = fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0
  const ok = size > 5000 && !leftover
  if (!ok) failed++
  console.log(`${ok ? "✅" : "❌"} ${c.tpl.padEnd(14)} html=${(html.length / 1024).toFixed(1)}KB 字体=${theme.fontTitle ? (hasFont ? "已代入" : "未代入") : "系统字体"} 残留变量=${leftover ? leftover.slice(0, 2).join(",") : "无"} png=${(size / 1024).toFixed(1)}KB`)
}

console.log(`\n产物目录：${outDir}`)
console.log(failed ? `❌ ${failed}/${cases.length} 张渲染异常` : `✅ ${cases.length} 张渲染正常`)
process.exit(failed ? 1 : 0)
