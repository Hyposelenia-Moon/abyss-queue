/**
 * 主播列表保存的版本冲突 —— **页面那一半已退场**（2026-11 九页重写）
 *
 * 旧页面在表头上方有一份可编辑的主播名单（`#anchorGrid` + `#anchorSave`），
 * 保存时带 `version`、撞上就 409、草稿留着。重写后主播区变成**只读卡片 + 呼叫**，
 * 名单由机器人侧用 `/api/anchors` 维护（页面不再发这个请求），所以页面侧的
 * 「带版本 / 409 提示 / 草稿保留 / 不自动重试」四条无从验证，随之删除。
 *
 * 保留的是**服务端那一半**：`/api/anchors` 带 `version` 时按版本判，对不上 409 且一个字不落表。
 * 这条现在更重要——页面不再发请求，意味着这条链只有机器人会走。
 *
 * 用法：node editor/test/anchor-version.test.mjs（任意 cwd）
 */
import fs from "node:fs"

/* ------------------------------ 断言脚手架 ------------------------------ */

let failed = 0
const must = (ok, why) => {
  if (!ok) throw new Error(why)
}
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}

/* ------- 端到端：服务端真的按版本判（起真编辑器；缺模板就跳过） ------- */

/**
 * 起一个真编辑器，按机器人的口径走一遍：`/api/data` 拿 version → 原样带回去保存（必须 200）；
 * 别人先提交之后，我手里这一版再提交必须 409，且**表里的值一个字节都没变**。
 */
{
  const harness = await import("./harness.mjs").catch(() => null)
  if (!harness || !fs.existsSync(harness.TEMPLATE)) {
    console.log("  ⏭ 缺空模板（或插件目录），跳过端到端那一截：主播列表的版本往返没验")
  } else {
    const OWNER = { qq: "424242", nick: "主人" }
    const TOKEN = "anchor-version-token"
    const SIGN_KEY = "anchor-version-sign-key"
    const SHEET = "幽境危战"
    const ws = harness.makeWorkspace("anchor-version")
    const adminsFile = ws.file("admins.json")
    fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
    let editor = null
    try {
      editor = await harness.startEditor({
        label: "主播版本往返",
        token: TOKEN,
        signKey: SIGN_KEY,
        adminsFile,
        args: ["--file", ws.fixture],
        env: {
          ABYSS_QUEUE_CONFIG: ws.cfg,
          ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
          /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
          ABYSS_EDITOR_TEST_PATHS: "1",
        },
      })

      const load = async () => (await editor.request("/api/data", { who: OWNER })).json
      const anchorOf = async () => (await load()).sheets.find(s => s.name === SHEET)?.anchorRows?.[0]
      const payload = await load()
      const first = payload.sheets.find(s => s.name === SHEET)?.anchorRows?.[0]
      if (!first) {
        console.log(`  ⏭ 空模板里「${SHEET}」没有识别到主播行，跳过端到端那一截`)
      } else {
        const values = { ...first, skills: "带版本存的主播强项" }
        delete values.row
        delete values.entry

        await check("端到端：主播列表带着读到的那一版保存，服务端认（不是 409）", async () => {
          const v = (await load()).version
          must(typeof v === "string" && v.length > 0, `/api/data 没下发 version：${JSON.stringify(v)}`)
          const saved = await editor.request("/api/anchors", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row: first.row, values }], version: v },
          })
          must(saved.json.ok, `带着自己刚读到的版本保存主播列表被拒了（HTTP ${saved.status}）：${JSON.stringify(saved.json)}`)
          must((await anchorOf())?.skills === values.skills, "保存成功了，表里却没写进去")
        })

        await check("端到端：别人先提交主播列表，我手里这版被 409 拒掉，一个字都不落表", async () => {
          const mine = (await load()).version
          /** 另一个窗口：请求里不带版本号先写进去（页面还没跟着升级的那种） */
          const other = await editor.request("/api/anchors", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row: first.row, values: { ...values, skills: "别人先改的强项" } }] },
          })
          must(other.json.ok, `先提交的那个不该被拒：${JSON.stringify(other.json)}`)
          const rejected = await editor.request("/api/anchors", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row: first.row, values: { ...values, skills: "不该落地" } }], version: mine },
          })
          must(
            rejected.status === 409 && rejected.json.conflict === true,
            `期望 409 冲突，实际 HTTP ${rejected.status} ${JSON.stringify(rejected.json)}`,
          )
          must(rejected.json.error, "409 里没给原因")
          must((await anchorOf())?.skills === "别人先改的强项", `被拒的主播列表保存落表了：${JSON.stringify((await anchorOf())?.skills)}`)
        })
      }
    } catch (err) {
      await check("端到端那一截", async () => {
        throw err
      })
    } finally {
      if (editor) await editor.stop()
      ws.cleanup()
    }
  }
}

console.log(failed ? `\n❌ 主播列表版本冲突验证失败 ${failed} 项` : "\n✅ 主播列表版本冲突验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
