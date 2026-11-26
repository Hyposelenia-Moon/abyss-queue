/** 鉴权：口令、身份签名、主人与白名单 */
import { timingSafeEqual } from "node:crypto"
import { paramOf, tokenOf } from "./respond.js"

const sameSecret = (got, want) => {
  const a = Buffer.from(String(got ?? ""), "utf8")
  const b = Buffer.from(String(want ?? ""), "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createAuth({ token, adminToken, signKey, loadAdmins, loadOwners, verifyIdentity }) {
  const authorized = req => !token || sameSecret(tokenOf(req), token)
  const roleOf = (identity = null) => {
    const id = String(identity?.qq ?? "").trim()
    const inList = Boolean(id) && loadAdmins().includes(id)
    const owner = Boolean(id) && loadOwners().includes(id)
    const isAdmin = !token || owner || inList
    return { role: isAdmin ? "admin" : id ? "self" : "guest", owner, adminTokenOk: false }
  }
  const callerOf = req => {
    const identity = verifyIdentity(paramOf(req, "u"), paramOf(req, "s"), signKey)
    const adminTokenOk = Boolean(adminToken) && sameSecret(paramOf(req, "a"), adminToken)
    const { role, owner } = roleOf(identity)
    return { identity, adminTokenOk, owner, role: adminTokenOk ? "admin" : role }
  }
  const canManageAdmins = caller => !token || caller.owner || caller.adminTokenOk
  return { authorized, callerOf, canManageAdmins, roleOf }
}
