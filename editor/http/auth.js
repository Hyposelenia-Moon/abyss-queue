/**
 * 鉴权：口令、身份签名、主人与白名单
 *
 * 口令（`?k=`）决定「能不能用这个服务」，身份签名（`?u=` `?s=`）决定「你是谁」，
 * 管理口令（`?a=`）是维护白名单的备用入口。三者的判定口径都收在这里。
 *
 * 取值全由 `editor.mjs` 注入（`loadAdmins` / `loadOwners` 是热读的，白名单改了立刻生效）。
 */
import { timingSafeEqual } from "node:crypto"
import { paramOf, tokenOf } from "./respond.js"

/**
 * 恒时比较两个凭证串
 *
 * 为什么不用 `===`：`===` 在第一个不同的字符处就返回，比较耗时与"猜对了几位前缀"相关，
 * 理论上给爆破留了一条旁路。口令是 16 字节随机数的十六进制（32 个字符），这条旁路实际很难用
 * （网络抖动远大于时序差），但**代价只是一次 `timingSafeEqual`**，而且改完就不必再逐个判断
 * "哪个比较是敏感的"——`model/identity.js` 的签名校验本来就是恒时比较，这里补齐同一个口径。
 *
 * 长度不同直接返回 false：`timingSafeEqual` 要求两个等长 buffer；而"长度不同"本身不泄露内容
 * （口令长度固定，也不是秘密）。两个 `want` 都来自配置且调用前已判空，所以不会出现"两个空串
 * 判成相等"。
 */
const sameSecret = (got, want) => {
  const a = Buffer.from(String(got ?? ""), "utf8")
  const b = Buffer.from(String(want ?? ""), "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * @param {object} deps
 * @param {string} deps.token        访问口令；留空则不校验（仅本机测试）
 * @param {string} deps.adminToken   管理口令；留空则没有这个入口
 * @param {string} deps.signKey      身份签名密钥
 * @param {() => string[]} deps.loadAdmins  读白名单（只含能当权限的 QQ）
 * @param {() => string[]} deps.loadOwners  读主人名单
 * @param {Function} deps.verifyIdentity    验身份签名（model/identity.js）
 */
export function createAuth({ token, adminToken, signKey, loadAdmins, loadOwners, verifyIdentity }) {
  const authorized = req => !token || sameSecret(tokenOf(req), token)

  /**
   * 一个 QQ 现在是什么角色
   *
   * 权限**只按稳定 QQ 判断**（AQ-01）：群昵称是本人随时能改的展示名，不能当身份——
   * 白名单里的昵称条目在 `loadAdmins/loadOwners` 里已经解析不出来（被忽略），这里连比都不比。
   *
   * 单独抽出来是因为**认领过的设备再来时没有链接**（那正是"24 小时内不必再带链接"的意思）：
   * 那时只能拿设备反查出来的 QQ 现算一遍角色。白名单随时可改，所以角色**不存进认领记录**，
   * 每次都现算——被移出白名单的人不会因为"当年认领过"而留着权限。
   */
  const roleOf = (identity = null) => {
    const id = String(identity?.qq ?? "").trim()
    const inList = Boolean(id) && loadAdmins().includes(id)
    /** 主人：白名单里唯一能增删白名单的人（管理口令是它的备用入口） */
    const owner = Boolean(id) && loadOwners().includes(id)
    const isAdmin = !token || owner || inList
    return { role: isAdmin ? "admin" : id ? "self" : "guest", owner, adminTokenOk: false }
  }

  /**
   * 认出调用者
   *
   * 本机没设口令时（TOKEN 为空）等同管理员，方便本机调试；
   * 设了口令就必须验签，验不过的当作没有身份的访客（只读）。
   * 身份与管理口令都走 `paramOf`（**请求头优先、query 兜底**，见 `respond.js` 的说明）。
   */
  const callerOf = req => {
    const identity = verifyIdentity(paramOf(req, "u"), paramOf(req, "s"), signKey)
    const adminTokenOk = Boolean(adminToken) && sameSecret(paramOf(req, "a"), adminToken)
    const { role, owner } = roleOf(identity)
    return { identity, adminTokenOk, owner, role: adminTokenOk ? "admin" : role }
  }

  /** 谁能维护白名单：主人，或拿着管理口令的人（本机没设口令时照旧全放开，方便调试） */
  const canManageAdmins = caller => !token || caller.owner || caller.adminTokenOk

  return { authorized, callerOf, canManageAdmins, roleOf }
}
