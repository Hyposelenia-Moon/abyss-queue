/**
 * 极简 xlsx 容器读写
 *
 * 只做两件事：读单元格、外科手术式改单元格。
 *
 * 为什么不用 exceljs / SheetJS：
 *   这类库把整个工作簿解析后重新序列化，人工维护表格里的
 *   条件格式（如 H 列"排队中"高亮）、数据验证（下拉）、合并单元格、
 *   超链接等会被丢弃或改写。
 *   本模块只替换目标 <c> 节点的文本，其余 XML 原样写回，
 *   写入用 inlineStr 从而完全不动 sharedStrings。
 */
import JSZip from "jszip"

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }

export const escapeXml = s => String(s).replace(/[&<>"']/g, c => ESCAPES[c])

export const unescapeXml = s =>
  String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

/** A→1, B→2, AA→27 */
export const colToIndex = letters =>
  [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)

/** "B12" → { col:"B", row:12 } */
export const splitRef = ref => {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref).toUpperCase())
  return m ? { col: m[1], row: Number(m[2]) } : null
}

const ROW_RE = /<row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
const CELL_RE = /<c(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
const VALIDATION_RE = /<dataValidation(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g

const attr = (s, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s || "")
  return m ? m[1] : undefined
}

/** 取出 <t> 文本（支持富文本多段 <r><t>） */
const collectText = inner => {
  let out = ""
  const re = /<t(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/t>)/g
  let m
  while ((m = re.exec(inner))) out += unescapeXml(m[2] ?? "")
  return out
}

export function cellValue(inner, attrs, shared) {
  if (inner == null) return ""
  const t = attr(attrs, "t")
  if (t === "inlineStr") {
    const is = /<is(?=[\s/>])[^>]*>([\s\S]*?)<\/is>/.exec(inner)
    return is ? collectText(is[1]) : ""
  }
  const v = /<v(?=[\s/>])[^>]*>([\s\S]*?)<\/v>/.exec(inner)
  if (!v) return ""
  const raw = unescapeXml(v[1])
  if (t === "s") return shared[Number(raw)] ?? ""
  return raw
}

/** 扫描工作表 XML：行、单元格、下拉验证 */
export function parseSheet(xml, shared = []) {
  const rows = new Map()
  const validations = new Map()

  ROW_RE.lastIndex = 0
  let rm
  while ((rm = ROW_RE.exec(xml))) {
    const r = Number(attr(rm[1], "r"))
    if (!Number.isFinite(r)) continue
    const cells = new Map()
    const inner = rm[2] ?? ""
    CELL_RE.lastIndex = 0
    let cm
    while ((cm = CELL_RE.exec(inner))) {
      const ref = attr(cm[1], "r")
      const pos = splitRef(ref)
      if (!pos) continue
      cells.set(pos.col, {
        ref,
        row: pos.row,
        col: pos.col,
        style: attr(cm[1], "s"),
        type: attr(cm[1], "t"),
        formula: /<f(?=[\s/>])/.test(cm[2] ?? "") ? true : false,
        value: cellValue(cm[2], cm[1], shared),
      })
    }
    /**
     * 同号行（同一份 XML 里出现两条 <row r="N">）只做**合并**，不要直接覆盖：
     * 覆盖会让前一条里的格子在读模型里凭空消失（写路径也可能造出同号行，见 setCellText 的注释），
     * 而外部工具（Excel / WPS / 人工改 XML）也可能留下这种写法。同一列冲突时以后出现的那条为准。
     */
    const seen = rows.get(r)
    if (seen) for (const [col, cell] of cells) seen.cells.set(col, cell)
    else rows.set(r, { r, cells })
  }

  VALIDATION_RE.lastIndex = 0
  let vm
  while ((vm = VALIDATION_RE.exec(xml))) {
    const sqref = attr(vm[1], "sqref") || ""
    const f1 = /<formula1(?=[\s/>])[^>]*>([\s\S]*?)<\/formula1>/.exec(vm[2] ?? "")
    if (!f1) continue
    let list = unescapeXml(f1[1]).trim()
    if (list.startsWith('"') && list.endsWith('"')) list = list.slice(1, -1)
    const options = list.split(",").map(i => i.trim()).filter(Boolean)
    for (const range of sqref.split(/\s+/)) {
      const col = /^([A-Z]+)/.exec(range)?.[1]
      if (col && options.length) validations.set(col, options)
    }
  }

  const dimension = /<dimension(?=[\s/>])[^>]*ref="([^"]*)"/.exec(xml)?.[1] ?? null
  return { rows, validations, dimension }
}

const rowText = (rowData, col) => rowData?.cells.get(col)?.value?.trim() ?? ""

export { rowText }

function findRowBlock(xml, rowNum) {
  ROW_RE.lastIndex = 0
  let m
  while ((m = ROW_RE.exec(xml))) {
    if (Number(attr(m[1], "r")) !== rowNum) continue
    const start = m.index
    const end = m.index + m[0].length
    if (m[2] === undefined) return { start, end, innerStart: end, innerEnd: end, inner: "", attrs: m[1], selfClosing: true }
    const innerStart = start + m[0].indexOf(">") + 1
    return { start, end, innerStart, innerEnd: end - "</row>".length, inner: m[2], attrs: m[1], selfClosing: false }
  }
  return null
}

function findCell(inner, ref) {
  CELL_RE.lastIndex = 0
  let m
  while ((m = CELL_RE.exec(inner))) {
    if (attr(m[1], "r") !== ref) continue
    return {
      start: m.index,
      end: m.index + m[0].length,
      attrs: m[1],
      inner: m[2],
      style: attr(m[1], "s"),
      selfClosing: m[2] === undefined,
    }
  }
  return null
}

function buildCellXml(ref, text, style) {
  const s = style != null && style !== "" ? ` s="${style}"` : ""
  const value = String(text)
  const space = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : ""
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${escapeXml(value)}</t></is></c>`
}

/** 新行：沿用相邻行的属性（行高、样式），只改 r */
function buildRowXml(xml, rowNum, cellXml) {
  const block = findRowBlock(xml, rowNum)
  let attrs = block ? block.attrs : null
  if (!attrs) {
    for (const delta of [-1, 1, -2, 2, -3, 3]) {
      const near = findRowBlock(xml, rowNum + delta)
      if (near) {
        attrs = near.attrs
        break
      }
    }
  }
  const clean = (attrs || "").replace(/\br="\d+"/, "").trim()
  return `<row r="${rowNum}"${clean ? " " + clean : ""}>${cellXml}</row>`
}

/**
 * 写入单元格文本；返回新的工作表 XML
 * @param style 单元格的样式索引。**显式传入时优先于已有格子的样式**：
 *   调用方（setRef / 模板规范化）明确要求某个样式时就该用它，否则"清空后补样式"这类
 *   先写值再改样式的流程永远改不动；不传（undefined）则沿用已有格子的样式，保住整行格式。
 */
export function setCellText(xml, ref, text, style) {
  const pos = splitRef(ref)
  if (!pos) throw new Error(`非法单元格引用: ${ref}`)

  const block = findRowBlock(xml, pos.row)
  /**
   * 已经有这一行（含自闭合写法）时，**必须就地换成成对标签**，不能走 insertRow
   *
   * `<row r="9"/>` 是「有行号、没有格子」的合法行，Excel / WPS 对"整行清空但留着行格式"的空行
   * 就是这么写的。若把它当成"这一行不存在"走 insertRow，自闭合那条会留在原地、同号出现两条
   * `<row>`；再写第二格时 findRowBlock 只认最前面那条（空的自闭合行）、又插一条 —— 值被拆进
   * 多条同号行，按行号收拢的读路径只留最后一条，先前写的值就丢了。
   */
  if (block?.selfClosing) {
    const rowXml = buildRowXml(xml, pos.row, buildCellXml(ref, text, style))
    return xml.slice(0, block.start) + rowXml + xml.slice(block.end)
  }
  if (!block) {
    const rowXml = buildRowXml(xml, pos.row, buildCellXml(ref, text, style))
    return insertRow(xml, pos.row, rowXml)
  }

  const cell = findCell(block.inner, ref)
  if (cell) {
    const cellXml = buildCellXml(ref, text, style != null && style !== "" ? style : cell.style)
    return xml.slice(0, block.innerStart + cell.start) + cellXml + xml.slice(block.innerStart + cell.end)
  }

  const cellXml = buildCellXml(ref, text, style)
  const colIndex = colToIndex(pos.col)
  let insertAt = block.inner.length
  CELL_RE.lastIndex = 0
  let m
  while ((m = CELL_RE.exec(block.inner))) {
    const other = splitRef(attr(m[1], "r"))
    if (other && colToIndex(other.col) > colIndex) {
      insertAt = m.index
      break
    }
  }
  const inner = block.inner.slice(0, insertAt) + cellXml + block.inner.slice(insertAt)
  return xml.slice(0, block.innerStart) + inner + xml.slice(block.innerEnd)
}

/**
 * 改写某一列的「下拉列表」验证里的内联选项
 *
 * 表里的「选择主播」下拉是一串写死在 <formula1>"a,b,c,"</formula1> 里的名字，
 * 主播区增删人之后它不会自己变，于是出现"主播列表与下拉菜单不一致"。
 * 这里只动指定列、且必须是内联列表的那一条验证；引用别的单元格区域的列表（$J$2:$J$9）不动，
 * 其余 XML 原样返回。
 *
 * @param {string} xml 工作表 XML
 * @param {string} column 列字母（如 "D"）
 * @param {string[]} values 新的选项（写进表里时会自动加上结尾逗号，与 Excel 的习惯一致）
 * @param {object} [opts]
 * @param {string} [opts.errorStyle] 校验强度：stop 会**拦住**手输的非法值（多选值就会被打回），
 *   warning 只提示、允许继续（默认），none 表示干脆不弹提示
 * @returns {{xml: string, updated: number}} updated = 实际改了几条验证
 */
export function setValidationList(xml, column, values, { errorStyle = "warning" } = {}) {
  const list = [...new Set(values.map(v => String(v ?? "").replace(/["\r\n]/g, "")).filter(Boolean))]
  if (!list.length) return { xml, updated: 0 }
  const text = `"${list.join(",")},"`
  let updated = 0

  const out = xml.replace(VALIDATION_RE, (whole, attrs, inner) => {
    if (inner === undefined) return whole
    if (!/type="list"/.test(attrs)) return whole
    /** sqref 可能是 "D10:D1048576" 或 "D10 D12:D20"，取每段的起始列 */
    const cols = (attr(attrs, "sqref") ?? "")
      .split(/\s+/)
      .map(r => splitRef(r.split(":")[0])?.col)
      .filter(Boolean)
    if (!cols.includes(String(column).toUpperCase())) return whole

    /** 顺手把校验强度调成"只提示不拦"，否则表里手写「阿修Axiu,听雨」会被打回 */
    let nextAttrs = attrs
    if (errorStyle && errorStyle !== "stop") {
      nextAttrs = /errorStyle="/.test(attrs)
        ? attrs.replace(/errorStyle="[^"]*"/, `errorStyle="${errorStyle}"`)
        : `${attrs} errorStyle="${errorStyle}"`
      if (!/showErrorMessage="/.test(nextAttrs)) nextAttrs += ' showErrorMessage="1"'
    }

    const next = inner.replace(/<formula1>([\s\S]*?)<\/formula1>/, (m, body) => {
      if (!unescapeXml(body).trim().startsWith('"')) return m
      updated++
      return `<formula1>${escapeXml(text)}</formula1>`
    })
    return next === inner && nextAttrs === attrs ? whole : `<dataValidation${nextAttrs}>${next}</dataValidation>`
  })
  return { xml: out, updated }
}

/* ------------------------- 清空单元格 ------------------------- */

const attrRe = name => new RegExp(`\\s${name}="[^"]*"`, "g")

/** 值相关子节点：清空时只去掉这些，单元格本身与它的样式要留着 */
const VALUE_PARTS = [
  /<v(?=[\s/>])(?:[^>]*?\/>|[^>]*?>[\s\S]*?<\/v>)/g,
  /<is(?=[\s/>])(?:[^>]*?\/>|[^>]*?>[\s\S]*?<\/is>)/g,
  /<f(?=[\s/>])(?:[^>]*?\/>|[^>]*?>[\s\S]*?<\/f>)/g,
]

/**
 * 清空一个单元格：**保留格子的位置与样式属性**（s / cm 等），只去掉值与公式
 *
 * 为什么不能整段删掉：表里数据行是逐行配色的（每行一套 s），把 <c> 删了，
 * 重新报名时只能套用「同列第一个格子的样式」，行自己的底色就丢了
 * （审核报告 AQ-15：剧诗 B9 清空后重新填入，样式号 30 → 37、底色变成第 8 行的）。
 * 留成空值格后，重新写入时 `setCellText` 会沿用原来的 s，隔行配色不串。
 * @see 验收：test/clearrow-style.test.mjs
 * @param {string} attrs <c> 的属性串
 * @param {string|undefined} inner <c> 的子节点（自闭合时为 undefined）
 */
function clearCellXml(attrs, inner) {
  const kept = String(attrs).replace(attrRe("t"), "")
  const body = inner == null ? "" : VALUE_PARTS.reduce((s, re) => s.replace(re, ""), inner)
  return body.trim() ? `<c${kept}>${body}</c>` : `<c${kept}/>`
}

/**
 * 清空指定单元格（退队 / 清行用）
 *
 * 只把值去掉、**保留单元格与样式**：行属性（行高、行样式）与 A 列序号公式不在 refs 里，不受影响。
 * @param {string} xml 工作表 XML
 * @param {string[]} refs 要清空的单元格地址
 */
export function removeCells(xml, refs) {
  let out = xml
  const byRow = new Map()
  for (const ref of refs) {
    const pos = splitRef(ref)
    if (!pos) continue
    if (!byRow.has(pos.row)) byRow.set(pos.row, [])
    byRow.get(pos.row).push(ref)
  }
  for (const [rowNum, list] of byRow) {
    const block = findRowBlock(out, rowNum)
    if (!block || block.selfClosing) continue
    /** 一次性扫出这一行要改的格子，再自后向前替换（避免前面的替换让后面的下标失效） */
    const found = []
    for (const ref of list) {
      const cell = findCell(block.inner, ref)
      if (cell) found.push(cell)
    }
    let inner = block.inner
    for (const cell of found.sort((a, b) => b.start - a.start))
      inner = inner.slice(0, cell.start) + clearCellXml(cell.attrs, cell.inner) + inner.slice(cell.end)
    if (inner !== block.inner)
      out = out.slice(0, block.innerStart) + inner + out.slice(block.innerEnd)
  }
  return out
}

/* ------------------------- 插入行（下方整块下移） ------------------------- */

/** "A6" → "A9"（只换行号，列不动） */
const withRow = (ref, row) => {
  const pos = splitRef(ref)
  return pos ? `${pos.col}${row}` : ref
}

/** 工作表最大行；下移后的行号压在这里面（Excel 不认 1048577） */
const MAX_ROW = 1048576

/**
 * sqref（`D8 D12:D20` 这种空格分隔的若干段）整体下移
 *
 * 端点 ≥ 插入点才 +count；超过工作表最大行的一律压在最大行上——`D8:D1048576`
 * （整列下拉）下移一位后必须还是 `D9:D1048576`，写成 1048577 是非法引用。
 */
const shiftSqref = (body, at, count) => {
  const move = ref => {
    const pos = splitRef(ref)
    if (!pos) return ref
    return `${pos.col}${pos.row >= at ? Math.min(pos.row + count, MAX_ROW) : pos.row}`
  }
  return String(body)
    .split(/\s+/)
    .filter(Boolean)
    .map(part => {
      const [from, to] = part.split(":")
      return to ? `${move(from)}:${move(to)}` : move(from)
    })
    .join(" ")
}

/**
 * 条件格式 `<formula>` 里的单元格引用整体下移（`$H11="排队中"` → `$H12="排队中"`）
 *
 * 行号引用在公式里长得就是"列字母 + 行号"，但**引号里**的是字面量（`"绝境(N6)"` 的 `N6`
 * 不是行号）——所以带引号的整段原样放回，只搬引号外的；`LOG10(` 这类带数字的函数名由
 * "后面不能紧跟 `(`"挡掉。别的函数 / 常量（`ROW()`、数字）本来就不匹配这个形态。
 */
const shiftFormulaRows = (body, at, count) =>
  String(body).replace(
    /"([^"]*)"|(?<![A-Za-z0-9_])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![0-9(])/g,
    (whole, quoted, lead, col, tail, row) => {
      if (quoted !== undefined) return whole
      return Number(row) >= at ? `${lead}${col}${tail}${Number(row) + count}` : whole
    },
  )

/**
 * 在指定行号**前面**插入 count 个空行，并把下方所有行号引用一起下移
 *
 * 用途：表头上方的「主播列表」要新增一位主播时，主播区本身没有空行可用，只能在最后一位
 * 主播下面插一行 —— 于是公告行、表头行、数据行、合并格、下拉验证范围、条件格式范围、
 * 超链接与冻结窗格都得跟着往下走一格。只做"行号 + count"这一件事，写值仍由
 * `setCellText` 负责；因此它是纯字符串变换，不改单元格内容（唯一例外是下面序号公式的常量）。
 *
 * **不动 sharedStrings**：新格由 setCellText 写成 inlineStr，与其余写入路径同一口径。
 *
 * **XML 处理面上的限制**（只认这几种写法，别的写法原样留在原行号上，不报错）：
 *   1. 冻结窗格只认自闭合的 `<pane …/>`；`<pane …></pane>` 不搬（`ySplit` / `topLeftCell` 会留在旧行）；
 *   2. 行与单元格只认 `r` 属性紧跟标签名的 `<row r="…">` / `<c r="…">`（属性顺序别的不搬）；
 *   3. 公式只搬 `=ROW()-k` 这一种序号公式与 `cfRule` 里 `<formula>` 的单元格引用：
 *      `cfRule` 的 `<formula>` **引号内**的字面量（`"绝境(N6)"`）不搬也不动
 *      （`N6` 不是行号，搬了就改错判据），`formula1`（数据验证的选项清单）一律不动。
 *   为什么可以接受：本函数只服务「新增主播」这一条路（`ctx.insertRows` 的唯一调用方），
 *   而真实表都是这种写法 —— Excel / WPS / 腾讯文档导出的 pane 是自闭合的，三张榜的
 *   `cfRule` 也都是字面量 `<formula>排队中</formula>`（没有行号可搬）。真遇到别的写法时
 *   宁可"这一处没搬"（表格里肉眼可见地错位、下一次人工维护就会暴露），也不猜着搬 ——
 *   猜错等于把别人的行数到别人头上。
 *
 * @param {string} xml 工作表 XML
 * @param {number} rowNum 在第几行前面插入（该行及以下整体下移）
 * @param {number} [count] 插入几行
 * @param {object} [opts]
 * @param {number} [opts.mergeTemplateRow] 照抄哪一行的合并格（原样复制给每个新行）；0 = 不抄
 * @returns {string} 新的工作表 XML
 */
export function insertRowsAndShift(xml, rowNum, count = 1, { mergeTemplateRow = 0 } = {}) {
  const at = Math.trunc(Number(rowNum) || 0)
  const added = Math.trunc(Number(count) || 0)
  if (at < 1 || added < 1) return xml
  const shift = row => (row >= at ? row + added : row)

  let out = xml

  /**
   * 序号列的公式 `=ROW()-k`：k 就是"表头行上面有多少行"，行整体下移之后常量必须 +count
   *
   * 不跟着改，Excel/WPS 一重算序号就从 2 开始（`=ROW()-7` 落到第 9 行算出 2）。
   * 只改这一种形态的公式：表里只有它，且它的常量按定义正是插入点上方的行数。
   */
  out = out.replace(/(<c r="[A-Z]+(\d+)"[^>]*>\s*<f[^>]*>=?)ROW\(\)-(\d+)(<\/f>)/g, (whole, head, row, k, tail) =>
    Number(row) >= at ? `${head}ROW()-${Number(k) + added}${tail}` : whole,
  )

  /** 行号与单元格地址：一趟扫完，免得移过的又被移一次 */
  out = out.replace(/<row r="(\d+)"|<c r="([A-Z]+)(\d+)"/g, (whole, row, col, cellRow) => {
    if (row !== undefined) return `<row r="${shift(Number(row))}"`
    return Number(cellRow) >= at ? `<c r="${col}${Number(cellRow) + added}"` : whole
  })

  /** 合并格与超链接：地址范围两端都要走 */
  out = out.replace(/(<mergeCell ref="|<hyperlink ref=")([A-Z]+\d+)(?::([A-Z]+\d+))?/g, (whole, head, from, to) => {
    const move = ref => withRow(ref, shift(splitRef(ref)?.row ?? 0))
    return head + move(from) + (to ? ":" + move(to) : "")
  })

  /** 下拉验证与条件格式的 sqref */
  out = out.replace(/(sqref=")([^"]*)(")/g, (whole, head, body, tail) => head + shiftSqref(body, at, added) + tail)

  /**
   * 条件格式的公式：`sqref` 上面搬过了，但 `cfRule` 的 `<formula>` 里还可能是行号引用
   * （Excel 写"用公式确定格式"时就是 `=$H11="排队中"`）——不搬就会指着上一行。
   * 自闭合的 `<cfRule …/>` 里没有 formula，只认成对写法；不是 formula 的子元素一律不动。
   */
  out = out.replace(/(<cfRule(?=[\s/>])[^>]*>)([\s\S]*?)(<\/cfRule>)/g, (whole, head, body, tail) =>
    head + body.replace(/(<formula(?=[\s/>])[^>]*>)([\s\S]*?)(<\/formula>)/g, (w, h, formula, t) => h + shiftFormulaRows(formula, at, added) + t) + tail,
  )

  /** 整表维度（行数上限） */
  out = out.replace(/(<dimension ref=")([A-Z]+\d+)(?::([A-Z]+\d+))?(")/g, (whole, head, from, to, tail) => {
    const move = ref => withRow(ref, shift(splitRef(ref)?.row ?? 0))
    return head + move(from) + (to ? ":" + move(to) : "") + tail
  })

  /** 冻结窗格：冻住的行数与左上角单元格都要跟着走，否则表头会冻错一行 */
  out = out.replace(/<pane(?=[\s/>])([^>]*?)\/>/g, (whole, attrs) => {
    const split = Number(attr(attrs, "ySplit"))
    const top = splitRef(attr(attrs, "topLeftCell") ?? "")
    let next = attrs
    if (Number.isFinite(split) && split >= at) next = next.replace(/(\bySplit=")\d+(")/, `$1${split + added}$2`)
    if (top) next = next.replace(/(\btopLeftCell=")[A-Z]+\d+(")/, `$1${top.col}${shift(top.row)}$2`)
    return next === attrs ? whole : `<pane${next}/>`
  })

  /**
   * 新行的合并格：照抄模板行
   *
   * 主播区是 A:B / C:F / G:H 三段合并；新行不抄就与邻居长得不一样（名字那一格只占 A 列）。
   */
  if (Number(mergeTemplateRow)) {
    const template = []
    for (const m of out.matchAll(/<mergeCell ref="([^"]*)"/g))
      if (splitRef(m[1].split(":")[0])?.row === Number(mergeTemplateRow)) template.push(m[1])
    if (template.length) {
      let cells = ""
      for (let i = 0; i < added; i++)
        for (const ref of template) {
          const [from, to] = ref.split(":")
          cells += `<mergeCell ref="${withRow(from, at + i)}:${withRow(to, at + i)}"/>`
        }
      const listed = (out.match(/<mergeCell /g) ?? []).length
      out = out.replace(/<mergeCells([^>]*)>/, (whole, attrs) => {
        const cur = Number(attr(attrs, "count"))
        const total = (Number.isFinite(cur) ? cur : listed) + added * template.length
        const next = /\bcount="/.test(attrs) ? attrs.replace(/(\bcount=")\d+(")/, `$1${total}$2`) : ` count="${total}"${attrs}`
        return `<mergeCells${next}>`
      })
      out = out.replace("</mergeCells>", cells + "</mergeCells>")
    }
  }

  return out
}

function insertRow(xml, rowNum, rowXml) {
  const dataTag = /<sheetData(?=[\s/>])([^>]*?)(\/>|>)/.exec(xml)
  if (!dataTag) throw new Error("工作表缺少 sheetData")

  if (dataTag[2] === "/>") {
    const head = xml.slice(0, dataTag.index)
    const tail = xml.slice(dataTag.index + dataTag[0].length)
    return `${head}<sheetData>${rowXml}</sheetData>${tail}`
  }

  const bodyStart = dataTag.index + dataTag[0].length
  const bodyEnd = xml.indexOf("</sheetData>", bodyStart)
  if (bodyEnd < 0) throw new Error("工作表 sheetData 未闭合")
  const body = xml.slice(bodyStart, bodyEnd)

  ROW_RE.lastIndex = 0
  let m
  let insertAt = body.length
  while ((m = ROW_RE.exec(body))) {
    const r = Number(attr(m[1], "r"))
    if (Number.isFinite(r) && r > rowNum) {
      insertAt = m.index
      break
    }
  }
  const next = body.slice(0, insertAt) + rowXml + body.slice(insertAt)
  return xml.slice(0, bodyStart) + next + xml.slice(bodyEnd)
}

/* ------------------------------ 容器 ------------------------------ */

const entryPath = (target, base = "xl/") => {
  if (!target) return null
  let t = String(target).replace(/^\//, "")
  if (!t.startsWith("xl/")) t = base + t
  return t
}

/**
 * 解压预算：整份表所有被读到的部件合起来，最多解出这么多字节
 *
 * 为什么要有：xlsx 就是 zip，压缩比可以到上千倍——`/api/upload` 那一侧的请求体上限是 32 MB，
 * 照着解可能出来几十 GB。编辑器与机器人**跑在同一个进程**里，撑爆一次就是全群掉线。
 * 门槛是"已经拿着口令的主人 / 管理员"，可一次拿错文件、一次脚本失误的代价，不该由整个机器人来付。
 *
 * **只认实际解出来的字节**（边解边数、超了立刻停），不认 zip 中央目录里声明的
 * `uncompressedSize`——那正是对手能随手填小的地方。
 */
const MAX_UNZIPPED_BYTES = 256 * 1024 * 1024
/** 条目数上限：正常表几十个部件；把一整个目录打包传上来的，先在这儿被拦下，报错也比"缺少 xl/workbook.xml"清楚 */
const MAX_ENTRIES = 2048
const mb = bytes => `${Math.round(bytes / 1024 / 1024)} MB`

export async function openWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files)
  if (names.length > MAX_ENTRIES)
    throw new Error(`xlsx 里的条目太多（${names.length} 个，上限 ${MAX_ENTRIES} 个），拒绝读取`)
  if (!zip.file("xl/workbook.xml")) throw new Error("不是有效的 xlsx：缺少 xl/workbook.xml")

  /**
   * 读一条 entry 的文本，顺手从总预算里扣掉它解出来的字节数
   *
   * 超预算就 `pause()` 并抛错：**不能**先 `async("string")` 再检查大小——那时候内存已经出去了。
   * 条目不存在返回 `null`（调用方自己决定这是不是错），其余情况一律抛。
   */
  let left = MAX_UNZIPPED_BYTES
  const readText = path =>
    new Promise((resolve, reject) => {
      const entry = zip.file(path)
      if (!entry) return resolve(null)
      const chunks = []
      let total = 0
      const stream = entry.nodeStream()
      stream.on("data", chunk => {
        total += chunk.length
        if (total > left) {
          stream.pause()
          reject(new Error(`xlsx 解压后超过 ${mb(MAX_UNZIPPED_BYTES)}，拒绝读取（压缩比过高的文件按攻击对待）`))
          return
        }
        chunks.push(chunk)
      })
      stream.on("error", reject)
      stream.on("end", () => {
        left -= total
        resolve(Buffer.concat(chunks).toString("utf8"))
      })
    })

  const wbXml = await readText("xl/workbook.xml")
  const relsXml = (await readText("xl/_rels/workbook.xml.rels")) ?? ""
  const rels = new Map()
  for (const m of relsXml.matchAll(/<Relationship(?=[\s/>])([^>]*?)\/?>/g)) {
    const id = attr(m[1], "Id")
    const target = attr(m[1], "Target")
    if (id && target) rels.set(id, entryPath(target))
  }

  const sheets = []
  for (const m of wbXml.matchAll(/<sheet(?=[\s/>])([^>]*?)\/?>/g)) {
    const name = unescapeXml(attr(m[1], "name") ?? "")
    const rid = attr(m[1], "r:id") ?? attr(m[1], "id")
    const path = rels.get(rid)
    if (name && path) sheets.push({ name, path })
  }
  if (!sheets.length) {
    sheets.push(
      ...Object.keys(zip.files)
        .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .sort()
        .map((path, i) => ({ name: `Sheet${i + 1}`, path })),
    )
  }

  let shared = []
  const ssXml = await readText("xl/sharedStrings.xml")
  if (ssXml !== null) {
    for (const m of ssXml.matchAll(/<si(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/si>)/g))
      shared.push(m[2] === undefined ? "" : collectText(m[2]))
  }

  const cache = new Map()
  const dirty = new Set()

  const api = {
    sheets,
    shared,
    hasSheet: name => sheets.some(s => s.name === name),
    async sheetXml(name) {
      const sheet = sheets.find(s => s.name === name)
      if (!sheet) throw new Error(`工作表不存在：${name}`)
      if (cache.has(name)) return cache.get(name)
      const text = await readText(sheet.path)
      if (text === null) throw new Error(`工作表内容缺失：${sheet.path}`)
      cache.set(name, text)
      return text
    },
    setSheetXml(name, xml) {
      const sheet = sheets.find(s => s.name === name)
      if (!sheet) throw new Error(`工作表不存在：${name}`)
      cache.set(name, xml)
      dirty.add(name)
    },
    async toBuffer() {
      for (const name of dirty) {
        const sheet = sheets.find(s => s.name === name)
        zip.file(sheet.path, cache.get(name))
      }
      return zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
        platform: "DOS",
      })
    },
  }
  return api
}
