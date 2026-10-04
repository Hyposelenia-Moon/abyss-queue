/**
 * 部署补丁自检
 *
 * 本插件有一小部分改动必须落在**框架/环境**里（不在本仓库内），例如：
 *   - 框架 `#更新` 认识 `abyss` 这个简称
 *   - 框架强制更新后能正确重启（否则工作区更新了但进程不重启）
 *   - 「关掉任一服务窗口，另一个自动关闭并清理空壳窗口」
 *   - NapCat 控制台只在白名单群打印消息
 *
 * 换一台机器部署时，这些补丁很容易漏，症状是「命令没反应 / 重启后掉线」这类怪现象。
 * 因此这里在启动时逐条自检，缺失就通过日志与主人私聊提示，避免静默失效。
 *
 * 宿主根目录**靠推导，不靠问、也不看 cwd**（审核「宿主目录与网络部署职责」问题 1）：
 * 正常部署布局是 `<Yunzai>/plugins/abyss-queue`，于是宿主根 = 插件根的上两级。
 * `process.cwd()` 由启动方式决定（计划任务 / pm2 / 别的目录都能起），拿它当宿主根
 * 会去校验**另一套安装**的补丁，还把"缺失"误报成部署问题。
 * 推导不出来（独立源码目录、异常布局）时明确报告「不适用于部署」，不猜别的安装。
 *
 * 每条 patch 的 `check()` 必须**无副作用且不抛错**：读不到文件即视为缺失。
 *
 * 放在 `model/` 而不是 `lib/`：它要读宿主文件、还要从插件位置推导宿主根，
 * 属于"外部数据的访问"，不是可跨入口加载的纯逻辑。
 */
import fs from "node:fs"
import path from "node:path"
import { pluginRoot } from "../components/config.js"
import { log } from "../components/logger.js"

/** 框架 `#更新` 的插件文件（相对 bot 根目录） */
const UPDATE_PLUGIN = "plugins/other/update.js"

/** 截图后端：puppeteer 与 shotium 都可能生效，高清出图两边都要认 data.sys.scale */
const PUPPETEER = "renderers/puppeteer/lib/puppeteer.js"
const SHOTIUM = "renderers/shotium/lib/shotium.js"

export const REPO_URL = "https://github.com/Hyposelenia-Moon/abyss-queue"

const readIfExists = file => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

export const PATCHES = [
  {
    id: "update-alias",
    title: "框架 #更新 支持 abyss 简称",
    detail: `在 ${UPDATE_PLUGIN} 的 getPlugin() 里加别名映射：abyss → abyss-queue，并让空格可有可无`,
    check(root) {
      const src = readIfExists(path.join(root, UPDATE_PLUGIN))
      return Boolean(src) && /alias\s*=\s*\{\s*abyss\s*:/.test(src)
    },
  },
  {
    id: "force-restart",
    title: "框架强制更新后能重启",
    detail: `在 ${UPDATE_PLUGIN} 的 runUpdate() 里补「提交号是否变化」判定：reset --hard 后 git pull 报 Already up to date，原逻辑不会重启`,
    check(root) {
      const src = readIfExists(path.join(root, UPDATE_PLUGIN))
      return Boolean(src) && src.includes("commitChanged")
    },
  },
  {
    id: "render-scale",
    title: "渲染后端支持高清出图（data.sys.scale）",
    detail: `让截图后端认 device pixel ratio：${PUPPETEER} 加 page.setViewport({ deviceScaleFactor })、${SHOTIUM} 把 options.scale 改为优先取 data.sys.scale。缺失时出图固定 1 倍（820px 宽），放大发虚`,
    check(root) {
      /** 两个后端都在的机器上，要求两边都打上；只有一个后端时只校验存在的那边 */
      const files = [PUPPETEER, SHOTIUM]
        .map(f => ({ f, src: readIfExists(path.join(root, f)) }))
        .filter(i => i.src)
      if (!files.length) return false
      return files.every(i => /data\.sys\??\.scale/.test(i.src))
    },
  },
]

/**
 * 宿主根目录该有的标识（确认"这确实是一套 Yunzai 安装"，不是随便哪个上层目录）
 *
 * 只认这两样：框架的 `package.json` 与插件目录 `plugins/`。不校验包名——
 * 有人用 fork / 改过 name，卡死包名会把正常部署误判成"不适用"。
 */
const HOST_MARKERS = ["package.json", "plugins"]

/**
 * 从插件根推导宿主根
 *
 * 部署布局 `<宿主>/plugins/<插件目录>` → 宿主根是插件根的**上两级**。
 *
 * @param {string} [pluginDir] 插件根（默认取 components/config.js 的 pluginRoot）
 * @returns {{root: string|null, reason: string}} root=null 表示无法确认宿主（不适用于部署）
 */
export function resolveHostRoot(pluginDir = pluginRoot) {
  const dir = path.resolve(pluginDir)
  const pluginsDir = path.dirname(dir)
  if (path.basename(pluginsDir).toLowerCase() !== "plugins")
    return { root: null, reason: `插件不在 <宿主>/plugins 下（当前：${dir}）` }
  const host = path.dirname(pluginsDir)
  for (const marker of HOST_MARKERS) {
    if (!fs.existsSync(path.join(host, marker))) return { root: null, reason: `宿主根缺少 ${marker}（推断：${host}）` }
  }
  return { root: host, reason: "" }
}

/**
 * 运行自检
 *
 * @param {string} [root] 宿主根；**省略时按插件位置推导**（不看 cwd）。
 *   显式传入时按调用方的判断用（套件就这么造隔离宿主），不做宿主标识校验。
 * @returns {{ok: string[], missing: object[], applicable: boolean, root: string, reason: string}}
 *   applicable=false 表示当前环境不是"插件装在 <宿主>/plugins 下"的部署形态，
 *   补丁自检**不适用于部署**，不要据此报缺失（独立源码目录跑套件时就是这种情况）。
 */
export function checkPatches(root) {
  let host = root
  let reason = ""
  if (!host) {
    const found = resolveHostRoot()
    host = found.root
    reason = found.reason
    if (!host) {
      log("info", `[abyss-queue] 部署补丁自检不适用于当前环境（${reason}），已跳过：补丁只在 <宿主>/plugins 部署形态下有意义`)
      return { ok: [], missing: [], applicable: false, root: "", reason }
    }
  }
  const ok = []
  const missing = []
  for (const p of PATCHES) {
    let passed = false
    try {
      passed = p.check(host) !== false
    } catch {
      passed = false
    }
    if (passed) ok.push(p.id)
    else missing.push(p)
  }
  return { ok, missing, applicable: true, root: host, reason }
}

/** 拼接给主人看的提示（缺失时才有内容） */
export function patchNotice(missing) {
  if (!missing.length) return ""
  return [
    "【三路深渊排队】检测到部署补丁缺失（仅影响更新指令与重启联动，不影响报名/排队）",
    ...missing.map(p => `· ${p.title}：${p.detail}`),
    `补丁清单与做法见插件 README 的「部署须知」，仓库：${REPO_URL}`,
  ].join("\n")
}
