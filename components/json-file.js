/** JSON 文件的读写（机器人侧与编辑器侧同一份实现） */
import fs from "node:fs"
import path from "node:path"

export const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export const writeJson = (file, data) => {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
    }
    throw err
  }
}
