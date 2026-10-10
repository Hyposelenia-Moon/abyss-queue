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

/**
 * 写一个 JSON 文件（自动建父目录；缩进 2 与既有产物一致）
 *
 * **临时文件 + 原子替换**（与 `model/table.js` 的写表同一套）：这几个文件（认领记录 / 白名单 /
 * 完成情况锁 / 群名单）本来是直接 `writeFileSync`——进程若在写中间崩掉（或磁盘满），
 * 留下的就是一个撕成两半的 JSON，读的那一侧一律当"没有"：认领记录没了 = 全体设备退回访客态
 * 重新认领一次（2026-10-09 终审的观察 1）。临时文件与目标**同目录**（同盘才 rename 得动），
 * 失败时清掉中间产物、错误照旧抛给调用方。
 */
export const writeJson = (file, data) => {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
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

/** 两位数补零 */
export const pad2 = n => String(n).padStart(2, "0")

/** 本地日期戳（归档文件名用） */
export const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
