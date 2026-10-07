/**
 * 机器人侧的白名单读取（这个 QQ 是不是主人 / 管理员）
 *
 * **权威那一份是编辑器的白名单文件**：`<插件根>/data/abyss-editor-admins.json`，
 * 两个数组 `owner` 与 `admins`，只认 QQ（`#排队初始化` 第 2 步写的就是它）。
 * 机器人侧要按它决定 `#排队` 的投递方式——主人 / 白名单管理员 ⇒ 链接**私聊发**，普通群友照旧群内发
 * （见 `apps/queue.js` 与 `modules/manager-link.js`）。
 *
 * 为什么直接读编辑器那份文件、不另立一份：同一个人"有没有管理权"只能有一个口径，
 * 两份名单必然漂移，而漂移的那一天表现是"某人的链接被丢进群里"。
 *
 * 判定与 `editor/acl.js` 的 `parseAcl` **同一套**：只认 5–12 位数字 QQ（从群里复制的 `@12345` 也认），
 * 群昵称这类解析不出 QQ 的条目一律**不算权限**（AQ-01）。之所以不 import 编辑器那份：
 * 编辑器可以单独部署（按插件根加载共享模块），机器人侧不该把 `editor/` 拖进依赖；重复的只有一条正则。
 *
 * **读不出来就是空名单**（文件不存在 = 从没跑过 `#排队初始化`；内容坏了 = 记一条 warn）：
 * 表现是"照旧群内发链接"，与没有这份文件时的行为一致，不会因为一个坏文件把机器人打挂。
 * 反过来（读不出来就当成"谁都是管理员"）会让所有人的 `#排队` 都变成私聊——那不是安全侧。
 */
import fs from "node:fs"
import { config } from "../components/config.js"
import { log } from "../components/logger.js"

/** 白名单文件的落点（`<插件根>/data` 下的常量，见 components/config.js） */
export const adminsFilePath = () => config.adminsPath

/** QQ 的形态：5–12 位数字（与 `editor/acl.js` 的 `ACL_QQ` 同一个口径） */
const ACL_QQ = /^\d{5,12}$/

/** 把一条配置归一成 QQ；不是 QQ 就返回空串（`@12345` 这种从群里复制的写法也认） */
export const aclQq = raw => {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const bare = s.replace(/^@+/, "").trim()
  return ACL_QQ.test(bare) ? bare : ""
}

const qqsOf = list => {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const qq = aclQq(raw)
    if (qq && !out.includes(qq)) out.push(qq)
  }
  return out
}

/**
 * 读白名单：`{ owners, admins }`（都是去重后的 QQ 字符串数组）
 * @param {string} [file] 白名单文件（默认取配置里的落点；套件可指到临时目录）
 */
export const readWhitelist = (file = adminsFilePath()) => {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    /** 文件不存在是**正常状态**（没跑过初始化）；坏了要留痕，否则"配了却没生效"没人看得出来 */
    if (err?.code !== "ENOENT")
      log("warn", `[abyss-queue] 读白名单失败（${file}）——本次按"没有管理员"处理：${err?.message ?? err}`)
    return { owners: [], admins: [] }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { owners: [], admins: [] }
  return { owners: qqsOf(raw.owner), admins: qqsOf(raw.admins) }
}

/** 主人 + 白名单管理员（去重）。一条 tick 就是按它决定要不要给谁重发私聊链接 */
export const managerQqs = (file = adminsFilePath()) => {
  const { owners, admins } = readWhitelist(file)
  return [...new Set([...owners, ...admins])]
}

/**
 * 这个 QQ 是不是主人或白名单管理员（`#排队` 走私聊的判据）
 *
 * 空串 / 非数字 QQ 一律 false：拿不到稳定身份时宁可照旧群内发，
 * **不能**把"认不出人"当成"是自己人"（那会把链接发给随便谁）。
 */
export const isManagerQq = (qq, file = adminsFilePath()) => {
  const id = aclQq(qq)
  return Boolean(id) && managerQqs(file).includes(id)
}
