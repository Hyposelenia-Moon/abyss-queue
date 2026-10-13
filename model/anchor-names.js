/**
 * 主播在**群里的名字**：表里怎么叫 → 群里怎么叫（`<插件根>/data/anchor-names.json`）
 *
 * 为什么需要它：开榜播报要在末尾 @ 这一榜的主播（`modules/notify/send.js`），而 @ 人靠"群昵称 → QQ"。
 * 表里那一列写的是**主播名**（主播区 A 列），群里他的群名片可能是另一个名字
 * ——名字对不上就 @ 不到人，只能干写一个名字。
 *
 * **为什么是单独一个数据文件、不是配置项**：这份东西是"手改的名单"（加一位主播就多一行），
 * 与"插件怎么跑"的配置不是一回事；放 `<插件根>/data/` 下还顺带避开了 `#更新` 的冲突
 * （`data/` 不入库，手改不会让部署目录变脏，也不会挡住快进）。开关是配置里的
 * `notify.open_anchor`（锅巴里有），**名单本身没有配置项**。
 *
 * 文件写法（**不存在 = 没有任何特殊名字**，这是默认状态）：
 *
 * ```json
 * { "names": { "表里的主播名": "群里的名字或QQ" } }
 * ```
 *
 * **放哪儿**：`<插件根>/data/anchor-names.json`（默认）或 `<Yunzai 根>/data/anchor-names.json`
 * （插件外那份；插件目录是 `<Yunzai>/plugins/<插件名>` 时就是它）——两个地方都行、格式一样，
 * **插件内那份优先**（见 `anchorNamesPaths()`）。
 *
 * - 键：**表里写的那个名字**（主播区 A 列，去掉「【推荐度】」之后的原文）；
 * - 值：**群里的名字**（拿去群名单里查 QQ），或者**直接写 QQ**（5–12 位数字，最稳：改名也不受影响）。
 *
 * 没登记的人按"表里名字 == 群里的名字"处理（很多主播在两边就是同一个名字）；
 * 两边都对不上就**只写名字、不发 @**（与"下一位"那条通知同一条纪律：不瞎 @、更不 @ 全体）。
 *
 * **读不出来就是空映射**（文件不存在是正常状态；内容坏了记一条 warn）：表现与没有这份文件时一致，
 * 不会因为一个坏文件把通知这条链路搞挂。
 */
import fs from "node:fs"
import path from "node:path"
import { config, pluginRoot } from "../components/config.js"
import { log } from "../components/logger.js"

/**
 * 映射文件的**查找顺序**：先插件内那份（`<插件根>/data/anchor-names.json`），再插件外那份
 * （`<Yunzai 根>/data/anchor-names.json` = `<插件根>/../../data/`）。**第一个存在的赢**
 *
 * 为什么允许插件外：维护者要求"映射文件放插件外，可自行增删"——放插件外的最大好处是
 * `#更新`（git 快进）**永远不会碰它**。插件内那份仍然是默认（`data/` 不入库，本来也不会被更新动到），
 * 两个地方都能用、内容格式完全一样；插件内的优先，这样"套件把路径指到临时目录"（环境变量）时不受外部文件影响。
 *
 * @returns {string[]} 候选路径（按优先级）
 */
export const anchorNamesPaths = () => {
  const inside = String(config.anchorNamesPath ?? "").trim()
  /** `<插件根>/../../data/anchor-names.json`：插件目录是 `<Yunzai>/plugins/<插件名>` 时就是 `<Yunzai>/data/` */
  const outside = path.resolve(pluginRoot, "..", "..", "data", "anchor-names.json")
  const list = [inside, outside].filter(Boolean).filter((p, i, all) => all.indexOf(p) === i)
  return list
}

/** 实际会读到的那一份（第一个存在的；都没有时给插件内那份，供日志说清"该往哪儿写"） */
export const anchorNamesPath = () => {
  const list = anchorNamesPaths()
  return list.find(p => fs.existsSync(p)) ?? list[0] ?? ""
}

/** 归一化一份映射：键与值都 trim，空键 / 空值丢掉；值里的 `@12345` 这种写法脱壳 */
const cleanNames = raw => {
  const out = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    const name = String(key ?? "").trim()
    const to = String(value ?? "").trim().replace(/^@+/, "")
    if (name && to) out[name] = to
  }
  return out
}

/**
 * 读映射表：`{ 表内名: 群内名或QQ }`（插件内、插件外都没这个文件 / 读坏了都是空对象）
 * @param {string} [file] 映射文件（默认按 `anchorNamesPath()` 找；套件可指到临时目录）
 */
export const readAnchorNames = (file = anchorNamesPath()) => {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    /** 文件不存在是**正常状态**（默认就没有特殊名字）；坏了要留痕，否则"配了却没生效"没人看得出来 */
    if (err?.code !== "ENOENT")
      log("warn", `[abyss-queue] 读主播名字映射失败（${file}）——本次按"没有特殊名字"处理：${err?.message ?? err}`)
    return {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  /** 两种写法都收：`{ names: {...} }`（推荐）与直接就是映射 */
  return cleanNames(raw.names && typeof raw.names === "object" ? raw.names : raw)
}

/**
 * 这位主播在群里叫什么（没登记就是表里那个名字本身）
 * @param {string} name 表里的主播名
 * @param {Record<string, string>} [names] 映射表（不给就现读文件）
 */
export const groupNameOfAnchor = (name, names = null) => {
  const key = String(name ?? "").trim()
  if (!key) return ""
  const map = names ?? readAnchorNames()
  return String(map[key] ?? key).trim()
}
