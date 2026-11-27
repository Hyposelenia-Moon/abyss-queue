/** 字体：**随源码分发**，不下载 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { pluginRoot } from "./config.js"

export const fontDir = path.join(pluginRoot, "resources", "common", "font")

export const FONTS = {
  title: "HYWH-65W.woff",
  body: "HYWH-65W.woff",
  number: "tttgbnumber.woff",
  /** 装饰标题字：印品南征北战NZBZ体，只给页头这类大字用，正文不碰（字形带倾斜感） */
  display: "NZBZ.woff",
}

export const fontFile = name => path.join(fontDir, name)

const hasFont = name => {
  try {
    return fs.statSync(fontFile(name)).isFile()
  } catch {
    return false
  }
}

export const fontUrl = (key = "body") => {
  const name = FONTS[key]
  return name && hasFont(name) ? pathToFileURL(fontFile(name)).href : ""
}

export const fontUrls = async () => ({
  fontTitle: fontUrl("title"),
  fontBody: fontUrl("body"),
  fontNumber: fontUrl("number"),
  fontDisplay: fontUrl("display"),
})
