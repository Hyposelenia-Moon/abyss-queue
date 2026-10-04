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

  const ctx = {
    document,
    window: { addEventListener() {} },
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
  h.type(tr, "anchor", "阿修Axiu")
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
  h.type(tr, "anchor", "阿修Axiu")
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
  h.type(tr, "anchor", "听雨")
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

  /** 回到剧诗：它的草稿没被保存过，必须还在（以前 load() 会把所有草稿一起清掉） */
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
  h.type(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")
  /** 界面之外再把 newRow 造的种子写满：以前保存只提交这个种子，
   *  不写满的话旧代码会先倒在必填校验上，就测不到"按榜筛选"这一条了 */
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

console.log(failed ? `\n❌ 前端草稿状态验证失败 ${failed} 项` : "\n✅ 前端草稿状态验证通过")
process.exit(failed ? 1 : 0)
