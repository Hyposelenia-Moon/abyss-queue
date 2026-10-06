/**
 * 字体：**随源码分发**，不下载
 *
 * 位置与 Axiu-Plugin / Atlas-Plugin 一致：`resources/common/font/`（同款 `HYWH-65W`，
 * 即原神标准字体「汉仪文黑-65W」）。字体入库后，渲染链路直接把它以 `file://` 交给模板的
 * `@font-face`，**不需要任何网络请求、也没有"下载失败回落系统字体"这条分支**。
 *
 * 为什么正文也用 HYWH-65W：miao-plugin 的默认字体栈就是 `Number, "汉仪文黑-65W", YS, ...`，
 * 而 NZBZ（印品南征北战NZBZ体）只是它提供的可选装饰字体（字形带倾斜感），正文用会显得像斜体。
 *
 * 同时提供 `.woff`（约 2.0MB，浏览器用）与 `.ttf`（约 3.0MB，桌面/其它工具用）两份，
 * 与 Axiu-Plugin / Atlas-Plugin 的发放形态保持一致。
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { pluginRoot } from "./config.js"

/** 字体目录（入库；与 Axiu-Plugin / Atlas-Plugin 同位置） */
export const fontDir = path.join(pluginRoot, "resources", "common", "font")

/**
 * 字体清单：模板里的三个名字 → 文件名
 *
 * 正文与标题同用汉仪文黑，保证页面里不会出现斜体字形。
 */
export const FONTS = {
  title: "HYWH-65W.woff",
  body: "HYWH-65W.woff",
  number: "tttgbnumber.woff",
}

/** 字体文件的绝对路径（不检查存在性，调用方要判就读一下） */
export const fontFile = name => path.join(fontDir, name)

/**
 * 文件在不在（**内部实现，不导出**）
 *
 * 对外只经 `fontUrl` 体现：文件在就给 `file://`，不在就给空串（模板 `@font-face` 失效、回落系统字体）。
 * 不导出是 §3.7 的要求——套件只测对外行为与契约，不为内部实现细节留接口。
 */
const hasFont = name => {
  try {
    return fs.statSync(fontFile(name)).isFile()
  } catch {
    return false
  }
}

/** 某个用途的字体 `file://` URL；文件缺失时给空串（模板的 `@font-face` 就整条失效、回落系统字体） */
export const fontUrl = (key = "body") => {
  const name = FONTS[key]
  return name && hasFont(name) ? pathToFileURL(fontFile(name)).href : ""
}

/**
 * 渲染模板要的三个字体 URL（与模板里的 `{{fontTitle}}` / `{{fontBody}}` / `{{fontNumber}}` 对应）
 *
 * 保持 async：它要做文件系统探测，调用方（`components/render-html.js` 的 `themeData`）本就 `await` 它，
 * 渲染链路因此保持"先取字体、再组模板数据"的顺序。
 */
export const fontUrls = async () => ({
  fontTitle: fontUrl("title"),
  fontBody: fontUrl("body"),
  fontNumber: fontUrl("number"),
})
