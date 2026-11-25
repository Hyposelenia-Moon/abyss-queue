/**
 * 编辑器的小工具：JSON 读写 + 本地日期
 *
 * 只有被**两个以上模块**用到的东西才放这里；单模块自用的工具留在那个模块里。
 * `readJson`/`writeJson` 与机器人侧共用一份实现（`components/json-file.js`），这里只做转发。
 */
import { readJson, writeJson } from "../components/json-file.js"

export { readJson, writeJson }

/** 两位数补零 */
export const pad2 = n => String(n).padStart(2, "0")

/** 本地日期戳（归档文件名用） */
export const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`