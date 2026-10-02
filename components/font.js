/**
 * 字体拉取与缓存
 *
 * 字体（原神标准字体：汉仪文黑-65W，即 HYWH-65W）不入库，改为首次渲染时从云端拉取，
 * 缓存到 `data/fonts/`（该目录已被 .gitignore 忽略），之后离线可用。
 *
 * 为什么正文也用 HYWH-65W：miao-plugin 的默认字体栈就是
 * `Number, "汉仪文黑-65W", YS, ...`，而 NZBZ（印品南征北战NZBZ体）只是它提供的
 * 可选装饰字体（字形带倾斜感）。正文用 NZBZ 会显得像斜体，故不再使用。
 *
 * 设计要点：
 *   - 多个镜像按顺序尝试，任一成功即用；全部失败不抛错（模板回落到系统字体）
 *   - 每个文件只下载一次；并发请求同一文件时共享同一次下载（避免重复拉取）
 *   - 下载有超时，失败会把不完整的临时文件删掉
 */
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { config, pluginRoot } from "./config.js"

/** 字体清单：本地文件名 + 云端相对路径。正文与标题同用汉仪文黑，保证没有斜体字形 */
export const FONTS = {
  title: { file: "HYWH-65W.woff", remote: "resources/common/font/HYWH-65W.woff" },
  body: { file: "HYWH-65W.woff", remote: "resources/common/font/HYWH-65W.woff" },
  number: { file: "tttgbnumber.woff", remote: "resources/common/font/tttgbnumber.woff" },
}

export const fontCacheDir = path.join(pluginRoot, "data", "fonts")

const DOWNLOAD_TIMEOUT = 30000

const inflight = new Map()

const exists = async file => {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() && stat.size > 1024
  } catch {
    return false
  }
}

function mirrors() {
  const list = Array.isArray(config.font_mirrors) ? config.font_mirrors.filter(Boolean) : []
  return list.length
    ? list
    : [
        "https://cdn.jsdelivr.net/gh/AxiuCN/miao-plugin@dev",
        "https://fastly.jsdelivr.net/gh/AxiuCN/miao-plugin@dev",
        "https://gcore.jsdelivr.net/gh/AxiuCN/miao-plugin@dev",
        "https://raw.githubusercontent.com/AxiuCN/miao-plugin/dev",
      ]
}

/**
 * 取某个字体的本地文件路径；必要时从云端下载
 * @returns {Promise<string|null>} 命中缓存的绝对路径；全部失败返回 null
 */
export async function ensureFont(key, { log: logFn } = {}) {
  const spec = FONTS[key]
  if (!spec) return null

  const target = path.join(fontCacheDir, spec.file)
  if (await exists(target)) return target
  if (config.font_download === false) return null

  if (inflight.has(spec.file)) return inflight.get(spec.file)

  const task = (async () => {
    await fs.mkdir(fontCacheDir, { recursive: true })
    for (const base of mirrors()) {
      const url = `${base.replace(/\/$/, "")}/${spec.remote}`
      const tmp = `${target}.part`
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length < 1024) throw new Error(`内容过小（${buf.length} 字节）`)
        await fs.writeFile(tmp, buf)
        await fs.rename(tmp, target)
        logFn?.("mark", `[abyss-queue] 已缓存字体 ${spec.file}（${Math.round(buf.length / 1024)}KB，来源 ${new URL(url).host}）`)
        return target
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        logFn?.("warn", `[abyss-queue] 字体下载失败（${new URL(url).host}）：${err?.message ?? err}`)
      }
    }
    logFn?.("warn", `[abyss-queue] 字体 ${spec.file} 全部镜像均失败，本次渲染回落系统字体`)
    return null
  })()

  inflight.set(spec.file, task)
  try {
    return await task
  } finally {
    inflight.delete(spec.file)
  }
}

/** 批量取字体，返回 { fontTitle, fontBody, fontNumber } 的 file:// URL（拿不到的为 undefined） */
export async function fontUrls({ log: logFn } = {}) {
  const [title, body, number] = await Promise.all([
    ensureFont("title", { log: logFn }),
    ensureFont("body", { log: logFn }),
    ensureFont("number", { log: logFn }),
  ])
  const toUrl = p => (p ? pathToFileURL(p).href : "")
  return { fontTitle: toUrl(title), fontBody: toUrl(body), fontNumber: toUrl(number) }
}
