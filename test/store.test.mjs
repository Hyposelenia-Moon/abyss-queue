/**
 * 绑定库：整理/清榜后的行号搬迁
 *
 * 编辑器会返回 `{老行号: 新行号}`；插件只搬行号，昵称/时间原样保留，
 * 0 或非法新行号表示这一行已被清掉，绑定直接删除。
 *
 * 用法：node test/store.test.mjs
 */
import assert from "node:assert/strict"
import { BindStore } from "../model/store.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("绑定库")

const fresh = () => {
  const store = new BindStore("")
  store.set("幽境危战", "10001", { row: 20, nickname: "甲" })
  store.set("幽境危战", "10002", { row: 21, nickname: "乙" })
  store.set("幽境危战", "10003", { row: 22, nickname: "丙" })
  store.set("深境螺旋", "10001", { row: 10, nickname: "甲" })
  return store
}

check("搬行：只改行号，昵称与归属保持", () => {
  const store = fresh()
  const before = store.get("幽境危战", "10002")
  const moved = store.remap("幽境危战", { 21: 23 })
  assert.equal(moved, 1)
  assert.equal(store.get("幽境危战", "10002").row, 23)
  assert.equal(store.get("幽境危战", "10002").nickname, "乙")
  assert.equal(store.get("幽境危战", "10002").at, before.at)
  assert.equal(store.get("幽境危战", "10001").row, 20, "没点到的行不动")
  assert.equal(store.get("深境螺旋", "10001").row, 10, "别的榜不动")
})

check("搬行：0 / 非法新行号表示行已清空，绑定删除", () => {
  const store = fresh()
  const moved = store.remap("幽境危战", { 20: 0, 21: -1 })
  assert.equal(moved, 2)
  assert.equal(store.get("幽境危战", "10001"), null)
  assert.equal(store.get("幽境危战", "10002"), null)
  assert.equal(store.get("幽境危战", "10003").row, 22)
})

check("搬行：整榜清空后不留空对象", () => {
  const store = fresh()
  assert.equal(store.remap("幽境危战", { 20: 0, 21: 0, 22: 0 }), 3)
  assert.deepEqual(store.data.binds["幽境危战"], undefined)
})

check("搬行：同一映射重复执行不再改动", () => {
  const store = fresh()
  assert.equal(store.remap("幽境危战", { 20: 0 }), 1)
  assert.equal(store.remap("幽境危战", { 20: 0 }), 0, "旧行号已经没人，第二次是空操作")
})

check("搬行：坏映射不崩", () => {
  const store = fresh()
  assert.equal(store.remap("幽境危战", null), 0)
  assert.equal(store.remap("不存在", { 1: 2 }), 0)
})

await finish()
