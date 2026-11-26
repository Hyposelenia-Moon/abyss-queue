/** 白名单与完成情况锁（编辑器的权限基础） */
import { ACL_QQ, aclQq } from "../components/qq.js"
import { readJson, writeJson } from "./util.js"

export { ACL_QQ, aclQq }

export const parseAcl = list => {
  const qqs = []
  const ignored = []
  for (const raw of list ?? []) {
    const s = String(raw ?? "").trim()
    if (!s) continue
    const qq = aclQq(s)
    if (qq) {
      if (!qqs.includes(qq)) qqs.push(qq)
    } else if (!ignored.includes(s)) ignored.push(s)
  }
  return { qqs, ignored }
}

export const lockKey = (sheet, row) => `${sheet}#${row}`
export const lockSheetOf = key => String(key).slice(0, String(key).lastIndexOf("#"))
export const lockRowOf = key => Number(String(key).slice(String(key).lastIndexOf("#") + 1))

export function createAcl({ adminsFile, locksFile, envAdmins = [], envOwners = [], rosterQqOfNick = () => "" }) {
  const adminFileList = key => {
    const list = readJson(adminsFile)?.[key]
    return Array.isArray(list) ? list : []
  }
  const loadAdmins = () => parseAcl([...envAdmins, ...adminFileList("admins")]).qqs
  const loadOwners = () => parseAcl([...envOwners, ...adminFileList("owner")]).qqs
  const aclAudit = () => {
    const admins = parseAcl([...envAdmins, ...adminFileList("admins")])
    const owners = parseAcl([...envOwners, ...adminFileList("owner")])
    const ignored = [...new Set([...owners.ignored, ...admins.ignored])]
    const suggestions = {}
    for (const nick of ignored) suggestions[nick] = rosterQqOfNick(nick)
    return { admins: admins.qqs, owners: owners.qqs, ignored, ownerIgnored: owners.ignored, suggestions }
  }
  const saveAdmins = list => {
    const cur = readJson(adminsFile) ?? {}
    writeJson(adminsFile, { ...cur, admins: [...new Set(list.map(s => String(s).trim()).filter(Boolean))] })
  }
  const loadLocks = () => {
    const raw = readJson(locksFile)
    const rows = raw?.rows && typeof raw.rows === "object" ? raw.rows : {}
    return { table: String(raw?.table ?? ""), rows }
  }
  const saveLocks = ({ table: fp = "", rows = {} } = {}) => writeJson(locksFile, { table: fp, rows })
  return { loadAdmins, loadOwners, aclAudit, saveAdmins, loadLocks, saveLocks, adminFileList }
}
