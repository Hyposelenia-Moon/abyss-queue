/** 编辑器前端的草稿状态：新增行的提交口径 + 草稿的「榜 × 行」归属 + 选择器行为 */
import { makeFakeTimers, makeData, bootPage } from "./page-vm.mjs"
import { stripScripts } from "./strip.mjs"
import { createSoftChecker, must } from "../../test/_helper.mjs"

const { check, finish } = createSoftChecker("编辑器前端状态验证")

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

await check("假 DOM 剥内联脚本：`</script >`、`</script\\t\\n bar>` 这类闭合写法也认", () => {
  must(stripScripts("<script>window.x=1</script ><p>留</p>") === "<p>留</p>", "带空格的闭合标签没剪掉")
  must(stripScripts("<script>window.x=1</script\t\n bar><p>留</p>") === "<p>留</p>", "带属性的闭合标签没剪掉")
  must(stripScripts("<script>a</script>") === "", "普通闭合标签没剪掉")
})

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

await check("剧诗的目标只有「满原石 / 满星章」，不给攻炼那套「顶分」", async () => {
  const h = boot({})
  await h.ready()
  const tr = h.rowNo(10)
  h.openPicker(tr, "goal")
  const targets = [...h.pickerOf().querySelectorAll("[data-target]")].map(b => b.dataset.target)
  must(targets.join(",") === "满原石,满星章", `剧诗目标不对：${JSON.stringify(targets)}`)
})

await check("剧诗两栏选完落表的是「卓越模式满星章」，不带 ｜（表里的下拉没有分隔符）", async () => {
  const h = boot({})
  await h.ready()
  const tr = h.rowNo(10)
  h.pick(tr, "goal", "卓越模式满星章")
  h.advance(1300)
  await settle(h)
  const saves = h.posts("api/save")
  must(saves.length === 1, `没保存：${saves.length}`)
  const goal = String(saves[0].body.rows[0].values.goal)
  must(goal === "卓越模式满星章", `落表写法不对：${goal}`)
  must(!goal.includes("｜"), `还带着全角分隔符：${goal}`)
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
  // 2026-11-24 起选完就收起：手机上一格点一下就够了，浮层不再挡着表格；
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
  // 服务端把「排队中」和完成人视为互斥；页面如果只追加，就会落成
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

await check("esc 连单引号一起转义（`&#39;`：将来拼进单引号属性 / 内联脚本也不会断句）", async () => {
  const h = boot({})
  await h.ready()
  h.type(h.rowNo(10), "nickname", "O'Brien")
  await settle(h)
  h.selectRow(10) // 右栏「当前选中」把这个值拼进 innerHTML
  await settle(h)
  const body = String(h.el("selBody").innerHTML || "")
  must(body.includes("O&#39;Brien"), `单引号没有转义：${body.slice(0, 160)}`)
  must(!body.includes("O'Brien"), "原始单引号还在 innerHTML 里")
  must(h.textOf(h.el("selBody")).includes("O'Brien"), `显示出来变成别的字了：${h.textOf(h.el("selBody")).slice(0, 80)}`)
})

await check("页脚 HTML 原样注入到 #siteFooter（维护者自由排版）", async () => {
  const h = boot({ metaReply: () => ({ status: 200, body: { ok: true, version: "v1", footer: '<a href="#">备案号</a>', versionsKeep: 20 } }) })
  await settle(h)
  const foot = h.el("siteFooter")
  must(foot, "页面里没有 #siteFooter")
  must(!foot.hidden, "有页脚却被隐藏了")
  must(h.textOf(foot).includes("备案号"), `页脚内容没进去：${h.textOf(foot)}`)
})

/* ------------------- ⑤b 群昵称候选与左下角头像 ------------------- */

await check("群昵称候选：聚焦摆名单、打字实时筛、点一下填入", async () => {
  const data = makeData()
  /** 纯符号名片不该进候选（填进去也没法用） */
  data.roster.candidates = ["随伦", "听雨", "拾起那梦与忆", "小伙01", "（，）"]
  const h = boot({ dataFor: () => data })
  await settle(h)
  const inp = h.rowNo(10).querySelector('[data-edit="nickname"]')
  /** 有值时先按现值筛（`甲` 在名单里找不到相近的 ⇒ 给"没有相近的群昵称"） */
  inp.onfocus()
  const box = h.el("nickpick")
  must(box.classList.contains("open"), "聚焦后没打开群昵称候选")
  must(h.textOf(box).includes("没有相近的群昵称"), `有值时应当只找相近的：${h.textOf(box)}`)
  /** 清空才摆整份名单（前 8 个） */
  inp.value = ""
  inp.onfocus()
  const names = [...box.querySelectorAll("[data-nick]")].map(b => b.dataset.nick)
  must(names.join("|") === "随伦|听雨|拾起那梦与忆|小伙01", `候选不对（纯符号要被跳过）：${names.join("|")}`)
  must(h.textOf(box).includes("共 4 人"), `没写总人数：${h.textOf(box)}`)
  inp.value = "听"
  inp.oninput()
  const hits = [...box.querySelectorAll("[data-nick]")].map(b => b.dataset.nick)
  must(hits.length === 1 && hits[0] === "听雨", `前缀筛出来不对：${hits.join("|")}`)
  box.querySelector("[data-nick]").onclick({ stopPropagation() {} })
  must(inp.value === "听雨", `点了没填进去：${inp.value}`)
  must(!box.classList.contains("open"), "点完候选没收起")
  must(h.probe.dirty.length === 1, `填入后没进草稿：${JSON.stringify(h.probe.dirty)}`)
})

await check("群昵称候选：↑↓ 移动高亮、Enter 填入、Esc 收起，清空输入自动收", async () => {
  const data = makeData()
  data.roster.candidates = ["随伦", "听雨"]
  const h = boot({ dataFor: () => data })
  await settle(h)
  const inp = h.rowNo(10).querySelector('[data-edit="nickname"]')
  const box = h.el("nickpick")
  inp.value = ""
  inp.onfocus()
  inp.onkeydown({ key: "ArrowDown", preventDefault() {} })
  const kbd = box.querySelector(".opt.kbd")
  must(kbd && kbd.dataset.nick === "随伦", `↓ 没落到第一个候选：${kbd && kbd.dataset.nick}`)
  inp.onkeydown({ key: "ArrowDown", preventDefault() {} })
  must(box.querySelector(".opt.kbd")?.dataset.nick === "听雨", "再按 ↓ 没往下走")
  inp.onkeydown({ key: "Enter", preventDefault() {} })
  must(inp.value === "听雨", `Enter 没填入：${inp.value}`)
  must(!box.classList.contains("open"), "Enter 填完没收起")
  inp.value = ""
  inp.oninput()
  must(!box.classList.contains("open"), "输入清空后候选该自动收起")
  inp.onfocus()
  inp.onkeydown({ key: "Escape", preventDefault() {} })
  must(!box.classList.contains("open"), "Esc 没收起")
})

await check("群昵称候选：名单是按需重取的（群里改了名片，开着页面也能选到）", async () => {
  const data = makeData()
  data.roster.candidates = ["随伦"]
  const h = boot({ dataFor: () => data })
  await settle(h)
  const before = h.reads("api/data").length
  /** 群里刚改了名片：服务端每次都重读名单文件，这里模拟下一次 /api/data 带回新名单 */
  data.roster.candidates = ["随伦", "改了名字的人"]
  const inp = h.rowNo(10).querySelector('[data-edit="nickname"]')
  inp.value = ""
  inp.onfocus()
  await settle(h)
  const box = h.el("nickpick")
  const names = [...box.querySelectorAll("[data-nick]")].map(b => b.dataset.nick)
  must(names.includes("改了名字的人"), `候选没跟着名单刷新：${names.join("|")}`)
  must(h.reads("api/data").length > before, "打开候选时没重取名单")
  /** 一分钟内再开不重复请求（整群一百多人，别每次聚焦都打一次接口） */
  const after = h.reads("api/data").length
  inp.onfocus()
  await settle(h)
  must(h.reads("api/data").length === after, "60 秒内重复请求了名单")
})

await check("群昵称候选：只读身份不给候选（那是整群名片，改不了就别摆出来）", async () => {
  const data = makeData({ role: "guest", readonly: true, changes: false, versions: false, manage: false })
  data.roster.candidates = ["随伦"]
  const h = boot({ dataFor: () => data })
  await settle(h)
  const inp = h.rowNo(10).querySelector('[data-edit="nickname"]')
  inp.onfocus?.()
  must(!h.el("nickpick").classList.contains("open"), "只读身份居然弹出了群昵称候选")
})

await check("左下角头像：有 perm.avatar 就渲染同源代理图，取不到退回昵称首字", async () => {
  const h = boot({
    dataFor: () =>
      makeData({ role: "self", nick: "甲", readonly: false, changes: true, versions: false, manage: false, avatar: "api/avatar?qq=1000000003" }),
  })
  await settle(h)
  const av = h.el("meAv")
  const img = av.querySelector("img")
  must(img, "没渲染头像图")
  must(String(img.src) === "api/avatar?qq=1000000003", `没走同源代理：${img.src}`)
  img.onerror()
  must(av.querySelectorAll("img").length === 0, "加载失败后没把 img 摘掉")
  must(h.textOf(av) === "甲", `回落后没显示昵称首字：${h.textOf(av)}`)
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

// 手机端（窗口宽 1024，走 ≤1100px 那一档）没有侧栏，切页靠底部那颗下拉。
await check("手机端页面切换：成员只有填写页，管理员没有填写页", async () => {
  const admin = boot({})
  await settle(admin)
  must(admin.probe.page === "queue", `管理员默认页不对：${admin.probe.page}`)
  const adminOpts = [...admin.el("mobPage").querySelectorAll("option")].map(o => o.getAttribute("value"))
  must(adminOpts.join(",") === "queue,overview,cycles,versions,changes,admins,ownership",
    `管理员下拉选项不对：${JSON.stringify(adminOpts)}`)
  must(!adminOpts.includes("fill"), `管理员下拉不该有「填写」页：${JSON.stringify(adminOpts)}`)
  must(admin.el("mobPage").value === "queue", "下拉没跟当前页同步")
  must(admin.document.querySelector(".adminonly").style.display !== "none", "管理身份不该藏「管理台 /」")
  must(admin.el("addRow").style.display !== "none", "管理员排队表底部该有「＋ 新增一行」")
  const member = boot({ dataFor: () => makeData({ role: "self", nick: "甲", readonly: false, changes: true, versions: false, manage: false }) })
  await settle(member)
  must(member.probe.page === "fill", `成员默认页不是填写页：${member.probe.page}`)
  must(member.el("crumb").textContent === "排队表 · 填写", `成员默认页标题不对：${member.el("crumb").textContent}`)
  const memberOpts = [...member.el("mobPage").querySelectorAll("option")].map(o => o.getAttribute("value"))
  must(memberOpts.join(",") === "fill", `成员下拉该只有填写页：${JSON.stringify(memberOpts)}`)
  must(member.document.querySelector(".adminonly").style.display === "none", "成员视图还露着「管理台 /」")
  must(member.el("fillAddRow").style.display !== "none", "成员填写页底部该有「＋ 新增一行」")
  const guest = boot({ dataFor: () => makeData({ role: "guest", nick: "", readonly: true, changes: false, versions: false, manage: false }) })
  await settle(guest)
  must(guest.probe.page === "fill", `只读访客默认页不是填写页：${guest.probe.page}`)
  const guestOpts = [...guest.el("mobPage").querySelectorAll("option")].map(o => o.getAttribute("value"))
  must(guestOpts.join(",") === "fill", `只读访客下拉该只有填写页：${JSON.stringify(guestOpts)}`)
  must(guest.el("fillAddRow").style.display === "none", "只读访客不该看到「＋ 新增一行」")
})

await check("成员在填写页点「＋ 新增一行」就能就地报名", async () => {
  const data = makeData({ role: "self", nick: "甲", readonly: false, changes: true, versions: false, manage: false })
  data.mineRows = { 幻想真境剧诗: [] }
  const h = boot({ dataFor: () => data })
  await settle(h)
  must(h.probe.page === "fill", `成员没落到填写页：${h.probe.page}`)
  must(h.el("fillCta").textContent === "我要报名", `没报名时 CTA 不对：${h.el("fillCta").textContent}`)
  h.el("fillCta").onclick()
  must(h.probe.page === "fill", "点「我要报名」被弹出了填写页")
  must(h.probe.dirty.length === 1, `新行没进草稿：${JSON.stringify(h.probe.dirty)}`)
  const fresh = h.newRow()
  must(fresh, "点「我要报名」没有建出新行")
})

await check("只读访客在填写页点「我要报名」不建行", async () => {
  const data = makeData({ role: "guest", nick: "", readonly: true, changes: false, versions: false, manage: false })
  data.mineRows = {}
  const h = boot({ dataFor: () => data })
  await settle(h)
  must(h.el("fillCta").textContent === "我要报名", `CTA 不对：${h.el("fillCta").textContent}`)
  h.el("fillCta").onclick()
  must(h.probe.dirty.length === 0, `只读访客也建了行：${JSON.stringify(h.probe.dirty)}`)
  must(h.toasts().some(t => /只读/.test(t)), `没提示只读：${JSON.stringify(h.toasts())}`)
})

await check("填写页「我的报名」认服务端下发的本人行，不按昵称猜", async () => {
  // 服务端按 QQ 绑定认出来的是第 11 行（昵称「乙」），页面按昵称找会落到第 10 行（「甲」）。
  const data = makeData({ role: "self", nick: "甲", readonly: false, roam: true, changes: true, versions: false, manage: false })
  data.sheets[0].rows.push({ row: 11, seq: 2, nickname: "乙", gameName: "乙的游戏", anchor: "阿修Axiu", goal: "困难模式", note: "", status: "排队中", fp: "fp11" })
  data.mineRows = { 幻想真境剧诗: [11] }
  // 手机导航不再单列「填写」页，但它还留作深链 `#fill`（桌面/分享链接仍可用）
  const h = boot({ dataFor: () => data, hash: "#fill" })
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
  /** 认不出是哪一行时 CTA 不能是「我要报名」——那会再建一行，同名问题更糟 */
  must(h.el("fillCta").textContent === "我的报名待核对", `CTA 不对：${h.el("fillCta").textContent}`)
  h.el("fillCta").onclick()
  must(h.toasts().some(t => /同名行/.test(t)), `没提示联系管理员：${JSON.stringify(h.toasts())}`)
  must(h.probe.dirty.length === 0, "认不出本人行时不该建新行")
})

/* ------------------- ⑨ 身份按标签页存（复查第 2 条） ------------------- */

// 身份 `u/s/a` 只属于当前标签页：localStorage 是整个浏览器共用的，
await check("身份只在当前标签页：localStorage 里的旧身份不会被带进请求头", async () => {
  const h = boot({
    seedLocal: { "abyss.u": "上一个人", "abyss.s": "旧签名", "abyss.a": "旧管理口令" },
  })
  await settle(h)
  const first = h.reads("api/data")[0]
  must(first, "页面启动后没读表")
  const headers = first.headers ?? {}
  must(!headers["x-abyss-identity"] && !headers["x-abyss-sign"],
    `旧 localStorage 里的身份被带进了请求头：${JSON.stringify(headers)}`)
  must(!h.ctx.localStorage.getItem("abyss.u") && !h.ctx.localStorage.getItem("abyss.s"),
    "启动后没把 localStorage 里的旧身份清掉")
})

await check("链接带的身份写进当前标签页（sessionStorage），请求头也带得出去", async () => {
  const h = boot({ search: "?k=口令1&u=张三&s=签名1" })
  await settle(h)
  must(h.ctx.sessionStorage.getItem("abyss.u") === "张三",
    `身份没进 sessionStorage：${h.ctx.sessionStorage.getItem("abyss.u")}`)
  must(h.ctx.localStorage.getItem("abyss.u") == null && h.ctx.localStorage.getItem("abyss.s") == null,
    "身份又被写回了 localStorage")
  must(h.ctx.localStorage.getItem("abyss.k") === "口令1", "访问口令应该留在 localStorage")
  const first = h.reads("api/data")[0]
  must(first, "页面启动后没读表")
  const headers = first.headers ?? {}
  must(headers["x-abyss-identity"] === "张三" && headers["x-abyss-sign"] === "签名1",
    `请求头没带本标签页的身份：${JSON.stringify(headers)}`)
})

// 设备认领整层删掉了（2026-11-25 重写）：页面不再有设备令牌，也不再往请求头里塞
await check("页面不再有设备令牌（认领那一层已整体删除）", async () => {
  const h = boot({ search: "?k=口令1&u=张三&s=签名1" })
  await settle(h)
  const first = h.reads("api/data")[0]
  must(first, "页面启动后没读表")
  must(!Object.keys(h.ctx.localStorage).some(k => k.startsWith("abyss.d")), "localStorage 里还有设备令牌")
})

/* ------------------- ⑩ 已有会话时的短码兑换（复查第 1 条） ------------------- */

// 群里的短链只是 `<public_url>/#code=NNNNNN`，服务端看不到 fragment。
await check("已有会话时，#code 短链也先兑换成本人完整链接再展示页面", async () => {
  const target = "http://127.0.0.1:7900/queue/?k=口令1&u=张三&s=签名1"
  const h = boot({
    search: "?k=口令1",
    hash: "#code=123456",
    seedLocal: { "abyss.k": "口令1", "abyss.u": "上一个人", "abyss.s": "旧签名" },
    linkCodeReply: url => (url.includes("code=123456") ? { status: 200, body: { ok: true, url: target } } : null),
  })
  await settle(h)
  const asked = h.reads("api/link-code")
  must(asked.length === 1, `没去兑换短码：${JSON.stringify(h.reads(""))}`)
  must(asked[0].url.includes("code=123456"), `兑换用的口令不对：${asked[0].url}`)
  must(h.replaced.length === 1 && h.replaced[0] === target,
    `没换成完整链接：${JSON.stringify(h.replaced)}`)
})

await check("短码失效时留在当前页说明原因，不拿旧身份继续用", async () => {
  const h = boot({
    search: "?k=口令1",
    hash: "#c=654321",
    seedLocal: { "abyss.k": "口令1", "abyss.u": "上一个人", "abyss.s": "旧签名" },
    linkCodeReply: () => ({ status: 410, body: { ok: false, error: "口令不对或已过期，请回群里重新发一次 #排队" } }),
  })
  await settle(h)
  must(h.replaced.length === 0, `口令失效还跳走了：${JSON.stringify(h.replaced)}`)
  must(h.toasts().some(t => /口令不对或已过期/.test(t)), `没说明原因：${JSON.stringify(h.toasts())}`)
})

await check("页面路由 hash（#queue 等）不会被当成短码去兑换", async () => {
  const h = boot({ search: "?k=口令1", hash: "#ownership" })
  await settle(h)
  must(h.reads("api/link-code").length === 0, "把页面路由 hash 当短码兑换了")
  must(h.replaced.length === 0, `不该跳走：${JSON.stringify(h.replaced)}`)
})

// 同一个标签页里已经打开过（比如主人先点开自己的链接），再点群友的短链时，
await check("同一标签页内点 #code 短链也兑换（浏览器只改 hash、不重载页面）", async () => {
  const target = "http://127.0.0.1:7900/queue/?k=口令1&u=群友甲&s=签名2"
  const h = boot({
    search: "?k=口令1",
    hash: "#queue",
    seedLocal: { "abyss.k": "口令1" },
    linkCodeReply: url => (url.includes("code=246810") ? { status: 200, body: { ok: true, url: target } } : null),
  })
  await settle(h)
  must(h.reads("api/link-code").length === 0, "启动时把页面路由 hash 当短码兑换了")
  h.ctx.location.hash = "#code=246810"
  h.fireWindow("hashchange")
  await settle(h)
  const asked = h.reads("api/link-code")
  must(asked.length === 1, `同标签页内点短链没兑换：${JSON.stringify(h.reads(""))}`)
  must(asked[0].url.includes("code=246810"), `兑换用的口令不对：${asked[0].url}`)
  must(h.replaced.length === 1 && h.replaced[0] === target,
    `没换成完整链接：${JSON.stringify(h.replaced)}`)
})

await finish()
