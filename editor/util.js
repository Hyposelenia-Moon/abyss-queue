/**
 * 编辑器的小工具：JSON 读写 + 本地日期
 *
 * 只有被**两个以上模块**用到的东西才放这里；单模块自用的工具留在那个模块里。
 */
import fs from "node:fs"
import path from "node:path"

/** 读一个 JSON 文件；读不出来一律当 null（调用方决定怎么兜） */
export const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** 写一个 JSON 文件（自动建父目录；缩进 2 与既有产物一致） */
export const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
}

/** 两位数补零 */
export const pad2 = n => String(n).padStart(2, "0")

/** 本地日期戳（归档文件名用） */
export const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
