/** 机器人侧的白名单读取（这个 QQ 是不是主人 / 管理员） */
import fs from "node:fs"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"
import { aclQq } from "../components/qq.js"

export { aclQq }

export const adminsFilePath = () => config.adminsPath

const qqsOf = list => {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const qq = aclQq(raw)
    if (qq && !out.includes(qq)) out.push(qq)
  }
  return out
}

export const readWhitelist = (file = adminsFilePath()) => {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    if (err?.code !== "ENOENT")
      log("warn", `[abyss-queue] 读白名单失败（${file}）——本次按"没有管理员"处理：${err?.message ?? err}`)
    return { owners: [], admins: [] }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { owners: [], admins: [] }
  return { owners: qqsOf(raw.owner), admins: qqsOf(raw.admins) }
}

export const managerQqs = (file = adminsFilePath()) => {
  const { owners, admins } = readWhitelist(file)
  return [...new Set([...owners, ...admins])]
}

export const isManagerQq = (qq, file = adminsFilePath()) => {
  const id = aclQq(qq)
  return Boolean(id) && managerQqs(file).includes(id)
}
