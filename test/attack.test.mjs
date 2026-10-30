import assert from "node:assert/strict"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("绝境攻炼")

const {
  ATTACK_ALL_MODES,
  ATTACK_FUTURE_VERSION_MODES,
  ATTACK_MODES,
  ATTACK_STRENGTHS,
  ATTACK_TARGETS,
  ATTACK_VERSION_MESSAGE,
  attackGoalColor,
  attackGoalValue,
  attackModeShort,
  attackVersionIndex,
  attackVersionNotice,
  attackVersionStart,
  goalParts,
  parseAttackGoal,
} = await import("../components/attack.js")
const { SHEETS, SHEET_ALIASES } = await import("../components/constants.js")
const { defaultStatusOf } = await import("../modules/progress.js")

console.log("【1】模式 / 目标")
{
  check("五个模式、三目标，模式按 7.0 / 7.1 分组", () => {
    assert.equal(ATTACK_MODES.length, 5)
    assert.deepEqual(ATTACK_TARGETS.map(t => t.name), ["满原石", "满星章", "顶分"])
    assert.equal(attackModeShort(["焰羽追绞"]), "焰羽追绞")
    assert.equal(attackModeShort(["焰羽追绞", "囚笼冰城"]), "焰羽追绞、囚笼冰城")
    assert.equal(attackModeShort(["焰羽追绞", "囚笼冰城", "线列破袭"]), "7.0模式")
    assert.equal(attackModeShort(["至寒风暴", "狭域死战"]), "7.1模式")
    assert.equal(attackModeShort(["焰羽追绞", "至寒风暴", "狭域死战"]), "7.1模式、焰羽追绞")
    assert.equal(attackModeShort(["焰羽追绞", "囚笼冰城", "线列破袭", "至寒风暴", "狭域死战"]), "7.0/7.1模式")
  })
  check("7.2 / 7.3 空预设：未来版本可先排队", () => {
    assert.deepEqual(ATTACK_FUTURE_VERSION_MODES, { "7.2": "7.2模式", "7.3": "7.3模式" })
    assert.ok(ATTACK_ALL_MODES.includes("7.2模式") && ATTACK_ALL_MODES.includes("7.3模式"))
    assert.equal(attackModeShort(["7.2模式"]), "7.2模式")
    assert.equal(attackModeShort(["7.3模式"]), "7.3模式")
    assert.equal(attackGoalValue(["7.2模式"], "满星章"), "7.2模式｜满星章")
    assert.deepEqual(parseAttackGoal("7.2模式｜满星章"), { modes: ["7.2模式"], target: "满星章" })
  })
  check("组合值与解析：模式多选 + 目标单选", () => {
    const value = attackGoalValue(["焰羽追绞", "囚笼冰城"], "满星章")
    assert.equal(value, "焰羽追绞、囚笼冰城｜满星章")
    assert.deepEqual(parseAttackGoal(value), { modes: ["焰羽追绞", "囚笼冰城"], target: "满星章" })
    assert.equal(attackGoalValue([], "满星章"), "")
    assert.equal(parseAttackGoal("焰羽追绞｜困难8满原石"), null)
    /** 旧表里的「满星」按新目标「满星章」解析，不会变成孤值 */
    assert.deepEqual(parseAttackGoal("焰羽追绞｜满星"), { modes: ["焰羽追绞"], target: "满星章" })
  })
  check("账号强度三档的写法", () => {
    assert.deepEqual(ATTACK_STRENGTHS, ["高配｜满配满体", "中配｜半配半体", "低配｜裸配无体"])
  })
  check("目标上色：顶分深紫 / 满星红 / 满原石绿", () => {
    assert.equal(attackGoalColor("焰羽追绞｜顶分"), "dark")
    assert.equal(attackGoalColor("焰羽追绞｜满星章"), "red")
    assert.equal(attackGoalColor("焰羽追绞｜满原石"), "green")
  })
  check("旧三榜只拆显示，不改颜色判断", () => {
    const gp = goalParts("困难模式满星章")
    assert.equal(gp.prefix, "困难模式")
    assert.equal(gp.target, "满星章")
    assert.equal(gp.prefixTone, "green")
    assert.equal(gp.color, "green")
    assert.equal(attackGoalColor("困难模式满原石"), "")
  })
}

console.log("\n【2】版更日历")
{
  check("第 1 期 2026-11-04 10:00，间隔 42 天", () => {
    assert.equal(attackVersionIndex(new Date(2026, 10, 3, 23, 59)), 0)
    assert.equal(attackVersionIndex(new Date(2026, 10, 4, 9, 59)), 0)
    assert.equal(attackVersionIndex(new Date(2026, 10, 4, 10, 0)), 1)
    assert.equal(attackVersionIndex(new Date(2026, 11, 16, 10, 0)), 2)
    assert.equal(attackVersionStart(2).getTime(), new Date(2026, 11, 16, 10, 0).getTime())
  })
  check("版更播报只发一次；首跑/跨天不补发", () => {
    const at = new Date(2026, 10, 4, 10, 0)
    assert.deepEqual(attackVersionNotice({}, at), { index: 1, at: new Date(2026, 10, 4, 10, 0) })
    assert.equal(attackVersionNotice({ attackVersion: 1 }, at), null)
    assert.equal(attackVersionNotice({}, new Date(2026, 10, 5, 10, 0)), null)
    assert.equal(attackVersionNotice(null, at), null)
  })
  check("绝境攻炼开榜状态与榜名别名", () => {
    assert.equal(defaultStatusOf("绝境攻炼", new Date(2026, 10, 4, 9, 59)), "排队中")
    assert.equal(defaultStatusOf("绝境攻炼", new Date(2026, 10, 4, 10, 0)), "排队中")
    assert.ok(SHEETS.includes("绝境攻炼"))
    assert.equal(SHEET_ALIASES.攻炼, "绝境攻炼")
    assert.equal(SHEET_ALIASES.绝境, "绝境攻炼")
  })
  check("版更播报正文与维护者文案一致", () => {
    assert.equal(ATTACK_VERSION_MESSAGE, "【绝境攻炼】新模式已开启，如需帮帮可前往排队。")
  })
}

await finish()


