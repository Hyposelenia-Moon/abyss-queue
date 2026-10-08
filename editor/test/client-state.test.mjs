/**
 * 编辑器前端的草稿状态：新增行的提交口径 + 草稿的「榜 × 行」两维归属
 *
 * 为什么不能用接口测试代替：AQ-04（新增行丢掉输入）和 AQ-05（切榜串写）都发生在**页面状态**里，
 * 服务端接口测试直接 POST 一份填好的对象，正好绕过「输入 → 草稿 → 保存请求」这一段。
 * 所以这里把 `editor.html` 里的脚本**原样抽出来**，在 node:vm 里跑，桩掉 fetch 与最小 DOM 面，
 * 断言真实处理器构造出来的请求（目标榜、行号、字段），不向任何真实表格落盘。
 *
 * 覆盖面：
 *   - 首次报名：新增行填好的字段要进得了 /api/save（有默认完成情况 / 没有默认状态两种）
 *   - 没有默认状态时，一个字没填的新增行不能被当成"清空记录"提交
 *   - 两个榜有相同行号时，切榜保存只提交当前榜（成员草稿与主播草稿各一遍）
 *   - 保存成功后只清本次保存那一榜的草稿（另一榜没保存的改动要留着）
 *   - 跨榜新增的行不会被提交给别的榜
 *
 * 用法：node editor/test/client-state.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
/** 假计时器（共用）：页面没有「保存」按钮了，保存由 1.5 秒防抖触发，套件得能推时钟 */
import { makeFakeTimers } from "./page-vm.mjs"

const HTML = path.join(import.meta.dirname, "..", "editor.html")
const html = fs.readFileSync(HTML, "utf8")

/** 页面里的内联脚本（按顺序、同一个上下文跑，与浏览器一致）；不带 src 的才算 */
const SCRIPTS = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1])
if (!SCRIPTS.length) throw new Error(`${HTML} 里抽不出内联脚本——套件的前提没了`)

/* ------------------------------ 最小 DOM ------------------------------ */

/**
 * 只实现 editor.html 真正用到的那点 API：多了就是在测自己的假 DOM，不是在测页面
 * （classList 与 className 共用一份集合，因为页面两种写法都用）
 */
function makeEl(tag = "div") {
  const classes = new Set()
  const el = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    attrs: {},
    dataset: {},
    style: {},
    value: "",
    title: "",
    textContent: "",
    placeholder: "",
    type: "",
    disabled: false,
    parentNode: null,
    _html: "",
    classList: {
      add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      contains: c => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : Boolean(on)
        if (want) classes.add(c)
        else classes.delete(c)
        return want
      },
    },
    get className() {
      return [...classes].join(" ")
    },
    set className(v) {
      classes.clear()
      String(v ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach(c => classes.add(c))
    },
    get innerHTML() {
      return el._html
    },
    set innerHTML(v) {
      el._html = String(v ?? "")
      /** 浏览器语义：重新赋 innerHTML 会换掉全部子节点（页面靠这个清空表格） */
      el.childNodes = []
    },
    appendChild(child) {
      child.parentNode = el
      el.childNodes.push(child)
      return child
    },
    append(...kids) {
      kids.forEach(k => el.appendChild(k))
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v)
    },
    getAttribute(k) {
      return el.attrs[k] ?? null
    },
    /** 页面只在浮层定位时用一次；假 DOM 不排版，这里按下面 rectOf() 复算（见"假 DOM 的最小排版"） */
    closest: () => null,
    remove() {
      const at = el.parentNode?.childNodes.indexOf(el) ?? -1
      if (at >= 0) el.parentNode.childNodes.splice(at, 1)
    },
    /** 内容自然高度（没被 max-height 夹住时的 scrollHeight）/ 夹住之后的可视高度 */
    get scrollHeight() {
      return contentH(el)
    },
    get clientHeight() {
      return Math.max(0, Math.min(px(el.style.maxHeight) || contentH(el), contentH(el)))
    },
  }
  el.getBoundingClientRect = () => rectOf(el)
  return el
}

/**
 * 假 DOM 的最小"排版"：只把 placePicker() 自己写下的 top / bottom / max-height 换算回来
 *
 * 页面里 `getBoundingClientRect()` 是浏览器算的，这里没有排版引擎，就按"浮层贴着自己算出的
 * 那一边、高度被 max-height 夹住"复算一遍——**用的是页面写进 style 的同一批数字**，
 * 所以"浮层被顶出视口""底部那一行落到浮层外面"这类几何错误能在这里被抓住。
 */
const VP = { w: 1200, h: 600 }
const PAD = 6
const px = v => Number(String(v ?? "").replace("px", "")) || 0
const rectOf = el => {
  const w = px(el.style.width) || 200
  const h = px(el.style.height) || 30
  if (el.style.top) return { top: px(el.style.top), bottom: px(el.style.top) + h, left: 0, right: w, width: w, height: h }
  if (el.style.bottom) return { top: VP.h - px(el.style.bottom) - h, bottom: VP.h - px(el.style.bottom), left: 0, right: w, width: w, height: h }
  return { top: 0, bottom: h, left: 0, right: w, width: w, height: h }
}
/** 元素在浮层里的"自然高度"：候选行 30、底行 38（输入框 + 上边框那一行 + 上下内边距） */
const naturalH = el => (el.className.includes("addname") ? 38 : 30)
const contentH = el => el.childNodes.reduce((sum, c) => sum + naturalH(c), 0)

const makeStorage = () => {
  const box = new Map()
  return {
    getItem: k => (box.has(k) ? box.get(k) : null),
    setItem: (k, v) => box.set(k, String(v)),
    removeItem: k => box.delete(k),
  }
}

/* ------------------------------ 桩数据 ------------------------------ */

/** 与 editor.mjs 的 FIELDS 同口径（字段顺序就是列顺序，假 DOM 靠它找格子） */
const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]
const OPTIONS = {
  anchor: ["阿修Axiu", "听雨"],
  goal: ["困难满花", "险恶(N4)"],
  strength: ["高配", "中配", "低配"],
  status: ["等待开启", "排队中", "本人已完成"],
}

/**
 * 两个榜故意**行号相同**（各自的数据行都在第 10 行），这正是 AQ-05 的场景：
 * 只按行号存草稿的话，两个榜的草稿会互相顶替。
 * 剧诗给默认完成情况（排队中），危战**不给**（模拟服务端没算出开榜时间）。
 */
const makeData = (perm = { role: "admin", readonly: false }) => ({
  fields: FIELDS,
  roster: { candidates: [] },
  savedAt: "",
  perm,
  sheets: [
    {
      name: "剧诗",
      dataStart: 8,
      dataEnd: 20,
      taken: [10],
      defaults: { status: "排队中" },
      options: OPTIONS,
      anchors: OPTIONS.anchor,
      anchorRows: [
        { row: 10, name: "阿修Axiu", recommend: "强烈推荐", duty: "剧诗", skills: "", platform: "B站", link: "" },
      ],
      rows: [
        {
          row: 10,
          seq: 1,
          nickname: "甲",
          gameName: "甲的游戏",
          anchor: "阿修Axiu",
          goal: "困难满花",
          strength: "中配",
          note: "",
          status: "排队中",
        },
      ],
    },
    {
      name: "危战",
      dataStart: 8,
      dataEnd: 20,
      taken: [10],
      defaults: {},
      options: OPTIONS,
      anchors: OPTIONS.anchor,
      anchorRows: [
        { row: 10, name: "听雨", recommend: "推荐", duty: "危战", skills: "", platform: "抖音", link: "" },
      ],
      rows: [
        {
          row: 10,
          seq: 1,
          nickname: "乙",
          gameName: "乙的游戏",
          anchor: "听雨",
          goal: "险恶(N4)",
          strength: "高配",
          note: "",
          status: "",
        },
      ],
    },
  ],
})

/* ------------------------------ 开机 ------------------------------ */

const flush = () => new Promise(r => setImmediate(r))

/**
 * 跑一遍页面脚本，返回操作与观察用的把手
 *
 * 脚本末尾追加一段探针（不改页面语义），把闭包里的草稿暴露出来：
 * 只在"预置一条已填完的新增行"这类测试前置里用，断言本身一律看请求。
 */
function boot({
  perm = { role: "admin", readonly: false },
  data = makeData(perm),
  /** 自定义 fetch（设备令牌 / 时间窗那几条要自己控制响应头与状态码）；不给就用默认桩 */
  fetch: fetchImpl = null,
  /** 地址栏（页面会从 `location.search` 收 k/u/s/w/ws） */
  search = "",
} = {}) {
  const byId = new Map()
  const document = {
    head: makeEl("head"),
    body: makeEl("body"),
    createElement: tag => makeEl(tag),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl("div"))
      return byId.get(id)
    },
    addEventListener() {},
  }

  const calls = []
  const timers = makeFakeTimers()
  /** 假响应与真 fetch 同形：`json()` / `text()` / `headers.get()` 三样都要有（见 page-vm.mjs 的同名注释） */
  const jsonRes = payload => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  })
  const fetchStub = (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    calls.push({ url: String(url), method: opts?.method ?? "GET", body })
    if (String(url).includes("api/save")) {
      return jsonRes({ ok: true, written: body?.rows?.length ?? 0, cleared: 0, ignored: [], notices: [] })
    }
    if (String(url).includes("api/anchors")) return jsonRes({ ok: true, written: body?.rows?.length ?? 0, options: 0 })
    return jsonRes(structuredClone(data))
  }

  /** window 上注册的监听：页面把"滚动/改窗口就收起浮层"挂在这里，套件要能触发它们 */
  const winListeners = {}
  const ctx = {
    document,
    window: {
      /** 视口尺寸：与假 DOM 的"排版"（VP / rectOf）同一份口径 */
      innerWidth: VP.w,
      innerHeight: VP.h,
      addEventListener(type, fn) {
        ;(winListeners[type] ??= []).push(fn)
      },
    },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { search, pathname: "/editor" },
    history: { replaceState() {} },
    fetch: fetchImpl ?? fetchStub,
    /** 计时器交给假时钟：自动保存的那 1.5 秒要能精确推到点，`note()` 的自动消失照旧不跑真的 */
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    confirm: () => true,
    console,
    URLSearchParams,
  }
  vm.createContext(ctx)
  vm.runInContext(
    SCRIPTS.join("\n;\n") +
      `
;globalThis.__client = {
  get data() { return data },
  get current() { return current },
  get perm() { return perm },
  get edited() { return edited },
  get added() { return added },
  get anchorEdited() { return anchorEdited },
  /** 表格那一格的构造器：几何类断言要自己指定单元格位置（假 DOM 不排版） */
  get pillsInput() { return pillsInput },
  get pillNorm() { return pillNorm },
}`,
    ctx,
    { filename: "editor.html" },
  )

  const el = id => document.getElementById(id)
  const grid = el("grid")
  /** grid → table → tbody → tr（页面就是这么拼的） */
  const gridRows = () => grid.childNodes[0]?.childNodes[1]?.childNodes ?? []
  /** tr 的第 i+1 个格子是第 i 个字段（第 0 个是序号列） */
  const cellOf = (tr, key) => tr.childNodes[FIELDS.findIndex(f => f.key === key) + 1]
  const controlOf = (tr, key) => cellOf(tr, key).childNodes[0]

  const h = {
    ctx,
    document,
    calls,
    get probe() {
      return ctx.__client
    },
    get data() {
      return ctx.__client.data
    },
    async ready() {
      await flush()
      await flush()
    },
    /** 按表格行号找一行（序号列 title 里写着真实行号） */
    rowNo(row) {
      const tr = gridRows().find(x => x.childNodes[0].title === "表格第 " + row + " 行")
      if (!tr) throw new Error(`界面上没有第 ${row} 行`)
      return tr
    },
    newRow() {
      const tr = gridRows().find(x => x.className.includes("isnew"))
      if (!tr) throw new Error("界面上没有新增行")
      return tr
    },
    /** 文本框：页面把改动记在 onchange 上（离开这一格时触发） */
    type(tr, key, value) {
      const input = controlOf(tr, key)
      input.value = value
      if (typeof input.onchange !== "function") throw new Error(`${key} 这一格不是文本框`)
      input.onchange()
    },
    /** 胶囊格（难度及目标 / 完成情况）：点「＋」开浮层，再点选项——走的是真实下拉路径 */
    pick(tr, key, option) {
      const td = cellOf(tr, key)
      const add = td.childNodes[0].childNodes.find(n => n.className.includes("addbtn"))
      if (!add) throw new Error(`${key} 这一格没有「＋」按钮`)
      add.onclick({ stopPropagation() {} })
      /** 浮层里的每个选项是「按钮里嵌一个胶囊」，文字在胶囊上 */
      /** 候选在浮层里的 `.opts` 那一层（底部「＋ 收录新名字」在它外面，见 editor.html 的 .picker .opts） */
      const opt = td.childNodes[1].childNodes[0].childNodes.find(n => (n.childNodes[0]?.textContent ?? n.textContent) === option)
      if (!opt) throw new Error(`${key} 的浮层里没有「${option}」`)
      opt.onclick({ stopPropagation() {} })
    },
    /** 只点开这一格的下拉浮层（不选值）：空着点「＋ 选择」，已经有值时点那颗胶囊 */
    openPicker(tr, key) {
      const box = cellOf(tr, key).childNodes[0]
      const btn =
        box.childNodes.find(n => n.className.includes("addbtn")) ??
        box.childNodes.find(n => n.className.includes("pill"))
      if (!btn) throw new Error(`${key} 这一格没有能点开下拉的东西`)
      btn.onclick({ stopPropagation() {} })
    },
    /** 浮层现在开着吗（浮层一直待在格子里，只是 position: fixed） */
    pickerOpen(tr, key) {
      return Boolean(cellOf(tr, key).childNodes[1]?.classList.contains("open"))
    },
    /** 点浮层里的某个选项：没打开就报错，别把"顺手打开"当成通过 */
    pickOption(tr, key, option) {
      const picker = cellOf(tr, key).childNodes[1]
      if (!picker?.classList.contains("open")) throw new Error(`${key} 的浮层没打开`)
      const opt = picker.childNodes[0].childNodes.find(n => (n.childNodes[0]?.textContent ?? n.textContent) === option)
      if (!opt) throw new Error(`${key} 的浮层里没有「${option}」`)
      opt.onclick({ stopPropagation() {} })
    },
    /**
     * 胶囊格现在显示的胶囊文字（空着时没有胶囊）
     *
     * 假 DOM 不聚合子节点文本（`box.textContent` 恒为空），所以直接取那一颗胶囊自己的 textContent
     */
    cellText(tr, key) {
      const pill = cellOf(tr, key).childNodes[0].childNodes.find(n => n.className.includes("pill"))
      return pill ? pill.textContent : ""
    },
    /** 胶囊格现在那颗胶囊的 class（底色口径由它表达，见 editor.html 的 pillColor） */
    cellPillClass(tr, key) {
      const pill = cellOf(tr, key).childNodes[0].childNodes.find(n => n.className.includes("pill"))
      return pill ? pill.className : ""
    },
    /**
     * 触发一次 window 的 scroll（capture 口径）
     *
     * 真实浏览器里，滚动浮层内部时 `scroll` 事件的 target 就是浮层自己；
     * 页面必须区分"浮层内部滚"和"页面滚"，前者不能把浮层关掉。
     */
    fireScroll(target) {
      for (const fn of winListeners.scroll ?? []) fn({ target })
    },
    /** 这一格的浮层元素（用来当 scroll 事件的 target） */
    pickerOf(tr, key) {
      return cellOf(tr, key).childNodes[1]
    },
    /** 主播列表：输入记在 oninput 上 */
    typeAnchor(sheetIndex, key, value) {
      h.tab(sheetIndex)
      const table = el("anchorGrid").childNodes[0]
      const tr = table.childNodes[1].childNodes[0]
      const col = ["name", "recommend", "skills", "platform"].indexOf(key)
      const input = tr.childNodes[col + 1].childNodes[0]
      input.value = value
      input.oninput()
    },
    anchorSkills(sheetIndex) {
      h.tab(sheetIndex)
      return el("anchorGrid").childNodes[0].childNodes[1].childNodes[0].childNodes[3].childNodes[0].value
    },
    /** 点标签切榜 */
    tab(index) {
      const t = el("tabs").childNodes[index]
      if (!t) throw new Error(`没有第 ${index} 个标签`)
      t.onclick()
    },
    async click(id) {
      const fn = el(id).onclick
      if (typeof fn !== "function") throw new Error(`${id} 上没有点击处理器`)
      await fn()
      await flush()
    },
    /**
     * 自动保存：把假时钟往前推过防抖那 1.5 秒，等于用户"改完停手"。
     * 页面没有「保存」按钮了，凡是过去"点保存"的地方一律走这里。
     */
    async autoSave() {
      timers.advance(1500)
      await h.ready()
    },
    posts(part) {
      return calls.filter(c => c.method === "POST" && c.url.includes(part))
    },
  }
  return h
}

/* ------------------------------ 断言 ------------------------------ */

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
/** 真正被点过的那次保存请求（没有就直接报"压根没发保存请求"） */
const onlySave = h => {
  const posts = h.posts("api/save")
  if (posts.length !== 1) throw new Error(`期望 1 个 /api/save 请求，实际 ${posts.length} 个（${h.calls.map(c => c.method + " " + c.url.split("?")[0]).join("、")}）`)
  return posts[0].body
}

console.log("前端草稿状态（editor.html 原脚本 + 请求捕获）")

/* ------------------------- AQ-04 新增行 ------------------------- */

await check("新增行（本榜有默认完成情况）：填好的字段进得了保存请求", async () => {
  const h = boot({ perm: { role: "self", readonly: false, nick: "甲" } })
  await h.ready()
  await h.click("addRow")
  const tr = h.newRow()
  h.type(tr, "nickname", "新人丙")
  h.type(tr, "gameName", "丙的游戏")
  h.pick(tr, "anchor", "阿修Axiu")
  h.type(tr, "note", "第一次报名")
  h.pick(tr, "goal", "困难满花")
  await h.autoSave()

  const body = onlySave(h)
  must(body.sheet === "剧诗", `保存请求的目标榜是 ${body.sheet}`)
  must(body.rows.length === 1, `请求里应只有这一条新行，实际 ${body.rows.length} 条`)
  const sent = body.rows[0]
  must(sent.row === 8, `挑的行号是 ${sent.row}（第 10 行被别人占着，该挑第 8 行）`)
  for (const [k, want] of [
    ["nickname", "新人丙"],
    ["gameName", "丙的游戏"],
    ["anchor", "阿修Axiu"],
    ["goal", "困难满花"],
    ["note", "第一次报名"],
  ]) {
    must(sent.values[k] === want, `${k} 提交的是 ${JSON.stringify(sent.values[k])}，期望 ${JSON.stringify(want)}（用户填的没进请求）`)
  }
  /** 默认完成情况本来就该落表 */
  must(sent.values.status === "排队中", `完成情况提交的是 ${JSON.stringify(sent.values.status)}，期望默认值「排队中」`)
  /** 只提交字段本身：newRow 里的 __new / __sheet 是界面用的，别塞进请求 */
  const leaked = Object.keys(sent.values).filter(k => !FIELDS.some(f => f.key === k))
  must(!leaked.length, `请求里混进了界面用的键：${leaked.join(",")}`)
})

await check("首次报名（本榜还没有自己的行）：自动开的那一行填好也能保存", async () => {
  const data = makeData({ role: "self", readonly: false, nick: "丙" })
  /** 本人在这一榜一行都没有 → 页面进来就自动开一行（不用点「＋」） */
  data.sheets[0] = { ...data.sheets[0], rows: [], taken: [] }
  const h = boot({ perm: data.perm, data })
  await h.ready()
  const tr = h.newRow()
  h.type(tr, "nickname", "新人丙")
  h.type(tr, "gameName", "丙的游戏")
  h.pick(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")
  await h.autoSave()

  const body = onlySave(h)
  must(body.sheet === "剧诗", `保存请求的目标榜是 ${body.sheet}`)
  must(body.rows.length === 1, `请求里应只有自动开的那一行，实际 ${body.rows.length} 条`)
  must(body.rows[0].row === 8, `挑的行号是 ${body.rows[0].row}`)
  must(body.rows[0].values.nickname === "新人丙", `昵称提交的是 ${JSON.stringify(body.rows[0].values.nickname)}`)
  must(body.rows[0].values.goal === "困难满花", "难度没进请求")
})

await check("新增行（本榜没有默认完成情况）：照样能保存", async () => {
  const h = boot({ perm: { role: "self", readonly: false, nick: "乙" } })
  await h.ready()
  h.tab(1) // 危战：服务端没给默认完成情况
  await h.click("addRow")
  const tr = h.newRow()
  h.type(tr, "nickname", "新人丁")
  h.type(tr, "gameName", "丁的游戏")
  h.pick(tr, "anchor", "听雨")
  h.pick(tr, "goal", "险恶(N4)")
  await h.autoSave()

  const body = onlySave(h)
  must(body.sheet === "危战", `保存请求的目标榜是 ${body.sheet}`)
  must(body.rows.length === 1, `请求里应只有这一条新行，实际 ${body.rows.length} 条`)
  must(body.rows[0].values.nickname === "新人丁", "昵称没进请求")
  must(body.rows[0].values.status === "", `完成情况本来就没默认值，不该凭空写 ${JSON.stringify(body.rows[0].values.status)}`)
})

await check("新增行（没有默认完成情况、一个字没填）：不能当成清空记录提交", async () => {
  const h = boot({ perm: { role: "self", readonly: false, nick: "乙" } })
  await h.ready()
  h.tab(1)
  await h.click("addRow")
  await h.autoSave()
  /** 全空对象提交上去 = 让后端清掉这一行；点了「＋」又反悔，应该什么都不发 */
  must(h.posts("api/save").length === 0, "没填任何内容却发了保存请求（这一行会被当成清空记录）")
})

/* ------------------------- AQ-05 切榜 ------------------------- */

await check("两个榜行号相同：改了剧诗第 10 行的备注，切到危战保存不该写危战", async () => {
  const h = boot()
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗第 10 行的备注")
  h.tab(1) // 切到危战（它也有第 10 行，但一个字都没改）
  await h.autoSave()
  const posts = h.posts("api/save")
  must(posts.length === 0, `危战没有改动却发了保存请求：${JSON.stringify(posts[0]?.body)}`)
})

await check("保存成功后只清本次保存那一榜：另一榜没保存的备注还在", async () => {
  const h = boot()
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗的备注")
  h.tab(1)
  h.type(h.rowNo(10), "note", "危战的备注")
  await h.autoSave()

  const first = onlySave(h)
  must(first.sheet === "危战", `先保存的应是危战，实际 ${first.sheet}`)
  must(first.rows.length === 1, `危战只有一行有改动，实际提交 ${first.rows.length} 行`)
  must(first.rows[0].values.note === "危战的备注", `危战第 10 行提交的是 ${JSON.stringify(first.rows[0].values.note)}`)
  must(first.rows[0].values.nickname === "乙", `危战第 10 行的其它字段被串改：${JSON.stringify(first.rows[0].values.nickname)}`)

  /** 回到剧诗：它的草稿没被保存过，必须还在（整表重读会按榜清掉这一榜的草稿，别的榜要留着） */
  h.tab(0)
  h.calls.length = 0
  await h.autoSave()
  const second = onlySave(h)
  must(second.sheet === "剧诗", `第二次保存的目标榜是 ${second.sheet}`)
  must(second.rows[0].values.note === "剧诗的备注", `剧诗的备注草稿丢了：提交的是 ${JSON.stringify(second.rows[0].values.note)}`)
})

await check("两个榜主播行号相同：切榜后保存主播列表只带当前榜的改动", async () => {
  const h = boot()
  await h.ready()
  /** 先改危战，再改剧诗（两榜主播都在第 10 行），最后回到危战保存 */
  h.typeAnchor(1, "skills", "危战强项")
  h.typeAnchor(0, "skills", "剧诗强项")
  h.tab(1)
  await h.click("anchorSave")

  const posts = h.posts("api/anchors")
  must(posts.length === 1, `期望 1 个 /api/anchors 请求，实际 ${posts.length} 个`)
  must(posts[0].body.sheet === "危战", `目标榜是 ${posts[0].body.sheet}`)
  must(posts[0].body.rows.length === 1, `危战只有一位主播改过，实际提交 ${posts[0].body.rows.length} 行`)
  must(posts[0].body.rows[0].row === 10, `提交的行号是 ${posts[0].body.rows[0].row}`)
  must(
    posts[0].body.rows[0].values.skills === "危战强项",
    `危战提交的强项是 ${JSON.stringify(posts[0].body.rows[0].values.skills)}（剧诗那格串过来了）`,
  )
})

await check("保存主播列表后，另一榜没保存的主播改动仍在", async () => {
  const h = boot()
  await h.ready()
  h.typeAnchor(0, "skills", "剧诗强项")
  h.typeAnchor(1, "skills", "危战强项")
  await h.click("anchorSave") // 保存危战
  h.tab(0)
  must(h.anchorSkills(0) === "剧诗强项", `剧诗的强项草稿被清掉了，界面上是 ${JSON.stringify(h.anchorSkills(0))}`)
  h.calls.length = 0
  await h.click("anchorSave")
  const posts = h.posts("api/anchors")
  must(posts.length === 1, `回到剧诗后应能保存它自己的改动，实际发了 ${posts.length} 个请求`)
  must(posts[0].body.sheet === "剧诗", `目标榜是 ${posts[0].body.sheet}`)
  must(posts[0].body.rows[0].values.skills === "剧诗强项", "剧诗的强项没提交上去")
})

await check("跨榜新增：在剧诗新增一行，切到危战保存不该把它提交给危战", async () => {
  const h = boot()
  await h.ready()
  await h.click("addRow")
  const tr = h.newRow()
  h.type(tr, "nickname", "剧诗新人")
  h.type(tr, "gameName", "新人的游戏")
  h.pick(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")
  /** 界面之外再把 newRow 造的种子写满：保存提交的是整行的每个字段，
   *  不写满的话会先倒在必填校验上，就测不到"按榜筛选"这一条了 */
  const seed = h.probe.added.find(r => r.__sheet === "剧诗")
  must(!!seed, "界面上没有剧诗的新增行")
  Object.assign(seed, { nickname: "剧诗新人", gameName: "新人的游戏", anchor: "阿修Axiu", goal: "困难满花" })

  h.tab(1)
  await h.autoSave()
  const posts = h.posts("api/save")
  must(posts.length === 0, `危战没有改动，却把剧诗的新增行提交给了 ${posts[0]?.body.sheet}：${JSON.stringify(posts[0]?.body)}`)

  /** 回到剧诗，这一行还得提交得上（别为了"不串榜"把新增行整个丢掉） */
  h.tab(0)
  await h.autoSave()
  const body = onlySave(h)
  must(body.sheet === "剧诗", `目标榜是 ${body.sheet}`)
  must(body.rows.length === 1 && body.rows[0].values.nickname === "剧诗新人", `剧诗的新增行没提交：${JSON.stringify(body.rows)}`)
})

await check("下拉浮层：单选选完自动收起；多选（完成情况）留着能连选", async () => {
  const h = boot({ perm: { role: "self", readonly: false, nick: "甲" } })
  await h.ready()
  const tr = h.rowNo(10)

  /** 单选：难度及目标 —— 选一下就该收起来（浮层杵在那儿会挡住下面几行） */
  h.openPicker(tr, "goal")
  must(h.pickerOpen(tr, "goal"), "点「＋ 选择」之后单选浮层没打开")
  h.pickOption(tr, "goal", "险恶(N4)")
  must(!h.pickerOpen(tr, "goal"), "单选（难度及目标）选完之后浮层没有自动收起")
  must(h.cellText(tr, "goal").includes("险恶(N4)"), `这一格显示的是 ${JSON.stringify(h.cellText(tr, "goal"))}`)

  /** 多选：帮帮完成情况 —— 本来就是连着点几个值，点一下不能关 */
  h.openPicker(tr, "status")
  must(h.pickerOpen(tr, "status"), "点「＋」之后多选浮层没打开")
  h.pickOption(tr, "status", "本人已完成")
  must(h.pickerOpen(tr, "status"), "多选（完成情况）点一下就关了，没法连选")

  /** 收起归收起，值必须真进了草稿 */
  await h.autoSave()
  const body = onlySave(h)
  const values = body.rows[0].values
  must(values.goal === "险恶(N4)", `难度提交的是 ${JSON.stringify(values.goal)}`)
  /** 「本人已完成」按既有口径落成这一行自己的群昵称（甲），所以提交的是昵称而不是那四个字 */
  must(values.status === "甲", `完成情况提交的是 ${JSON.stringify(values.status)}（「本人已完成」应当落成群昵称）`)
})

await check("头部「待保存 N 项」：文本框改字、点胶囊、删胶囊都要立刻跟着变", async () => {
  const h = boot({ perm: { role: "self", readonly: false, nick: "甲" } })
  await h.ready()
  const tr = h.rowNo(10)
  const hint = () => h.document.getElementById("hint").textContent

  must(/待保存 0 项/.test(hint()), `刚进页面就该是 0 项，实际 ${JSON.stringify(hint())}`)
  /** 文本框：不触发重画，最容易漏刷 */
  h.type(tr, "note", "改了备注")
  must(/待保存 1 项/.test(hint()), `文本框改字之后计数没刷：${JSON.stringify(hint())}`)
  /** 胶囊：多选删一颗也算改动（同一行只算一项草稿） */
  h.openPicker(tr, "status")
  h.pickOption(tr, "status", "排队中")
  must(/待保存 1 项/.test(hint()), `点胶囊之后计数不对：${JSON.stringify(hint())}`)
  /** 把改过的字段全部还原：这一行跟表里一致了，不该再算一项、也不该提交 */
  h.type(tr, "note", "")
  h.pickOption(tr, "status", "排队中")
  must(/待保存 0 项/.test(hint()), `改回原样之后应当回到 0 项，实际 ${JSON.stringify(hint())}`)
  await h.autoSave()
  must(h.posts("api/save").length === 0, "值改回原样还发了保存请求（会白写一次、白存一份版本）")
  /** 没有「保存」按钮也没有「没有改动」的提示了：状态文字直接回到「已保存」 */
  const state = h.document.getElementById("saveState").textContent
  must(state === "已保存", `状态文字应当是「已保存」，实际 ${JSON.stringify(state)}`)
})

await check("选择主播：胶囊多选（点开连选两位，落表逗号分隔）", async () => {
  const h = boot({ perm: { role: "self", readonly: false, nick: "甲" } })
  await h.ready()
  const tr = h.rowNo(10)

  /** 这一格本来有值（阿修Axiu）：点「＋」再补一位——多选不能点一下就收 */
  h.openPicker(tr, "anchor")
  must(h.pickerOpen(tr, "anchor"), "选择主播的浮层没打开")
  h.pickOption(tr, "anchor", "听雨")
  must(h.pickerOpen(tr, "anchor"), "选择主播是多选，点一下不该收起（要能连选）")

  await h.autoSave()
  const body = onlySave(h)
  const sent = String(body.rows[0].values.anchor)
  must(sent.includes("阿修Axiu") && sent.includes("听雨"), `落表的主播是 ${JSON.stringify(sent)}（应当同时有这两位）`)
  must(sent.includes(","), `多值应当用逗号分隔，实际 ${JSON.stringify(sent)}`)
})

await check("完成情况的下拉：「本人已完成」与本人昵称不再同时出现（重复名字）", async () => {
  const optionTexts = (hh, tr, key) =>
    hh.pickerOf(tr, key).childNodes[0].childNodes.map(n => n.childNodes[0]?.textContent ?? n.textContent)

  /** ① 这一行的状态就是自己的群昵称（表里存的就是它）⇒ 只留昵称，收起字面「本人已完成」 */
  const data = makeData({ role: "self", readonly: false, nick: "甲" })
  data.sheets[0].rows[0].status = "甲"
  const h1 = boot({ perm: data.perm, data })
  await h1.ready()
  const tr1 = h1.rowNo(10)
  h1.openPicker(tr1, "status")
  const texts1 = optionTexts(h1, tr1, "status")
  must(texts1.includes("甲"), `候选里应当有本人昵称：${JSON.stringify(texts1)}`)
  must(!texts1.includes("本人已完成"), `昵称已经是这一行的值了，不该再列「本人已完成」：${JSON.stringify(texts1)}`)

  /** ② 状态是「排队中」⇒ 只留字面「本人已完成」，不额外塞本人昵称 */
  const h2 = boot({ perm: { role: "self", readonly: false, nick: "甲" } })
  await h2.ready()
  const tr2 = h2.rowNo(10)
  h2.openPicker(tr2, "status")
  const texts2 = optionTexts(h2, tr2, "status")
  must(texts2.includes("本人已完成"), `候选里应当有「本人已完成」：${JSON.stringify(texts2)}`)
  must(!texts2.includes("甲"), `不该额外塞一份本人昵称（会看到两个重复的名字）：${JSON.stringify(texts2)}`)
})

await check("完成情况的下拉：候选只认「状态词 + 主播 + 手动收录」，但**当前值**一定还在（点得到、取消得掉）", async () => {
  const optionTexts = (hh, tr, key) =>
    hh.pickerOf(tr, key).childNodes[0].childNodes.map(n => n.childNodes[0]?.textContent ?? n.textContent)

  /**
   * 服务端现在只下发 状态词 ∪ 主播 ∪ 手动收录（`mergeStatusOptions`），这一列的候选里**不再**有
   * 「表里在用的名字」；而这一格的值可能是当年点「本人已完成」落下的群昵称（别人写在别人行上的也算）。
   * 页面必须把**当前值**并进候选，否则用户看不到自己那一格、也没法把它取消掉。
   */
  const data = makeData({ role: "self", readonly: false, nick: "甲" })
  data.sheets[0].rows[0].status = "乙"
  /** 候选里一个群昵称都没有（模拟净化之后的服务端） */
  data.sheets[0].options = { ...data.sheets[0].options, status: ["等待开启", "排队中", "本人已完成"] }
  const h = boot({ perm: data.perm, data })
  await h.ready()
  const tr = h.rowNo(10)
  h.openPicker(tr, "status")
  const texts = optionTexts(h, tr, "status")
  must(texts.includes("乙"), `这一格的当前值不在候选里（点不到、也取消不掉）：${JSON.stringify(texts)}`)
  must(texts.includes("排队中"), `状态词被挤掉了：${JSON.stringify(texts)}`)
  must(!texts.includes("甲"), `不该凭昵称额外塞候选（甲没写在这一格里）：${JSON.stringify(texts)}`)

  /** 取消掉当前值：点一下就该被移除（这是"清残留"在页面上的出口） */
  h.pickOption(tr, "status", "乙")
  const picked = h.probe.edited.get("剧诗\u0000" + 10)?.status
  must(picked === "", `点一下当前值应当把它取消掉，实际草稿是 ${JSON.stringify(picked)}`)
})

await check("群昵称「相近候选」：打字给出最像的几个名字，点一下填入并记进草稿", async () => {
  const data = makeData({ role: "self", readonly: false, nick: "甲" })
  /** 机器人推来的群成员名单（候选条就从它里面挑） */
  data.roster = { candidates: ["阿修Axiu", "摸头妹", "柏林乔", "听雨"] }
  const h = boot({ perm: data.perm, data })
  await h.ready()
  const tr = h.rowNo(10)
  /** 假 DOM 里自己找格子（与 `boot()` 里那两份同口径：第 0 格是序号列） */
  const cellOf = (row, key) => row.childNodes[FIELDS.findIndex(f => f.key === key) + 1]
  const controlOf = (row, key) => cellOf(row, key).childNodes[0]
  const input = controlOf(tr, "nickname")
  const box = () => cellOf(tr, "nickname").childNodes[1]
  const names = () => box().childNodes.slice(1).map(n => n.textContent)

  must(typeof input.oninput === "function", "群昵称这一格没有接上「相近候选」的输入处理")

  /** ① 前缀命中：打「阿修」⇒ 给出「阿修Axiu」，远的那几个不许出现 */
  input.value = "阿修"
  input.oninput()
  must(names().includes("阿修Axiu"), `前缀没命中：${JSON.stringify(names())}`)
  must(!names().includes("柏林乔"), `八竿子打不着的名字也端出来了：${JSON.stringify(names())}`)

  /** ② 差一两个字也认（编辑距离 ≤ 2）：打「摸头姐姐」⇒ 给出「摸头妹」 */
  input.value = "摸头姐姐"
  input.oninput()
  must(names().includes("摸头妹"), `差一两个字的名字没兜住：${JSON.stringify(names())}`)

  /** ③ 已经一字不差：不用再提示 */
  input.value = "听雨"
  input.oninput()
  must(names().length === 0, `写对了还在提示：${JSON.stringify(names())}`)

  /** ④ 点一下填入：走与手改同一条路（写草稿 + 刷计数 + 排自动保存），并把提示条收掉 */
  input.value = "摸头"
  input.oninput()
  const hit = box().childNodes.slice(1).find(n => n.textContent === "摸头妹")
  must(hit, `候选里没有「摸头妹」：${JSON.stringify(names())}`)
  hit.onclick()
  must(input.value === "摸头妹", `点了没有填进去：${JSON.stringify(input.value)}`)
  must(
    h.probe.edited.get("剧诗\u0000" + 10)?.nickname === "摸头妹",
    `填进去的没记成草稿：${JSON.stringify(h.probe.edited.get("剧诗\u0000" + 10))}`,
  )
  must(box().childNodes.length === 0, "填好之后提示条没收起")
})

await check("设备令牌与时间窗：没令牌时首请求带窗口，拿到令牌后改用它（不再带窗口）", async () => {
  const data = makeData({ role: "self", readonly: false, nick: "甲" })
  const TOKEN = "b".repeat(32) + ".SIG"
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
    const body = structuredClone(data)
    return {
      status: 200,
      ok: true,
      headers: { get: k => (k === "x-abyss-device" ? TOKEN : null) },
      text: async () => JSON.stringify(body),
      json: async () => body,
    }
  }
  const h = boot({ perm: data.perm, data, fetch: impl, search: "?k=tok&u=UU&s=SS&w=7&ws=WS" })
  await h.ready()

  must(calls.length >= 1, "一发请求都没发")
  /** 还没有设备令牌（cookie 被挡的浏览器就是这样）：第一发必须把窗口带上，才走得通"认领" */
  must(/[?&]w=7/.test(calls[0].url) && /[?&]ws=WS/.test(calls[0].url), `首请求没带时间窗：${calls[0].url}`)
  must(!calls[0].headers["x-abyss-device"], `还没有令牌就带上了：${JSON.stringify(calls[0].headers)}`)

  /** 服务端回了令牌：**之后的**请求带上它，并且不再带窗口（窗口过期不该顶掉好用的会话） */
  h.type(h.rowNo(10), "note", "改一下备注")
  await h.autoSave()
  const posted = calls.filter(c => c.url.includes("api/save"))
  must(posted.length === 1, `应当发一发保存请求，实际 ${posted.length}：${JSON.stringify(calls.map(c => c.url))}`)
  must(posted[0].headers["x-abyss-device"] === TOKEN, `保存请求没带上设备令牌：${JSON.stringify(posted[0].headers)}`)
  must(!/[?&]w=/.test(posted[0].url), `已经有令牌了还带窗口：${posted[0].url}`)
  must(h.rowNo(10), "页面没有把行渲染出来")
})

await check("首请求带窗口被打回 410：自动去掉窗口重试一次（cookie 正常的浏览器照旧能走）", async () => {
  const data = makeData({ role: "self", readonly: false, nick: "甲" })
  const calls = []
  const impl = async url => {
    const u = String(url)
    calls.push(u)
    /** 带窗口的那一发按"链接已失效"处理（服务端对过期窗口就是这么回的：410 + 网页） */
    if (/[?&]w=/.test(u))
      return { status: 410, ok: false, headers: { get: () => null }, text: async () => "<!doctype html><p>链接已经失效</p>", json: async () => ({}) }
    const body = structuredClone(data)
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body }
  }
  const h = boot({ perm: data.perm, data, fetch: impl, search: "?k=tok&u=UU&s=SS&w=7&ws=WS" })
  await h.ready()

  must(calls.some(u => /[?&]w=/.test(u)), `第一发没带窗口：${JSON.stringify(calls)}`)
  must(calls.some(u => !/[?&]w=/.test(u)), `410 之后没有去掉窗口重试：${JSON.stringify(calls)}`)
  must(h.rowNo(10), "重试那一发没有把数据读回来（表没渲染出来）")
})

await check("页面标题跟着角色：主人 / 白名单管理员是「排队表 · 管理」，本人与只读访客是「排队表 · 填写」", async () => {
  const title = page => page.document.getElementById("pageTitle").textContent

  const admin = boot({ perm: { role: "admin", readonly: false } })
  await admin.ready()
  must(title(admin) === "排队表 · 管理", `管理员看到的是 ${JSON.stringify(title(admin))}`)
  must(admin.document.title === "排队表 · 管理", `标签页标题没跟着改：${JSON.stringify(admin.document.title)}`)

  /** 主人：服务端算出来的角色也是 `admin`（`editor/http/auth.js` 里 owner ⇒ admin），所以同样显示「管理」 */
  const owner = boot({ perm: { role: "admin", readonly: false, owner: true, versions: true, manage: true } })
  await owner.ready()
  must(title(owner) === "排队表 · 管理", `主人看到的是 ${JSON.stringify(title(owner))}`)

  const self = boot({ perm: { role: "self", readonly: false, nick: "甲" } })
  await self.ready()
  must(title(self) === "排队表 · 填写", `本人看到的是 ${JSON.stringify(title(self))}`)

  const guest = boot({ perm: { role: "guest", readonly: true } })
  await guest.ready()
  must(title(guest) === "排队表 · 填写", `只读访客看到的是 ${JSON.stringify(title(guest))}`)
})

await check("完成情况底色：主播名=绿、本人昵称=橙、既不是主播也不是本人=黄", async () => {
  /**
   * 「其余」那一支的口径：表里写的名字既不在主播列表、也不是这一行本人时给黄底
   * （页面里 `.pill.yellow` 是黄底深褐字，见 editor.html）。
   * 三档一起钉：改口径时不能把主播绿与本人橙顺手带走。
   */
  for (const [value, want] of [
    ["阿修Axiu", "green"],
    ["甲", "orange"],
    ["路人丙", "yellow"],
  ]) {
    const data = makeData()
    data.sheets[0].rows[0].status = value
    const h = boot({ data })
    await h.ready()
    const cls = h.cellPillClass(h.rowNo(10), "status")
    must(cls.includes(want), `完成情况写成「${value}」时胶囊的 class 是「${cls}」，期望带 ${want}`)
  }
})

await check("下拉浮层：在浮层里滚轮翻选项不会把它关掉，滚页面才会收起", async () => {
  const h = boot({ perm: { role: "self", readonly: false, nick: "甲" } })
  await h.ready()
  const tr = h.rowNo(10)

  /** 选项超过浮层高度时用户必须能在里面滚（scroll 事件 target = 浮层自己） */
  h.openPicker(tr, "goal")
  must(h.pickerOpen(tr, "goal"), "点开之后浮层没打开")
  h.fireScroll(h.pickerOf(tr, "goal"))
  must(h.pickerOpen(tr, "goal"), "在浮层里滚动把浮层关掉了（用户要在下拉里翻选项，不能一滚就收）")
  /** 滚的还是那一格，值照样能选上 */
  h.pickOption(tr, "goal", "险恶(N4)")
  must(!h.pickerOpen(tr, "goal"), "选完之后没自动收起")

  /** 页面/表格本身滚动时还是要收起：固定定位的浮层跟不上滚动 */
  h.openPicker(tr, "goal")
  must(h.pickerOpen(tr, "goal"), "第二次点开失败")
  h.fireScroll(h.document.getElementById("grid"))
  must(!h.pickerOpen(tr, "goal"), "页面滚动之后浮层还开着（会停在跟格子对不上的位置）")
})

await check("完成情况的下拉：候选表的写法与这一格的值只差空格/全角括号时，当前值照样打上勾", async () => {
  /**
   * 这一列是人工维护的多值，分隔符与写法都不统一（`pillNorm` 就是为此存在的：全角括号当半角、去掉空格）。
   * 底色认的是归一化后的值、勾选却曾经是原样 `includes` —— 于是"胶囊上了色、下拉里却没有一项被打勾"，
   * 用户看着像没选上。
   */
  const data = makeData({ role: "self", readonly: false, nick: "甲" })
  data.sheets[0].rows[0].status = "险恶(N4)"
  data.sheets[0].options = { ...data.sheets[0].options, status: ["等待开启", "排队中", "本人已完成", "险恶（N4）"] }
  const h = boot({ perm: data.perm, data })
  await h.ready()
  const tr = h.rowNo(10)
  /** 底色与勾选同一套归一化：显示成绿胶囊，下拉里对应的那一项也要打上勾（写的是哪个值就存哪个值） */
  h.openPicker(tr, "status")
  const items = h.pickerOf(tr, "status").childNodes[0].childNodes
  const named = items.filter(n => /险恶/.test(n.childNodes[0]?.textContent ?? n.textContent))
  must(named.length === 1, `归一化后是同一个值的两种写法应当只留一项：${JSON.stringify(items.map(n => n.childNodes[0]?.textContent ?? n.textContent))}`)
  must(named[0].childNodes[0].textContent === "险恶(N4)", `留下的应当是这一格里存的那份写法：${JSON.stringify(named[0].childNodes[0].textContent)}`)
  must(named[0].className.includes("on"), `候选表写「险恶（N4）」而这一格是「险恶(N4)」时没打上勾（看着像没选上）`)

  /** 点它一下是取消（它就在这一格里）；取消之后这一格就该是空的 */
  h.pickOption(tr, "status", "险恶(N4)")
  await h.autoSave()
  const body = onlySave(h)
  must(body.rows[0]?.values?.status === "", `取消之后提交的是 ${JSON.stringify(body.rows[0]?.values?.status)}`)
})

await check("完成情况的下拉：昵称已是候选、这一格还是字面「本人已完成」时，它不能被收掉（会变成没得选）", async () => {
  /**
   * 现场：表是腾讯文档那边人工维护的，可以直接选到字面「本人已完成」；服务端 `statusWithSelfDone`
   * 只在**这一格落的字面值**上把它换成昵称（`nickname` 为空时还换不动）。
   * 而下拉里"昵称已经是候选"那一条会把字面「本人已完成」收掉 —— 于是这一格的当前值在下拉里
   * **一个对应项都没有**：看着"没被标成已选"，想改也点不到它自己（点一下只能加别的值）。
   */
  const data = makeData({ role: "self", readonly: false, nick: "甲" })
  data.sheets[0].rows[0].status = "本人已完成"
  /** 这一行的昵称已经在候选表里（别人那一格用过它）——"收掉字面项"的条件成立 */
  data.sheets[0].options = { ...data.sheets[0].options, status: ["等待开启", "排队中", "本人已完成", "甲"] }
  const h = boot({ perm: data.perm, data })
  await h.ready()
  const tr = h.rowNo(10)
  must(h.cellPillClass(tr, "status").includes("orange"), `字面「本人已完成」该是橙胶囊，实际 ${h.cellPillClass(tr, "status")}`)

  h.openPicker(tr, "status")
  const picker = h.pickerOf(tr, "status")
  const items = picker.childNodes[0].childNodes
  const texts = items.map(n => n.childNodes[0]?.textContent ?? n.textContent)
  const self = items.find(n => (n.childNodes[0]?.textContent ?? n.textContent) === "本人已完成")
  must(self, `下拉里没有这一格的当前值「本人已完成」：${JSON.stringify(texts)}（当前值无处可点、也打不上勾）`)
  must(self.className.includes("on"), "「本人已完成」那一项没被打上勾（看着像没存上）")
  must(texts.includes("甲"), `昵称「甲」已经在候选里，不该被收掉：${JSON.stringify(texts)}`)

  /** 点开看一眼不该把这一格弄脏（这一格没有任何改动，保存请求就不该发） */
  h.openPicker(tr, "status")
  must(!h.pickerOpen(tr, "status"), "再点一次浮层该收起来")
  must(h.cellText(tr, "status") === "本人已完成", `这一格被改了：${JSON.stringify(h.cellText(tr, "status"))}`)
  await h.autoSave()
  must(h.posts("api/save").length === 0, "只是点开下拉看了一眼，不该产生保存请求（这一格没有改动）")
})

await check("下拉浮层的几何：限高落在视口里，底部「＋ 收录新名字」不被候选的滚动裁掉", async () => {
  /**
   * 实测过（headless 浏览器，真实 CSS）：10 个候选 + 底行自然高 449px，浮层上限 220px。
   * 单元格贴着视口下沿时，旧算法写 `max(96, min(cap, below))`，那个 96 的下限把浮层顶到
   * 屏幕外面（fixed 元素顶出去就是点不到、也滚不到）；而底行作为 `.picker` 的最后一个子节点，
   * 位置直接落到浮层可见区域之外（量到 top 650、浮层 244~464），主人点不到「收录」。
   * 这条同时钉两件事：浮层整体在视口内、底行在"候选滚动层"外面（常驻浮层底部）。
   */
  const h = boot()
  await h.ready()
  const tr = h.rowNo(10)
  /** 单元格贴着视口下沿：下面只剩 48px，而候选 + 底行要 180px */
  const td = h.document.createElement("td")
  td.getBoundingClientRect = () => ({ top: 514, bottom: 540, left: 100, right: 400, width: 300, height: 26 })
  h.probe.pillsInput(td, 99, FIELDS.find(f => f.key === "status"), "排队中", false, "甲")
  const box = td.childNodes[0]
  const picker = td.childNodes[1]
  const add = box.childNodes.find(n => n.className.includes("addbtn"))
  must(add, "这一格没有「＋」按钮")
  add.onclick({ stopPropagation() {} })
  must(picker.classList.contains("open"), "浮层没打开")

  const rect = rectOf(picker)
  must(rect.top >= 0 && rect.bottom <= VP.h, `浮层被顶出视口：top=${rect.top} bottom=${rect.bottom}（视口高 ${VP.h}）`)
  must(rect.bottom - rect.top <= 48, `限高没有夹到下面真正可用的 48px：高 ${rect.bottom - rect.top}`)

  const inner = picker.childNodes[0]
  const addname = picker.childNodes.find(n => n.className.includes("addname"))
  must(addname, "管理员的完成情况下拉里没有「＋ 收录新名字」")
  must(addname === picker.childNodes[picker.childNodes.length - 1], "底行不再常驻浮层底部了（放到了候选滚动层里面）")
  /** 浮层能看见的内容底边 = 上边 + 内边距 + 被 max-height 夹住之后的候选/底行高度 */
  const innerH = Math.min(px(picker.style.maxHeight) || contentH(picker), contentH(picker))
  const contentBottom = rect.top + PAD + innerH
  const addnameBottom = rect.top + PAD + naturalH(inner) + naturalH(addname)
  must(addnameBottom <= contentBottom, `「＋ 收录新名字」落到候选滚动区之外（浮层内容底 ${contentBottom} < 底行底 ${addnameBottom}）`)

  /** 视口再矮一点（上面也放不下整个浮层）：两边都不满时也得落在视口里，不许被 96 的下限顶出去 */
  VP.h = 300
  td.getBoundingClientRect = () => ({ top: 250, bottom: 276, left: 100, right: 400, width: 300, height: 26 })
  picker.classList.remove("open")
  add.onclick({ stopPropagation() {} })
  const rect2 = rectOf(picker)
  must(rect2.top >= 0 && rect2.bottom <= VP.h, `矮视口下浮层被顶出视口：top=${rect2.top} bottom=${rect2.bottom}（视口高 ${VP.h}）`)
  VP.h = 600
})

console.log(failed ? `\n❌ 前端草稿状态验证失败 ${failed} 项` : "\n✅ 前端草稿状态验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
