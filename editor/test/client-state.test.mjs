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
    /** 页面只在浮层定位时用一次；假 DOM 不排版，返回 null 让它走"不翻向"的分支 */
    closest: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    remove() {
      const at = el.parentNode?.childNodes.indexOf(el) ?? -1
      if (at >= 0) el.parentNode.childNodes.splice(at, 1)
    },
  }
  return el
}

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
function boot({ perm = { role: "admin", readonly: false }, data = makeData(perm) } = {}) {
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
  const jsonRes = payload => ({ status: 200, ok: true, json: async () => payload })
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
      addEventListener(type, fn) {
        ;(winListeners[type] ??= []).push(fn)
      },
    },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { search: "", pathname: "/editor" },
    history: { replaceState() {} },
    fetch: fetchStub,
    /** note() 里的自动消失计时器：不跑真的，免得进程被吊住 */
    setTimeout: () => 0,
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
      const opt = td.childNodes[1].childNodes.find(n => (n.childNodes[0]?.textContent ?? n.textContent) === option)
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
      const opt = picker.childNodes.find(n => (n.childNodes[0]?.textContent ?? n.textContent) === option)
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
  await h.click("save")

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
  await h.click("save")

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
  await h.click("save")

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
  await h.click("save")
  /** 全空对象提交上去 = 让后端清掉这一行；点了「＋」又反悔，应该什么都不发 */
  must(h.posts("api/save").length === 0, "没填任何内容却发了保存请求（这一行会被当成清空记录）")
})

/* ------------------------- AQ-05 切榜 ------------------------- */

await check("两个榜行号相同：改了剧诗第 10 行的备注，切到危战保存不该写危战", async () => {
  const h = boot()
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗第 10 行的备注")
  h.tab(1) // 切到危战（它也有第 10 行，但一个字都没改）
  await h.click("save")
  const posts = h.posts("api/save")
  must(posts.length === 0, `危战没有改动却发了保存请求：${JSON.stringify(posts[0]?.body)}`)
})

await check("保存成功后只清本次保存那一榜：另一榜没保存的备注还在", async () => {
  const h = boot()
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗的备注")
  h.tab(1)
  h.type(h.rowNo(10), "note", "危战的备注")
  await h.click("save")

  const first = onlySave(h)
  must(first.sheet === "危战", `先保存的应是危战，实际 ${first.sheet}`)
  must(first.rows.length === 1, `危战只有一行有改动，实际提交 ${first.rows.length} 行`)
  must(first.rows[0].values.note === "危战的备注", `危战第 10 行提交的是 ${JSON.stringify(first.rows[0].values.note)}`)
  must(first.rows[0].values.nickname === "乙", `危战第 10 行的其它字段被串改：${JSON.stringify(first.rows[0].values.nickname)}`)

  /** 回到剧诗：它的草稿没被保存过，必须还在（整表重读会按榜清掉这一榜的草稿，别的榜要留着） */
  h.tab(0)
  h.calls.length = 0
  await h.click("save")
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
  await h.click("save")
  const posts = h.posts("api/save")
  must(posts.length === 0, `危战没有改动，却把剧诗的新增行提交给了 ${posts[0]?.body.sheet}：${JSON.stringify(posts[0]?.body)}`)

  /** 回到剧诗，这一行还得提交得上（别为了"不串榜"把新增行整个丢掉） */
  h.tab(0)
  await h.click("save")
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
  await h.click("save")
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
  await h.click("save")
  must(h.posts("api/save").length === 0, "值改回原样还发了保存请求（会白写一次、白存一份版本）")
  const toast = h.document.getElementById("toast").childNodes.map(n => n.textContent).join(" ")
  must(/没有改动/.test(toast), `提示文案变了：${JSON.stringify(toast)}`)
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

  await h.click("save")
  const body = onlySave(h)
  const sent = String(body.rows[0].values.anchor)
  must(sent.includes("阿修Axiu") && sent.includes("听雨"), `落表的主播是 ${JSON.stringify(sent)}（应当同时有这两位）`)
  must(sent.includes(","), `多值应当用逗号分隔，实际 ${JSON.stringify(sent)}`)
})

await check("完成情况的下拉：「本人已完成」与本人昵称不再同时出现（重复名字）", async () => {
  const optionTexts = (hh, tr, key) =>
    hh.pickerOf(tr, key).childNodes.map(n => n.childNodes[0]?.textContent ?? n.textContent)

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

console.log(failed ? `\n❌ 前端草稿状态验证失败 ${failed} 项` : "\n✅ 前端草稿状态验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
