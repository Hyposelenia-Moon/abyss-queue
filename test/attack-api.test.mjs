import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')

const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'abyss1105-attack-'))
const cfgText = 'default_sheet: 绝境攻炼\nattack_versions:\n  - version: "7.2"\n    open_at: "2000-01-01 10:00"\n    preset: "7.2模式"\n    modes: []\n  - version: "7.3"\n    open_at: "2999-01-01 10:00"\n    preset: "7.3模式"\n    modes: []\n'
fs.writeFileSync(path.join(outer, 'config.yaml'), cfgText)
process.env.ABYSS_QUEUE_CONFIG = path.join(outer, 'config.yaml')
process.env.ABYSS_QUEUE_TEST_PATHS = '1'
process.env.ABYSS_EDITOR_TEST_PATHS = '1'
globalThis.logger = { info(){}, warn(){}, error(){} }
const load = rel => import(pathToFileURL(path.join(root, rel)).href)
const { makeWorkspace, startEditor, Table } = await load('editor/test/harness.mjs')
const { default: JSZip } = await load('node_modules/jszip/lib/index.js')
const ws = makeWorkspace('attack-probe')
fs.writeFileSync(ws.cfg, cfgText)
process.env.ABYSS_QUEUE_CONFIG = ws.cfg
const zip = await JSZip.loadAsync(fs.readFileSync(ws.fixture))
const wb = await zip.file('xl/workbook.xml').async('string')
zip.file('xl/workbook.xml', wb.replace('</sheets>', '<sheet name="绝境攻炼" sheetId="4" r:id="rIdAttackProbe"/></sheets>'))
const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rIdAttackProbe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/></Relationships>'))
const types = await zip.file('[Content_Types].xml').async('string')
zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'))
zip.file('xl/worksheets/sheet4.xml', await zip.file('xl/worksheets/sheet1.xml').async('string'))
fs.writeFileSync(ws.fixture, await zip.generateAsync({ type: 'nodebuffer' }))
fs.writeFileSync(ws.file('admins.json'), JSON.stringify({ owner: ['1000000001'], admins: [] }))
const owner = { qq: '1000000001', nick: '合成主人' }
const self = { qq: '80001', nick: '版本排队员' }
const table = new Table({ file: ws.fixture, backup: false })
let server
const cases = []
const sheet = '绝境攻炼'
const makeValues = (m, overrides={}) => ({ nickname: self.nick, gameName: '合成游戏名', anchor: m.options.anchor[0], goal:'7.2模式｜满星章', strength:'中配｜半配半体', note:'', status:'', ...overrides })
const seed = async (status='7.2排队中', goal='7.2模式｜满星章') => {
  await table.mutate(ctx => { for(const r of ctx.model(sheet).rows)ctx.clearRow(sheet,r.row) })
  await table.mutate(ctx => {
    const m=ctx.model(sheet)
    for(const [k,v] of Object.entries(makeValues(m,{status,goal})))ctx.setCell(sheet,m.dataStart,k,v)
  })
}
const row = async () => table.read(({models})=>models.get(sheet).rows.find(r=>r.nickname===self.nick))
try {
  server=await startEditor({label:'attack-probe',token:'probe-token',signKey:'probe-sign',adminsFile:ws.file('admins.json'),args:['--file',ws.fixture],env:{ABYSS_QUEUE_CONFIG:ws.cfg,ABYSS_EDITOR_TEST_PATHS:'1'}})
  const data=(await server.data(owner)).json
  const model=data.sheets.find(s=>s.name===sheet)
  const fresh=await server.request('/api/save',{who:owner,body:{sheet,rows:[{row:model.dataStart,values:makeValues(model)}]}})
  cases.push({name:'new attack row with automatic status',expected:'save 200 / status 7.2排队中',response:{status:fresh.status,body:fresh.json},actual:await row()})
  await seed()
  const before=await row()
  const done=await server.request('/api/save',{who:self,body:{sheet,rows:[{row:before.row,values:{...before,status:'本人已完成'}}]}})
  cases.push({name:'self marks own open attack version complete',expected:'7.2版本排队员',response:{status:done.status,body:done.json},actual:await row()})
  await seed()
  const beforeGoal=await row()
  const changedGoal=await server.request('/api/save',{who:owner,body:{sheet,rows:[{row:beforeGoal.row,values:{...beforeGoal,goal:'7.3模式｜满星章'}}]}})
  cases.push({name:'change selected version from open to future',expected:'7.3等待开启',response:{status:changedGoal.status,body:changedGoal.json},actual:await row()})
  await seed()
  const beforeAdmin=await row()
  const adminDone=await server.request('/api/save',{who:owner,body:{sheet,rows:[{row:beforeAdmin.row,values:{...beforeAdmin,status:self.nick}}]}})
  cases.push({name:'admin completes open attack version',expected:'save 200 / status 7.2版本排队员',response:{status:adminDone.status,body:adminDone.json},actual:await row()})
  await seed('7.2排队中','7.2模式、7.3模式｜满星章')
  const beforePartial=await row()
  const partial=await server.request('/api/save',{who:self,body:{sheet,rows:[{row:beforePartial.row,values:{...beforePartial,status:'本人已完成'}}]}})
  cases.push({name:'self completion preserves future waiting',expected:'7.2版本排队员 7.3等待开启',response:{status:partial.status,body:partial.json},actual:await row()})
  const beforeUndo=await row()
  const undo=await server.request('/api/save',{who:self,body:{sheet,rows:[{row:beforeUndo.row,values:{...beforeUndo,status:'排队中'}}]}})
  cases.push({name:'self may revoke own completion',expected:'7.2排队中',response:{status:undo.status,body:undo.json},actual:await row()})
  await seed()
  const lockStart=await row()
  const anchorName=await table.read(({models})=>models.get(sheet).options.anchor[0])
  const lockSetup=await server.request('/api/save',{who:owner,body:{sheet,rows:[{row:lockStart.row,values:{...lockStart,status:anchorName}}]}})
  const locked=await row()
  const changedLockedGoal=await server.request('/api/save',{who:self,body:{sheet,rows:[{row:locked.row,values:{...locked,goal:'7.3模式｜满星章'}}]}})
  cases.push({name:'own locked row changes goal without changing submitted completion',expected:'7.3等待开启',setup:{status:lockSetup.status,body:lockSetup.json},response:{status:changedLockedGoal.status,body:changedLockedGoal.json},actual:await row()})
  await table.mutate(ctx=>{for(const r of ctx.model(sheet).rows)ctx.clearRow(sheet,r.row)})
  await table.mutate(ctx=>{
    const m=ctx.model(sheet)
    const variants=[
      {nickname:'正在排队',status:'7.2排队中',goal:'7.2模式｜满星章'},
      {nickname:'未来等待',status:'7.3等待开启',goal:'7.3模式｜满星章'},
      {nickname:'已经完成',status:'7.2已经完成',goal:'7.2模式｜满星章'},
    ]
    variants.forEach((v,i)=>{for(const[k,value]of Object.entries(makeValues(m,v)))ctx.setCell(sheet,m.dataStart+i,k,value)})
  })
  const cycle=await server.request('/api/cycle',{who:owner,body:{sheet,mode:'done',promote:'future-real',eventKey:sheet+':update:2099-01-01',version:await table.fingerprint()}})
  const kept=await table.read(({models})=>models.get(sheet).rows.map(r=>({nickname:r.nickname,status:r.status})))
  cases.push({name:'version update clears completed only',expected:'only 已经完成 removed; 正在排队 and 未来等待 retained',response:{status:cycle.status,body:cycle.json},remaining:kept})
  await seed('7.3等待开启','7.3模式｜满星章')
  fs.writeFileSync(ws.cfg,cfgText.replace('2999-01-01','2000-01-01'))
  const stamp=new Date(Date.now()+2000);fs.utimesSync(ws.cfg,stamp,stamp)
  const promote=await server.request('/api/cycle',{who:owner,body:{sheet,mode:'promote',promote:'future-real',eventKey:sheet+':start:2099-01-02',version:await table.fingerprint()}})
  cases.push({name:'opened composite waiting version is promoted',expected:'7.3排队中',response:{status:promote.status,body:promote.json},actual:await row()})
} finally {
  if(server)await server.stop()
  ws.cleanup()
  if(path.dirname(path.resolve(outer))!==path.resolve(os.tmpdir()))throw Error('Unexpected temp root')
  fs.rmSync(outer,{recursive:true,force:true})
}
const expected = new Map([
  ['new attack row with automatic status', '7.2排队中'],
  ['self marks own open attack version complete', '7.2版本排队员'],
  ['change selected version from open to future', '7.3等待开启'],
  ['admin completes open attack version', '7.2版本排队员'],
  ['self completion preserves future waiting', '7.2版本排队员 7.3等待开启'],
  ['self may revoke own completion', '7.2排队中'],
  ['own locked row changes goal without changing submitted completion', '7.3等待开启'],
  ['opened composite waiting version is promoted', '7.3排队中'],
])
for (const c of cases) {
  if (c.setup) assert.equal(c.setup.status, 200, c.name+': setup')
  assert.equal(c.response.status, 200, c.name+': '+JSON.stringify(c.response.body))
  if (c.name === 'version update clears completed only') {
    assert.equal(c.response.body.cleared, 1)
    assert.deepEqual(c.remaining.map(r=>r.nickname).sort(), ['正在排队','未来等待'].sort())
  } else assert.equal(c.actual?.status, expected.get(c.name), c.name)
  console.log('✅ '+c.name)
}
console.log('Actual attack API: '+cases.length+' cases passed')
