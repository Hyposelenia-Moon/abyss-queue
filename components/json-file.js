/**
 * JSON 文件的读写（机器人侧与编辑器侧同一份实现）
 *
 * 这两个函数原来在 `editor/util.js` 与 `model/queue-state.js` 各写了一遍，逐字相同；
 * 现在只有这一份，两边 import 之后再 re-export，调用方不用改。
 *
 * **写一定要临时文件 + 原子替换**：直接 `writeFileSync` 时，进程若在写中间崩掉（或磁盘满），
 * 留下的就是一个撕成两半的 JSON，而读的一侧一律当"没有"——白名单 / 群名单 / 进度 /
 * 链接记录会一起丢（2026-10-09 终审的观察 1）。临时文件与目标**同目录**（同盘才 rename 得动）。
 *
 * 读不出来一律当 `null`（首次运行 / 损坏 / 写了一半），怎么兜由调用方决定。
 */
import fs from "node:fs"
import path from "node:path"

/** 读一个 JSON 文件；读不出来一律当 null */
export const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/**
 * 写一个 JSON 文件（自动建父目录；缩进 2 与既有产物一致）
 *
 * 失败时清掉中间产物、错误照旧抛给调用方——要不要吞由调用方决定
 * （`model/queue-state.js` 吞掉记一条 error，编辑器侧直接抛）。
 */
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
      /* 清不掉就算了 */
    }
    throw err
  }
}