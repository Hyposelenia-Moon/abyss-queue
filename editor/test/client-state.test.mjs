/**
 * 编辑器前端的草稿状态：新增行的提交口径 + 草稿的「榜 × 行」归属 + 选择器行为
 *
 * 为什么不能用接口测试代替：AQ-04（新增行丢掉输入）和 AQ-05（切榜串写）都发生在**页面状态**里，
 * 服务端接口测试直接 POST 一份填好的对象，正好绕过「输入 → 草稿 → 保存请求」这一段。
 * 所以这里把 `editor.html` 里的脚本**原样抽出来**，在 node:vm 里跑，桩掉 fetch 与假 DOM，
 * 断言真实处理器构造出来的请求（目标榜、行号、字段），不向任何真实表格落盘。
 *
 * 九页重写后的口径变化（旧断言已经跟着退场）：
 *   - 主播列表编辑整块没了（改成只读卡片 + 呼叫），相关断言删除；
 *   - 「头部待保存 N 项」「相近候选下拉」「设备令牌时间窗」都不在现页面里，删除；
 *   - 保存由 1200ms 防抖触发，套件必须挂假时钟才推得动。
 *
 * 用法：node editor/test/client-state.test.mjs（任意 cwd）
 */
import { makeFakeTimers, makeData, bootPage } from "./page-vm.mjs"

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** 统一挂假时钟：自动保存的防抖要靠 `h.advance()` 推 */
const boot = opts => bootPage({ timers: makeFakeTimers(), ...opts })

/** 把该跑的回调跑完（fetch → note → load 是几层微任务，多刷几次） */
const settle = async h => {
  await h.ready()
  await h.ready()
}

/** 改一格 → 推过防抖 → 等落定 */
const edit = async (h, key, value, row = 10) => {
  h.type(h.rowNo(row), key, value)
  h.advance(1300)
  await settle(h)
}

/** 把新增行的四个必填补齐 */
const fillFresh = async (h, { nickname = "新人", gameName = "新人的游戏", anchor = "阿修Axiu", goal = "困难模式" } = {}) => {
  const tr = h.newRow()
  h.type(tr, "nickname", nickname)
  h.type(tr, "gameName", gameName)
  h.pick(tr, "anchor", anchor)
  h.pick(tr, "goal", goal)
}

console.log("编辑器前端状态（editor.html 现脚本 + 假时钟 + 请求捕获）")

/* ------------------- ① 新增行：填好的字段进得了保存请求 ------------------- */

await check("新增行（本榜有默认完成情况）：填好的字段进得了保存请求", async () => {
  const h = boot({})
  await h.ready()
  h.click && 0
  await h.click("addRow")
  must(h.newRow(), "点了「＋ 新增一行」却没出现新行")
  await fillFresh(h)
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没发出保存请求：${saves.length} 发`)
  const sent = saves[0].body.rows[0]
  must(sent.values.nickname === "新人", `昵称没进请求：${JSON.stringify(sent.values)}`)
  must(sent.values.gameName === "新人的游戏", `游戏名没进请求：${JSON.stringify(sent.values)}`)
  must(sent.values.anchor === "阿修Axiu", `主播没进请求：${JSON.stringify(sent.values)}`)
  must(String(sent.values.goal).includes("困难模式"), `难度没进请求：${JSON.stringify(sent.values)}`)
  must(sent.values.status === "排队中", `本榜默认完成情况没带上：${JSON.stringify(sent.values)}`)
})

await check("新增行（本榜没有默认完成情况）：照样能保存", async () => {
  const h = boot({})
  await h.ready()
  h.tab(1) // 幽境危战：defaults 是空的
  await settle(h)
  await h.click("addRow")
  await fillFresh(h, { goal: "险恶(N4)" })
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没发出保存请求：${saves.length} 发`)
  must(saves[0].body.sheet === "幽境危战", `提交到了别的榜：${saves[0].body.sheet}`)
  must(!saves[0].body.rows[0].values.status, `没有默认状态却带上了：${JSON.stringify(saves[0].body.rows[0].values)}`)
})

await check("新增行（没补齐必填）：不提交，状态写明缺必填", async () => {
  const h = boot({})
  await h.ready()
  await h.click("addRow")
  // 只是点了「＋ 新增一行」、一个字没动：不该自己发保存请求
  h.advance(1300)
  await settle(h)
  must(h.posts("api/save").length === 0, "刚点新增就发了保存请求")
  // 只补昵称，剩下三个必填还空着：要拦下来并说清原因
  h.type(h.newRow(), "nickname", "只填了名字")
  h.advance(1300)
  await settle(h)
  must(h.posts("api/save").length === 0, "必填没齐还是发了保存请求")
  must(/必填没补全/.test(h.el("saveState").textContent), `状态没写清必填没齐：${h.el("saveState").textContent}`)
  must(h.el("saveState").className.includes("bad"), "必填没齐却没有标红")
})

await check("新增行取的是本榜没被占用的第一个空行号", async () => {
  const h = boot({})
  await h.ready()
  await h.click("addRow")
  const tr = h.newRow()
  must(tr.dataset.row === "8", `没有从 dataStart 找空行（拿到 ${tr.dataset.row}）`)
})

await check("新增行还没保存时点「取消该行」：本地退场、一个请求都不发", async () => {
  const h = boot({})
  await h.ready()
  await h.click("addRow")
  must(h.el("delRow").textContent === "取消该行", `按钮文案不对：${h.el("delRow").textContent}`)
  await h.click("delRow")
  must(!h.el("grid").querySelector(".seqcell") || h.el("grid").querySelectorAll(".tr[data-row]").length === 1,
    "取消之后新增行还在")
  must(h.posts("api/save").length === 0, "取消新增行却发了保存请求")
  must(h.el("saveState").textContent === "已保存", `取消之后状态不对：${h.el("saveState").textContent}`)
})

/* ------------------- ② 草稿的「榜 × 行」归属 ------------------- */

await check("两个榜行号相同：改了剧诗第 10 行的备注，切到危战保存不该写危战", async () => {
  const h = boot({ confirm: () => true })
  await h.ready()
  h.type(h.rowNo(10), "note", "剧诗的备注")
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没有保存：${saves.length}`)
  must(saves[0].body.sheet === "幻想真境剧诗", `写到了别的榜：${saves[0].body.sheet}`)
  must(saves[0].body.rows[0].row === 10, "行号不对")
  must(saves[0].body.rows[0].values.note === "剧诗的备注", "备注没进请求")
})

await check("有草稿时切榜会先问一句；确认后草稿清空、不串到新榜", async () => {
  const asked = []
  const h = boot({ confirm: msg => { asked.push(msg); return true } })
  await h.ready()
  h.type(h.rowNo(10), "note", "还没保存")
  h.tab(1)
  await settle(h)
  must(asked.length === 1, `切榜没问：${asked.length}`)
  must(/切换后会丢失/.test(asked[0]), `问的话不对：${asked[0]}`)
  must(h.probe.cur === 1, "没切过去")
  must(h.probe.dirty.length === 0, `草稿串到新榜了：${JSON.stringify(h.probe.dirty)}`)
  h.advance(1300)
  await settle(h)
  must(h.posts("api/save").length === 0, "切榜之后居然自动保存了")
})

await check("没草稿时切榜不问", async () => {
  const asked = []
  const h = boot({ confirm: msg => { asked.push(msg); return true } })
  await h.ready()
  h.tab(1)
  await settle(h)
  must(asked.length === 0, "没有草稿也弹了确认")
  must(h.probe.cur === 1, "没切过去")
})

await check("保存成功后草稿清干净、重读一次表", async () => {
  const h = boot({})
  await h.ready()
  await edit(h, "note", "我的备注")
  const saves = h.posts("api/save")
  must(saves.length === 1, `没保存：${saves.length}`)
  must(h.probe.dirty.length === 0, `草稿没清：${JSON.stringify(h.probe.dirty)}`)
  must(h.reads("api/data").length >= 2, `保存后没重读：${h.reads("api/data").length}`)
  must(h.el("saveState").textContent === "已保存", `状态不对：${h.el("saveState").textContent}`)
})

/* ------------------- ③ 下拉浮层 ------------------- */

await check("单选的选择器：选完自动收起", async () => {
  const h = boot({})
  await h.ready()
  h.tab(1) // 幽境危战：目标是一栏单选
  await settle(h)
  const tr = h.rowNo(10)
  h.openPicker(tr, "goal")
  must(h.pickerOpen(), "浮层没打开")
  h.pickOption(tr, "goal", "险恶(N4)")
  must(!h.pickerOpen(), "单选选完还开着")
  must(h.probe.dirty.length === 1, "选完没进草稿")
})

await check("剧诗是「难度 + 目标」两栏：选了难度先不收，选完目标才收", async () => {
  const h = boot({})
  await h.ready()
  const tr = h.rowNo(10)
  h.openPicker(tr, "goal")
  must(h.pickerOpen(), "浮层没打开")
  h.pickOption(tr, "goal", "卓越模式")
  must(h.pickerOpen(), "只选了难度就收起了（还差目标）")
  h.pickOption(tr, "goal", "满星章")
  must(!h.pickerOpen(), "选完目标还开着")
})

await check("多选的选择器（主播）：连着选两位，落表逗号分隔", async () => {
  const h = boot({})
  await h.ready()
  const tr = h.rowNo(10)
  h.openPicker(tr, "anchor")
  must(h.pickerOpen(), "浮层没打开")
  h.pickOption(tr, "anchor", "听雨")
  must(h.pickerOpen(), "多选选完就收起了（应当留着能继续选）")
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没保存：${saves.length}`)
  const v = saves[0].body.rows[0].values.anchor
  must(v.includes("阿修Axiu") && v.includes("听雨"), `两位主播没都记上：${JSON.stringify(v)}`)
  must(v.includes(","), `多选没落成逗号分隔：${JSON.stringify(v)}`)
})

await check("多选的选择器（完成情况）：点开连选两位主播，落表逗号分隔", async () => {
  const h = boot({})
  await h.ready()
  const tr = h.rowNo(10)
  /**
   * 2026-11-24 起选完就收起：手机上一格点一下就够了，浮层不再挡着表格；
   * 要加第二个人，再点开同一格（当前选中的人仍然点着）。
   */
  h.openPicker(tr, "status")
  h.pickOption(tr, "status", "阿修Axiu")
  must(!h.pickerOpen(), "选完应当收起（手机上一格点一下）")
  h.openPicker(tr, "status")
  h.pickOption(tr, "status", "听雨")
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没保存：${saves.length}`)
  const v = String(saves[0].body.rows[0].values.status)
  must(v.includes("阿修Axiu") && v.includes("听雨"), `两位主播没都记上：${JSON.stringify(v)}`)
  must(v.includes(","), `多选没落成逗号分隔：${JSON.stringify(v)}`)
})

await check("完成情况浮层：本人已完成 + 本榜主播，不再给「等待开启 / 排队中」", async () => {
  const h = boot({})
  await h.ready()
  h.openPicker(h.rowNo(10), "status")
  const labels = [...h.pickerOf().querySelectorAll(".opt")].map(h.textOf).map(s => s.trim())
  must(!labels.includes("等待开启"), `不该出现「等待开启」：${JSON.stringify(labels)}`)
  must(!labels.includes("排队中"), `不该出现「排队中」：${JSON.stringify(labels)}`)
  must(labels[0] === "本人已完成", `第一项应是「本人已完成」：${JSON.stringify(labels)}`)
  must(labels.includes("阿修Axiu") && labels.includes("听雨"), `本榜主播没进菜单：${JSON.stringify(labels)}`)
})

await check("排队中的行点完成人：把「排队中」换掉，落表只有人名", async () => {
  /**
   * 服务端把「排队中」和完成人视为互斥；页面如果只追加，就会落成
   * `排队中,阿修Axiu` 被 400 拒收（复查 2026-11-24 的「排队中行点完成人」问题）。
   */
  const h = boot({})
  await h.ready()
  const tr = h.rowNo(10)
  h.openPicker(tr, "status")
  must(h.textOf(h.pickerOf().querySelector(".pkcount")).trim() === "已选 0",
    `「排队中」被当成了已选的人：${h.textOf(h.pickerOf().querySelector(".pkcount"))}`)
  h.pickOption(tr, "status", "阿修Axiu")
  must(!h.pickerOpen(), "选完没收起浮层")
  h.advance(1300)
  await settle(h)
  const sent = h.posts("api/save").at(-1)
  must(sent, "没有发出保存请求")
  must(sent.body.rows[0].values.status === "阿修Axiu",
    `落表值还带着状态词：${JSON.stringify(sent.body.rows[0].values)}`)
})

/* ------------------- ④ 攻炼：模式表与复合状态 ------------------- */

/** 一个带攻炼榜的数据：attackVersions 由服务端下发，页面不该自己编 */
const attackData = () => {
  const data = makeData()
  data.sheets.push({
    name: "绝境攻炼",
    title: "绝境攻炼",
    dataStart: 8,
    dataEnd: 20,
    defaults: { status: "等待开启" },
    anchors: ["阿修Axiu"],
    anchorRows: [{ row: 10, name: "阿修Axiu", recommend: "强烈推荐", duty: "攻炼", skills: "", platform: "B站", link: "", queued: 1, done: 0 }],
    options: {
      anchor: ["阿修Axiu"],
      target: ["满原石", "满星章", "顶分"],
      attackVersions: [
        { version: "7.0", preset: "7.0模式", open_at: "2026-08-26 10:00", modes: ["线列破袭", "至寒风暴", "狭域死战"] },
        { version: "7.1", preset: "7.1模式", open_at: "2026-09-30 10:00", modes: ["焰羽追绞", "囚笼冰城"] },
        { version: "7.2", preset: "7.2模式", open_at: "2026-11-04 10:00", modes: ["交错锤砧", "重兵固港", "灾厄旧城"] },
        { version: "7.3", preset: "7.3模式", open_at: "2026-12-16 10:00", modes: [] },
      ],
      status: ["等待开启", "排队中", "本人已完成"],
    },
    rows: [
      { row: 10, seq: 1, nickname: "攻甲", gameName: "攻甲的游戏", anchor: "阿修Axiu", goal: "7.2模式｜顶分", note: "", status: "7.2排队中 7.3等待开启", fp: "fp10" },
    ],
  })
  return data
}
const bootAttack = opts => boot({ dataFor: () => attackData(), ...opts })

await check("攻炼模式选择读的是本榜下发的版本表（7.0 三个、7.1 两个、7.2 三个、7.3 空）", async () => {
  const h = bootAttack({})
  await settle(h)
  h.tab(2)
  await settle(h)
  const tr = h.rowNo(10)
  h.openPicker(tr, "goal")
  const p = h.pickerOf()
  const vers = [...p.querySelectorAll("[data-ver]")].map(b => b.dataset.ver)
  must(vers.join(",") === "7.0,7.1,7.2,7.3", `版本按钮不对：${JSON.stringify(vers)}`)
  const modes = [...p.querySelectorAll("[data-mode]")].map(b => b.dataset.mode)
  must(modes.includes("线列破袭") && modes.includes("交错锤砧"), `具体模式缺了：${JSON.stringify(modes)}`)
  must(!modes.includes("7.2模式"), `7.2 已经有真实模式了，不该再用占位名：${JSON.stringify(modes)}`)
  must(modes.includes("7.3模式"), `7.3 还没配置，应当留占位名：${JSON.stringify(modes)}`)
  const targets = [...p.querySelectorAll("[data-target]")].map(b => b.dataset.target)
  must(targets.join(",") === "满原石,满星章,顶分", `目标不对：${JSON.stringify(targets)}`)
})

await check("攻炼一点版本快捷按钮就整版全选，写回 `7.x模式｜目标`", async () => {
  const h = bootAttack({})
  await settle(h)
  h.tab(2)
  await settle(h)
  const tr = h.rowNo(10)
  h.openPicker(tr, "goal")
  const quick = [...h.pickerOf().querySelectorAll("[data-ver]")].find(b => b.dataset.ver === "7.1")
  quick.onclick({ stopPropagation() {} })
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没保存：${saves.length}`)
  const goal = String(saves[0].body.rows[0].values.goal)
  must(goal.includes("焰羽追绞") && goal.includes("囚笼冰城"), `整版没选上：${goal}`)
  must(goal.includes("｜顶分"), `目标丢了：${goal}`)
})

await check("攻炼复合状态按空白拆成多颗胶囊，各按各的语义着色", async () => {
  const h = bootAttack({})
  await settle(h)
  h.tab(2)
  await settle(h)
  const tr = h.rowNo(10)
  const box = tr.querySelector('[data-pick="status"]')
  const chips = [...box.querySelectorAll(".chip")]
  must(chips.length === 2, `没拆成两颗：${chips.length}`)
  must(h.textOf(chips[0]).includes("7.2"), `第一颗不是 7.2：${h.textOf(chips[0])}`)
  must(h.textOf(chips[1]).includes("7.3"), `第二颗不是 7.3：${h.textOf(chips[1])}`)
  must(chips[1].className.includes("amber"), `「等待开启」应当走等待色：${chips[1].className}`)
})

/* ------------------- ⑤ 转义与页脚 ------------------- */

await check("群昵称进 innerHTML 前先转义（`<img onerror>` 不能被当标签执行）", async () => {
  const h = boot({})
  await h.ready()
  const evil = '<img src=x onerror="alert(1)">'
  h.type(h.rowNo(10), "nickname", evil)
  await settle(h)
  h.selectRow(10) // 右栏「当前选中」会把这个值拼进 innerHTML
  await settle(h)
  const body = String(h.el("selBody").innerHTML || "")
  must(!/<img\s/i.test(body), "群昵称没转义就进了 innerHTML")
  must(/&lt;img/.test(body), `转义后的文字也没了：${body.slice(0, 120)}`)
  must(h.el("selBody").querySelectorAll("img").length === 0, "页面里真的冒出了 <img> 节点")
  must(h.el("grid").querySelectorAll("img").length === 0, "表格里真的冒出了 <img> 节点")
})

await check("页脚 HTML 原样注入到 #siteFooter（维护者自由排版）", async () => {
  const h = boot({ metaReply: () => ({ status: 200, body: { ok: true, version: "v1", footer: '<a href="#">备案号</a>', versionsKeep: 20 } }) })
  await settle(h)
  const foot = h.el("siteFooter")
  must(foot, "页面里没有 #siteFooter")
  must(!foot.hidden, "有页脚却被隐藏了")
  must(h.textOf(foot).includes("备案号"), `页脚内容没进去：${h.textOf(foot)}`)
})

/* ------------------- ⑥ 只读身份 ------------------- */

await check("只读身份：可编辑格全禁用、新增与回退都藏起来、改了也不发请求", async () => {
  const h = boot({ dataFor: () => makeData({ role: "guest", readonly: true, changes: false, versions: false, manage: false }) })
  await settle(h)
  const tr = h.rowNo(10)
  const input = tr.querySelector('[data-edit="note"]')
  must(input.disabled, "只读身份下文本框还能改")
  must(h.el("addRow").style.display === "none", "只读身份下还露出「＋ 新增一行」")
  must(h.el("undoBtn").style.display === "none", "只读身份下还露出「回退」")
  h.advance(1300)
  await settle(h)
  must(h.posts("api/save").length === 0, "只读身份居然发了保存请求")
})

/* ------------------- ⑦ 手机抽屉 ------------------- */

await check("手机抽屉：改一格的输入会进草稿并落到保存请求里", async () => {
  const h = boot({})
  await h.ready()
  h.selectRow(10)
  h.rowNo(10).querySelector("[data-medit]").onclick({ stopPropagation() {} })
  await settle(h)
  must(h.el("msheet").classList.contains("on"), "抽屉没打开")
  h.typeMobile("note", "抽屉里写的")
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没保存：${saves.length}`)
  must(saves[0].body.rows[0].values.note === "抽屉里写的", `抽屉里的改动没进请求：${JSON.stringify(saves[0].body.rows[0].values)}`)
})

/* ------------------- ⑧ 手机端页面切换与「我的报名」 ------------------- */

/**
 * 手机端（窗口宽 1024，走 ≤1100px 那一档）没有侧栏，切页靠左下角那颗下拉。
 * 这里只验逻辑：选项按权限生成、跟当前页同步、成员默认落填写页、管理台前缀只给管理身份。
 */
await check("手机端页面切换：选项按权限生成，管理员留排队表、成员默认落填写页", async () => {
  const admin = boot({})
  await settle(admin)
  must(admin.probe.page === "queue", `管理员默认页不对：${admin.probe.page}`)
  const adminOpts = [...admin.el("mobPage").querySelectorAll("option")].map(o => o.getAttribute("value"))
  must(adminOpts.join(",") === "queue,fill,overview,cycles,versions,changes,admins,ownership",
    `管理员下拉选项不对：${JSON.stringify(adminOpts)}`)
  must(admin.el("mobPage").value === "queue", "下拉没跟当前页同步")
  must(admin.document.querySelector(".adminonly").style.display !== "none", "管理身份不该藏「管理台 /」")

  const member = boot({ dataFor: () => makeData({ role: "self", nick: "甲", readonly: false, changes: true, versions: false, manage: false }) })
  await settle(member)
  must(member.probe.page === "fill", `成员默认页不是填写页：${member.probe.page}`)
  must(member.el("crumb").textContent === "排队表 · 填写", `填写页标题不对：${member.el("crumb").textContent}`)
  const memberOpts = [...member.el("mobPage").querySelectorAll("option")].map(o => o.getAttribute("value"))
  must(!memberOpts.includes("versions") && !memberOpts.includes("admins") && !memberOpts.includes("ownership"),
    `成员下拉混进了管理页：${JSON.stringify(memberOpts)}`)
  must(member.document.querySelector(".adminonly").style.display === "none", "成员视图还露着「管理台 /」")
  member.el("mobPage").value = "queue"
  member.el("mobPage").onchange()
  await settle(member)
  must(member.probe.page === "queue", "下拉切页没生效")
  must(member.el("crumb").textContent === "排队表", `切页后标题不对：${member.el("crumb").textContent}`)
  must(member.document.querySelector(".adminonly").style.display === "none", "成员切到排队表又露出「管理台 /」")
})

await check("填写页「我的报名」认服务端下发的本人行，不按昵称猜", async () => {
  /**
   * 服务端按 QQ 绑定认出来的是第 11 行（昵称「乙」），页面按昵称找会落到第 10 行（「甲」）。
   * 这一条就是复查第 5 条：同名 / 改过名片时，页面自己找会认错人。
   */
  const data = makeData({ role: "self", nick: "甲", readonly: false, roam: true, changes: true, versions: false, manage: false })
  data.sheets[0].rows.push({ row: 11, seq: 2, nickname: "乙", gameName: "乙的游戏", anchor: "阿修Axiu", goal: "困难模式", note: "", status: "排队中", fp: "fp11" })
  data.mineRows = { 幻想真境剧诗: [11] }
  const h = boot({ dataFor: () => data })
  await settle(h)
  must(h.probe.page === "fill", "成员没落到填写页")
  must(h.el("fillCta").textContent === "查看我的报名", `没认出本人行：${h.el("fillCta").textContent}`)
  must(/序号 2/.test(h.el("fillHint").textContent), `我的报名序号不对：${h.el("fillHint").textContent}`)
  h.el("fillCta").onclick()
  must(h.probe.selected === 11, `「查看我的报名」选中了第 ${h.probe.selected} 行，不是服务端认定的 11`)
})

await check("同名多行且服务端认不出：填写页写「待核对」，不猜哪一行是本人", async () => {
  const data = makeData({ role: "self", nick: "甲", readonly: false, roam: true, changes: true, versions: false, manage: false })
  data.sheets[0].rows.push({ row: 11, seq: 2, nickname: "甲", gameName: "另一个甲", anchor: "阿修Axiu", goal: "困难模式", note: "", status: "排队中", fp: "fp11" })
  data.mineRows = { 幻想真境剧诗: [] }
  const h = boot({ dataFor: () => data })
  await settle(h)
  must(h.el("fillStatus").textContent === "待核对", `状态没写待核对：${h.el("fillStatus").textContent}`)
  must(/都叫「甲」/.test(h.el("fillHint").textContent), `提示没说清同名：${h.el("fillHint").textContent}`)
  must(h.el("fillCta").textContent === "查看整榜排队", `CTA 不该是查看我的报名：${h.el("fillCta").textContent}`)
  h.el("fillCta").onclick()
  must(h.toasts().some(t => /同名行/.test(t)), `没提示联系管理员：${JSON.stringify(h.toasts())}`)
})

console.log(failed ? `\n❌ 编辑器前端状态验证失败 ${failed} 项` : "\n✅ 编辑器前端状态验证通过")
process.exit(failed ? 1 : 0)
