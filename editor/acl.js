/**
 * 白名单与完成情况锁（编辑器的权限基础）
 *
 * 两条口径（改之前先读，它们都是外部审核踩出来的）：
 *
 * 1. **权限只认 QQ**（AQ-01）。群昵称是本人随时能改的展示名——若拿它当权限，
 *    把群名片改成主人那串数字就凭空有了主人权限（与主人/管理员同名的也一样）。
 *    所以权限判断只看**签名过的稳定 QQ**；白名单里的昵称条目解析不出 QQ，
 *    一律**拒绝作为权限**，并且要让主人看见（启动日志 + 页面 + `/api/admins`），不能悄悄失效。
 *
 * 2. **完成情况锁不只记行号**（AQ-03、AQ-08）。主播改过某行的完成情况后本人不能再改；
 *    如果锁只记行号，整表替换 / 压紧行之后同一个行号可能已经是别人，于是"锁错人"——
 *    被锁住的是无辜的新成员，而原来那个人反而能改。所以每条锁额外记下"当时的群昵称"，
 *    整个文件再记下"这是哪一版表的锁"。
 *
 * 模块只依赖注入进来的 `deps`，不读任何全局：`rosterQqOfNick` 由调用方给
 * （白名单审计要给"群名单里能对上的建议 QQ"，但这一层不必知道群名单怎么存）。
 */
import { readJson, writeJson } from "./util.js"

/** QQ 的形态：5–12 位数字 */
export const ACL_QQ = /^\d{5,12}$/

/** 把一条配置归一成 QQ；不是 QQ 就返回空串（从群里复制的 `@12345` 也认） */
export const aclQq = raw => {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  const bare = s.replace(/^@+/, "").trim()
  return ACL_QQ.test(bare) ? bare : ""
}

/** 拆一份名单：能当权限的 QQ 与"解析不出来、被拒绝"的原始条目 */
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

/** 锁的读写工具：key = `<榜名>#<行号>` */
export const lockKey = (sheet, row) => `${sheet}#${row}`
export const lockSheetOf = key => String(key).slice(0, String(key).lastIndexOf("#"))
export const lockRowOf = key => Number(String(key).slice(String(key).lastIndexOf("#") + 1))

/**
 * 组装白名单 / 主人名单 / 完成情况锁的读写
 *
 * @param {object} deps
 * @param {string} deps.adminsFile 白名单文件（生产固定 `<插件根>/data/abyss-editor-admins.json`）
 * @param {string} deps.locksFile 完成情况锁文件
 * @param {string[]} [deps.envAdmins] 环境变量里写死的白名单（管理接口删不掉）
 * @param {string[]} [deps.envOwners] 环境变量/参数里写死的主人
 * @param {() => string} [deps.rosterQqOfNick] 群名单里这个昵称对应谁（审计建议用；缺省就不给建议）
 */
export function createAcl({ adminsFile, locksFile, envAdmins = [], envOwners = [], rosterQqOfNick = () => "" }) {
  /** 白名单文件里的某一项（`admins` / `owner`） */
  const adminFileList = key => {
    const list = readJson(adminsFile)?.[key]
    return Array.isArray(list) ? list : []
  }

  const loadAdmins = () => parseAcl([...envAdmins, ...adminFileList("admins")]).qqs
  /** 主人：环境变量/启动参数 + 文件。主人自动也是管理员，不用重复写进 admins */
  const loadOwners = () => parseAcl([...envOwners, ...adminFileList("owner")]).qqs

  /**
   * 白名单里那些**当不了权限**的历史条目
   *
   * QQ 号总能填对，群昵称填进来只会让人以为"配了却没用"（甚至以为越权成功了）。
   * 群名单里能唯一对上人的，顺手给出"应改成哪个 QQ"的建议——**仍要主人自己确认**，
   * 因为昵称是可以重名、可以随时改的，自动改写等于把昵称又变回身份（AQ-01）。
   */
  const aclAudit = () => {
    const admins = parseAcl([...envAdmins, ...adminFileList("admins")])
    const owners = parseAcl([...envOwners, ...adminFileList("owner")])
    const ignored = [...new Set([...owners.ignored, ...admins.ignored])]
    const suggestions = {}
    for (const nick of ignored) suggestions[nick] = rosterQqOfNick(nick)
    return { admins: admins.qqs, owners: owners.qqs, ignored, ownerIgnored: owners.ignored, suggestions }
  }

  /** 只改 admins 一项：文件里还有 owner 等键，不能顺手抹掉 */
  const saveAdmins = list => {
    const cur = readJson(adminsFile) ?? {}
    writeJson(adminsFile, { ...cur, admins: [...new Set(list.map(s => String(s).trim()).filter(Boolean))] })
  }

  /** 完成情况锁：`{ table: 表指纹, rows: { "<榜>#<行>": { nick, at } } }` */
  const loadLocks = () => {
    const raw = readJson(locksFile)
    const rows = raw?.rows && typeof raw.rows === "object" ? raw.rows : {}
    return { table: String(raw?.table ?? ""), rows }
  }
  const saveLocks = ({ table: fp = "", rows = {} } = {}) => writeJson(locksFile, { table: fp, rows })

  return { loadAdmins, loadOwners, aclAudit, saveAdmins, loadLocks, saveLocks, adminFileList }
}
