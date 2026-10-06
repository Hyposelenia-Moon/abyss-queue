/**
 * 主播别名：把表里/群里的各种写法归一到正名
 *
 * 用法：node test/aliases.test.mjs
 */
import assert from "node:assert/strict"
import { aliasOf, canonicalAnchor, compileAliases } from "../components/aliases.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("主播别名")
const A = compileAliases({ 阿修Axiu: ["阿修"], 摸头妹: ["璃月第一深情"] })

check("别名归一到正名", () => {
  assert.equal(canonicalAnchor("阿修", A), "阿修Axiu")
  assert.equal(canonicalAnchor("璃月第一深情", A), "摸头妹")
})

check("正名本身不受影响", () => {
  assert.equal(canonicalAnchor("阿修Axiu", A), "阿修Axiu")
  assert.equal(canonicalAnchor("摸头妹", A), "摸头妹")
  assert.equal(canonicalAnchor("听雨", A), "听雨")
})

check("不在别名表里的名字原样返回（空值给空串）", () => {
  assert.equal(canonicalAnchor("查无此人", A), "查无此人")
  assert.equal(canonicalAnchor("", A), "")
  assert.equal(canonicalAnchor(null, A), "")
})

check("按正则整串匹配：不会把「阿修Axiu」当成「阿修」的别名再套一层", () => {
  assert.equal(canonicalAnchor("阿修", A), "阿修Axiu")
  assert.equal(aliasOf("阿修Axiu", A), null)
  assert.equal(aliasOf("阿修", A), "阿修Axiu")
})

check("别名可以写正则", () => {
  const R = compileAliases({ 纸笑: ["纸笑.*", "纸笑"] })
  assert.equal(canonicalAnchor("纸笑笑", R), "纸笑")
  assert.equal(canonicalAnchor("纸笑", R), "纸笑")
  assert.equal(canonicalAnchor("纸", R), "纸")
})

check("配置写错（非法正则 / 空值）不会炸，只是这条别名不生效", () => {
  const bad = compileAliases({ 甲: ["[未闭合"], 乙: "", 丙: ["", null] })
  assert.equal(bad.length, 0)
  assert.equal(canonicalAnchor("甲", bad), "甲")
})

check("大小写不敏感（英文昵称常见）", () => {
  const E = compileAliases({ Aki: ["aki"] })
  assert.equal(canonicalAnchor("AKI", E), "Aki")
})

finish()
