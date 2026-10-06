/**
 * 鉴权：口令、身份签名、主人与白名单
 *
 * 口令（`?k=`）决定「能不能用这个服务」，身份签名（`?u=` `?s=`）决定「你是谁」，
 * 管理口令（`?a=`）是维护白名单的备用入口。三者的判定口径都收在这里。
 *
 * 取值全由 `editor.mjs` 注入（`loadAdmins` / `loadOwners` 是热读的，白名单改了立刻生效）。
 */
import { queryOf, tokenOf } from "./respond.js"

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
  const authorized = req => !token || tokenOf(req) === token

  /**
   * 认出调用者
   *
   * 本机没设口令时（TOKEN 为空）等同管理员，方便本机调试；
   * 设了口令就必须验签，验不过的当作没有身份的访客（只读）。
   */
  const callerOf = req => {
    const u = queryOf(req)
    const identity = verifyIdentity(u.searchParams.get("u"), u.searchParams.get("s"), signKey)
    const adminTokenOk = Boolean(adminToken) && u.searchParams.get("a") === adminToken
    /**
     * 权限**只按稳定 QQ 判断**（AQ-01）
     *
     * 群昵称是本人随时能改的展示名，不能当身份：白名单里的昵称条目在 loadAdmins/loadOwners
     * 里已经解析不出来（被忽略），这里连比都不比。
     */
    const qq = String(identity?.qq ?? "").trim()
    const inList = Boolean(qq) && loadAdmins().includes(qq)
    /** 主人：白名单里唯一能增删白名单的人（管理口令是它的备用入口） */
    const owner = Boolean(qq) && loadOwners().includes(qq)
    const isAdmin = !token || adminTokenOk || owner || inList
    return {
      identity,
      adminTokenOk,
      owner,
      role: isAdmin ? "admin" : identity ? "self" : "guest",
    }
  }

  /** 谁能维护白名单：主人，或拿着管理口令的人（本机没设口令时照旧全放开，方便调试） */
  const canManageAdmins = caller => !token || caller.owner || caller.adminTokenOk

  return { authorized, callerOf, canManageAdmins }
}
