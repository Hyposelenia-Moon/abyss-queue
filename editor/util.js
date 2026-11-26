/** 编辑器的小工具：JSON 读写 + 本地日期 */
import { readJson, writeJson } from "../components/json-file.js"

export { readJson, writeJson }

export const pad2 = n => String(n).padStart(2, "0")

export const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
