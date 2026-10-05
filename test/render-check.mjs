/**
 * 渲染自查：把插件的四张模板渲染成图片，检查字体与版式是否正常
 *
 * 需要在**机器人根目录**执行（渲染模板与 art-template 都按调用方的环境解析）：
 *   node plugins/abyss-queue/test/render-check.mjs [输出目录]
 *
 * 产物为 PNG，默认写到系统临时目录的 abyss-render-check/。
 * 字体随源码入库（`resources/common/font/`），因此这条检查同时验证"字体确实被代入模板"。
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

// 字体：随源码入库（resources/common/font）；缺了就退回系统字体，仍是有效渲染
const fontDir = path.join(pluginRoot, "resources", "common", "font")
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
        { seq: "2", nickname: "With Glory I Shall Fall", status: "阿修Axiu,听雨", mine: false },
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
        {
          name: "阿修Axiu",
          recommend: "强烈推荐",
          /* 专职：一行一个榜（最多三行） */
          duty: ["幻想真境剧诗", "幽境危战", "深境螺旋"],
          /* 核心强项：只取幽境危战那一行 */
          skills: "丝柯克专精；兹白、木偶、胡桃熟练（不会火神）",
          /* 入口带链接：测试长链接不会被从中间劈开 */
          entry: ["B站https://live.bilibili.com/1960956034"],
        },
        {
          name: "纸笑",
          recommend: "提分推荐",
          duty: ["幽境危战"],
          skills: "火神多种主流配队；月草、蒸芙、恰斯卡等；讨厌兹白（高配除外）",
          /* 真实表里的写法：G/H 两列各是一个入口 → 两项各占一行 */
          entry: ["群语音通话（屏幕共享）", "腾讯会议370-976-3227"],
        },
        {
          name: "七笙",
          recommend: "可选",
          duty: ["幻想真境剧诗", "深境螺旋"],
          skills: "融仆专精；丝柯克、火神高熟练；多角色精通",
          /* 一格内用斜杠并列 → 一项、同一行（斜杠是普通字符，不拆项） */
          entry: ["B站/抖音"],
        },
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
      /* 本人的排队信息与榜单表合在同一张图里，常用指令在它下面 */
      mine: [
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
  /**
   * 窗口宽度取模板里 body 的宽度：机器人出图是**截 body 容器**（shotium 的
   * `shotContainer`），所以按容器宽度截才和真实出图一致；用整屏宽会把右侧留白也拍进去。
   * 模板改了 body 宽度就跟着改这里（或临时用 RENDER_CHECK_WIDTH 覆盖）。
   */
  const bodyWidth = Number(process.env.RENDER_CHECK_WIDTH) || Number(html.match(/body\s*\{[^}]*?width:\s*(\d+)px/s)?.[1]) || 760
  try {
    execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--screenshot=${pngPath}`, `--window-size=${bodyWidth},1200`, pathToFileURL(htmlPath).href], { timeout: 60000, stdio: "ignore" })
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
