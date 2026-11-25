/**
 * 表格的静态定义：列、状态词、榜单简称、公共队列、各项上限
 *
 * 从 `editor.mjs` 搬出来的纯常量与两行工具，**不读文件、不碰运行时状态**——
 * 所以任何模块都可以 import，也不会形成环。
 *
 * 改这里的口径等于改表结构：`docs/queue.schema.md` 与 `editor/README.md` 要同一轮跟上。
 */

export const PUBLIC_ANCHOR = "公共队列"

export const PUBLIC_QUEUE_NAME = "公共队列"

/** 白名单与完成情况锁（名单解析 + 锁的存取） */

export const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  /** 主播与完成情况都可能是一格多个值（"阿修Axiu,听雨"），校验时按逗号拆开逐项比对 */
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]

/**
 * 挪行时要**跟着人一起走**的列（`#插队` 用）
 *
 * 就是 `FIELDS` 那六列（群昵称 → 帮帮完成情况）：这一整段换到别人那一行的位置上，人才算真的挪过去了。
 * **A 列序号不搬**：序号 = 位置（`=ROW()-k` 的缓存值 1..N），人挪到第几位就该显示第几位——
 * 跟着人搬过去会让"第 3 位"那一行写着 4，全列看着像乱码。
 * 表头识别出来的列字母由 `model.col` 给，这里只列 key（列不齐的表由 `model.col` 自己缺项）。
 */
export const MOVE_COLUMN_KEYS = FIELDS.map(f => f.key)

/**
 * 表头上方「主播列表」的可写字段 —— 与 #主播 渲染出来的列一一对应
 *
 * 单元格位置按原表：A 主播名、C 核心强项、D 专职（C:F 合并区里的空格）、G/H 直播入口。
 *
 * **主播区（表头之上）与排队区（表头之下）是同一张表里的两个不同的区**，但行号是一根轴：
 * 新增主播要在最后一位主播下面占一行，插行点之下的公告行 / 表头行 / 整个排队区都得整体下移
 * （行号 +1，见 `model/xlsx.js` 的 `insertRowsAndShift`），绑定与锁里的行号同步跟搬
 * （`shiftRowsOf`）；漏搬就是"版本戳对得上、人却被认到别人的行上"。改既有行的 `rows` 路径不动行号。
 * 删主播仍然只能去表格里删行（编辑器只做"改既有行 + 新增"）。
 */
export const ANCHOR_FIELDS = [
  { key: "name", label: "主播", col: "A", required: true },
  { key: "recommend", label: "推荐度", col: "" },
  { key: "duty", label: "专职", col: "D" },
  { key: "skills", label: "核心强项", col: "C" },
  { key: "platform", label: "B站直播入口（平台）", col: "G" },
  { key: "link", label: "B站直播入口（链接）", col: "H" },
]

/* ------------------------- 白名单与完成情况锁 ------------------------- */

/**
 * 白名单 / 完成情况锁 / 群名单的**落点**在启动装配时算好（见上方解构）；
 * 三块实现分别在 `editor/acl.js` 与 `editor/roster.js`，本文件只做装配与鉴权：
 *   - `acl`：名单解析（只认 QQ，AQ-01）+ 完成情况锁（连昵称与表指纹一起记，AQ-03/08）
 *   - `roster`：群成员名单（昵称候选 + 按 QQ 取当前名片）
 * 装配点放在下方「表与绑定」之后——它们要等 `store()` 就绪。
 */

export const blank = v => !String(v ?? "").trim()

/* ------------------------- 新行的默认值 ------------------------- */

export const WAITING_STATUS = "等待开启"

export const QUEUED_STATUS = "排队中"

/**
 * 各榜的开榜时间（新行的「帮帮完成情况」默认值按它算）
 *
 *   幻想真境剧诗：每月 1 号 4 点开，**不设「等待开启」**，默认就是「排队中」
 *   深境螺旋：每月 16 号 4 点开，到点前默认「等待开启」，到点后默认「排队中」
 *   幽境危战：按版本开放、没有固定日子，默认「等待开启」，要排队请手动改成「排队中」
 */
export const OPEN_RULES = [
  { test: /剧诗/, day: 1 },
  { test: /螺旋/, day: 16 },
]

export const SHEET_SHORT = {
  幻想真境剧诗: "剧诗",
  幽境危战: "危战",
  深境螺旋: "深渊",
  绝境攻炼: "枪战",
}

export const sheetShortOf = sheet => SHEET_SHORT[String(sheet ?? "").trim()] || String(sheet ?? "").trim()

/** 主播呼叫对普通人限频：同一 QQ、同一榜、同一主播行 5 分钟一次；管理员不限 */

export const ANCHOR_CALL_COOLDOWN_MS = 5 * 60 * 1000

/**
 * 下拉选项（前端展示与后端校验共用一份，避免"界面能选、保存却说不在选项里"） *
 * 「选择主播」**以表头上方的主播列表为准**（表里的下拉验证常跟不上主播区的增删改）：
 *   1. 主播列表里的每一位，按表内顺序排在前面 —— 这是权威名单
 *   2. 表里已经在用、但不在主播列表里的值（例如「公共队列」）追加在后面，免得老数据没法选
 *   3. 认得出是哪位主播的别名（如「璃月第一深情」→ 摸头妹）不算独立选项，直接归到正名
 *   4. 主播列表为空、表里也没有可用的旧值时，整份退回表里的下拉验证原样
 *   5. **「公共队列」是模板内置的独占项，始终补在名单末尾**——它不依赖"当前有没有人用"，
 *      否则最后一行改成主播名后，这个选项就会从下拉里消失，之后再也选不回来。
 */
export const ANY_ANCHOR = "公共队列"

/**
 * 完成情况里的「未开始 / 进行中」：它们与「某完成人」（主播名 / 本人已完成）互斥
 * 前端点选时会互相挤掉，这里是服务端的兜底校验
 */
export const PENDING_STATUS = ["等待开启", "排队中"]

/** 一键"我完成了"：落成这一行的群昵称，表里看到的就是完成人 */

export const SELF_DONE = "本人已完成"

/** 只能单独选的值：选了它就不能再和别的并存（如「公共队列」）；前端点选时也会清，这里是兜底 */

export const EXCLUSIVE_VALUES = [ANY_ANCHOR]

export const CYCLE_PROTOCOL = 2

/**
 * 成员行的**业务上界**：允许在数据区末尾之后追加几行，但绝不允许"想写哪行就写哪行"
 *
 * 为什么需要它：表头上方是主播区、再往上是公告/标题，它们**不在** `model.rows` 里。
 * 于是"`model.rows` 里没有这个行号"既可能是"要新增一行"，也可能是"要改主播格 / 改表头"——
 * 两者混在一起，等于把受保护的区域交给任何一个有签名身份的人。合法追加与越界的区别只在行号，
 * 所以这里给追加划一条固定上限（页面就是在数据区末尾往下顺延找空行，见 editor.html 的 pickRowNumber）。
 */
export const APPEND_ROWS_MAX = 500

export const ANCHOR_FIRST_ROW = 3

/**
 * 整表替换必须带的列（表头识别出来的列字母）
 *
 * 编辑器会写这些列，缺任何一列都会让对应字段"界面能填、保存却悄悄丢掉"；
 * 业务读取（机器人出图、锁、进度）也依赖它们。空模板允许（结构在、一行数据都没有），
 * 但连表头都没有的表一律拒绝，并把缺什么说清楚（AQ-07）。
 */
export const REPLACE_REQUIRED_COLUMNS = [
  ["seq", "序号"],
  ["nickname", "群昵称"],
  ["gameName", "原神游戏名"],
  ["anchor", "选择主播"],
  ["goal", "难度及目标"],
  ["status", "帮帮完成情况"],
  ["note", "备注"],
]
