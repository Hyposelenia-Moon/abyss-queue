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
 * 因此这里在启动时逐条自检，缺失就通过日志与主人私聊提示，避免静默踩坑。
 *
 * 每条 patch 的 `check()` 必须**无副作用且不抛错**：读不到文件即视为缺失。
 */
import fs from "node:fs"
import path from "node:path"

/** 框架 `#更新` 的插件文件（相对 bot 根目录） */
const UPDATE_PLUGIN = "plugins/other/update.js"

/** 截图后端：puppeteer 与 shotium 都可能生效，高清出图两边都要认 data.sys.scale */
const PUPPETEER = "renderers/puppeteer/lib/puppeteer.js"
const SHOTIUM = "renderers/shotium/lib/shotium.js"

/** GitHub 上的仓库地址（提示用） */
export const REPO_URL = "https://github.com/Hyposelenia-Moon/abyss-queue"

const readIfExists = file => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** 补丁清单：id + 说明 + 自检方式 */
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
 * 运行自检
 * @param root bot 根目录（默认取 cwd，与框架的插件路径口径一致）
 * @returns {{ok: string[], missing: object[]}}
 */
export function checkPatches(root = process.cwd()) {
  const ok = []
  const missing = []
  for (const p of PATCHES) {
    let passed = false
    try {
      passed = p.check(root) !== false
    } catch {
      passed = false
    }
    if (passed) ok.push(p.id)
    else missing.push(p)
  }
  return { ok, missing }
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
