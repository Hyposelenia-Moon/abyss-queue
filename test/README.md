# 回归套件

不依赖 Yunzai，也不启动机器人进程。`node test/run.mjs` 顺序跑 `test/*.test.mjs` 与
`editor/test/*.test.mjs`——**插件侧 29 个 + 编辑器侧 34 个 = 63 个**，汇总后按失败数给退出码。
被测表格只操作**副本**，结束时校验原表哈希未变。**本文件是套件清单的唯一出处**。

## 运行

```bash
pnpm test                             # = node test/run.mjs
node test/run.mjs --list              # 列出全部套件
node test/run.mjs workbook cache      # 只跑相对路径含这些关键词的套件
node test/run.mjs editor              # 只跑编辑器那一半
node test/workbook.test.mjs           # 单跑某个套件（任意 cwd 均可）
XLSX_PATH="D:/别的表.xlsx" pnpm test   # 指定被测表格
ABYSS_TEST_SYNTHETIC=1 pnpm test      # 强制用合成样本（验「没有真实表也全绿」）
ABYSS_TEST_TIMEOUT_MS=300000 pnpm test # 单个套件超时（默认 120000）
```

关键词是**位置参数**（`--` 开头的参数一律忽略）；给了关键词却一个都没匹配上时退 1，打错名字不会静默变成跑全量。
**每套都有超时**，超时按失败计并杀掉整棵进程树——套件会起真实子进程（编辑器、宿主 HTTP 服务），
吊住一个就让 `pnpm test` 永远不返回，而 Windows 上 `child.kill()` 只杀直接子进程。

干净克隆先在机器人根目录 `pnpm install --filter=abyss-queue`（工作区锁文件在机器人根）；只想装这一个插件
就用 `npm i`。`jszip` / `yaml` 是运行时依赖，`express` 只给 `test/editor-host.test.mjs`（要真摆出框架那四个
body parser，才验得了「请求体不被读空」），所以列在 `devDependencies`。

## 套件

### 表格层与存储（`test/`）

| 套件 | 覆盖 |
| --- | --- |
| `workbook.test.mjs` | 结构解析（表头行 / 列映射 / 下拉选项 / 主播区 / 数据区末日行）、报名写入、人工维护要素保全、特殊字符往返、改备注与退队、原表未被触碰 |
| `template.test.mjs` | 空模板「结构在、数据不在、样式规范」 |
| `doc-export.test.mjs` | 导出器行数口径：`prefill: 0` 只写到数据末行、缺省 100、小于数据行数时以数据行数为准、负数 / 非整数回退 100 |
| `json-table.test.mjs` | `JsonTable` 读路径：常规读不加锁不写盘；要导回镜像时并进写串行链、锁没放出来之前不写盘；指纹口径与落盘内容同源 |
| `xlsx-row-tag.test.mjs` | 自闭合 `<row r="9"/>` 必须就地换成成对标签，不跟「这一行不存在」共用 `insertRow` 分支 |
| `row-style.test.mjs` | 逐行样式保全三条路：清空同一行再填回 / 删行后整体上移 / 普通保存写已存在的行——都不许抹平行自己的底色 |
| `store.test.mjs`、`file-lock.test.mjs` | 绑定存储的读写与原子替换；文件锁判活（同主机只看 pid，陈旧锁能接管） |

### 命令、工作流与出站（`test/`）

| 套件 | 覆盖 |
| --- | --- |
| `workflow.test.mjs` | 经 `index.js` 的 `apps` 导出装载入口类，复刻 loader 的规则匹配与上下文分发：全部命令（含 `#排队同步名单` 主人真推 / 非主人拒绝 / 没配群号只回原因）、引导流程、错误路径、唯一一条定时任务与进度通知、开榜播报末尾 `@` 主播 |
| `commands.test.mjs` | 注册规则 / 处理器解析 / 分页提示同源（全名、简称、别名、序号、后缀式、全量查看） |
| `anchors.test.mjs` | 主播别名归一、主播区排队人数、按 QQ 定位自己（同名不得认领别人已绑定的行） |
| `notify.test.mjs`、`notice.test.mjs` | 一条 tick 里的五件事、开榜时刻口径、月末催办与去重；关掉通知时名单同步与每日整理仍照做；主播区插行不误报完成；主人首启提示 |
| `cycle.test.mjs` | 周期清榜 / 开榜提醒 / 进度通知的口径与幂等 |
| `manager-link.test.mjs` | 管理员那份走私聊、只在本人发 `#排队` 时给一次、tick 不主动发链、私聊失败只在群里报一句原因 |
| `anchor-live.test.mjs` | B 站入口解析（房间 / UID）、状态缓存与首次基线、接口失败保留旧状态、只 `@` 自己订阅过且还在排队的人、`#排队直播状态` 自检、只展示 B 站入口 |
| `attack.test.mjs`、`attack-api.test.mjs` | 攻炼 5 模式 × 3 目标的解析与简写、版更日历与「同一期只播一次」；端到端 `/api/save` 的攻炼写法（旧式套件，独立于 `editor.test.mjs`） |
| `call-host.test.mjs` | 呼叫成员 / 主播的冷却与宿主限制 |
| `help.test.mjs` | 帮助页内容门禁（命令以 `#` 开头、不出现配置键 / 路径）与同源文本回退 |
| `layout.test.mjs` | 版式契约：三张渲染模板与编辑器主表的列对齐（只查规则有没有被改回去；出图人工看走 `render-check.mjs`） |
| `render-fallback.test.mjs` | 出图发送链的失败口径：确认发出才算成功，重试仍失败落纯文本兜底；署名行在图与文本兜底末尾都在 |
| `outbound-window.test.mjs` | 进程内直调对账：名单同步真调到 `registerEditorService` 注册的假 service、失败不重试不吞错；填报入口长链接仍带身份 + 当期窗口 |

### 启动、宿主与名单（`test/`）

| 套件 | 覆盖 |
| --- | --- |
| `bootstrap.test.mjs` | 启动补齐：`editor.token` / `sign_key` 为空才生成、**只改那两行**、手填值不覆盖、整行缺失按缩进插回；白名单首写（过滤非 QQ、去重、已有 owner 不覆盖、坏 JSON 不覆盖）；第二次启动逐字节不变 |
| `editor-host.test.mjs` | 编辑器挂到 bot 自己的 server：前缀认 `/queue`、`/queueX` 不吞、带 body 的请求不挂死、凭证只有 `config.editor` 一份、互锁探针语义 |
| `guoba.test.mjs` | 锅巴三段式配置：模板 `${变量}` 与 `CONFIG_FIELDS` 一一对应、三份结构一致、真往返、注释按模板保留 |
| `roster.test.mjs` | 机器人推群成员名单：签名身份、成员映射、空名单不推；成员来源逐个试、空就换下一个，全空时报错带群号与各来源形状 |
| `group-link-recall.test.mjs` | 群内那条输出的撤回：认 `message_id` / `messageId` / Satori 的 `id`，群对象没有 `recallMsg` 时退回 `bot.recallMsg` |
| `write.test.mjs` | 报名写入 / 退队 / 清榜核查三条写链路（含 6 行上限、非主人不许退别人的行） |

### 编辑器（`editor/test/`）

| 套件 | 覆盖 |
| --- | --- |
| `editor.test.mjs` | 端到端：字段与下拉、口令与身份签名、白名单权限、完成情况锁定、本人只能填两档、写入校验、健康检查 |
| `mount.test.mjs`、`owner-only.test.mjs` | 子路径挂载（nginx `proxy_pass` 不带尾斜杠）；主人专用模式（除主人外只剩 `/healthz` 凭口令） |
| `auth.test.mjs`、`sign-key.test.mjs` | 权限只按稳定 QQ 判；身份签名换口令 / 改内容 / 过期都过不了；拿口令伪造的身份必须被拒 |
| `fail-closed.test.mjs`、`config-flags.test.mjs`、`data-confinement.test.mjs` | 漏配就「起不来」；配置开关语义；数据落点生产不许出插件、测试开关才放行 |
| `ownership.test.mjs`、`row-ownership.test.mjs` | 归属审计与按当前表重建；同名两个 QQ 走真接口互不认领；给人看的编号是「序号」不是行号 |
| `nickname.test.mjs` | 群昵称：空名片不许回写昵称格、改名同步三条路径（本人 / 管理员 / 名单）、空名单不删行 |
| `save-conflict.test.mjs`、`anchor-version.test.mjs` | 保存版本冲突（前端接住 409、主播列表也带版本） |
| `live-refresh.test.mjs` | 实时刷新 + 行级冲突：指纹、他人改别的行不连坐、同一行被改 409、探测节奏与退避、切回前台补探 |
| `quota-guard.test.mjs` | 本群守卫 + 额度与红线 + 告警：名单三态、越界拒绝、清空别人的行 / 改别人昵称被拒、主播锁只忽略那一格 |
| `link-identity.test.mjs` | 身份只来自链接、权限只问群名单：访客 / 可写 / 只读（`outOfGroup`）、名单不可信走老口径、时间窗、管理员 cookie、认领层已整体删除 |
| `link-code.test.mjs`、`link-guard.test.mjs` | 群内 6 位短码：登记簿 5 分钟、同一条口令可反复兑换（不作废）、留言页表单与 `hashchange` 兑换；防枚举限流（按 IP、10 次 / 5 分钟冷却、成功清计数） |
| `changes.test.mjs` | 改动记录：只记真正改动的字段、`[原值, 新值]`、越权被拒也留 `reject`、管理员看全部 / 本人只看相关的 |
| `versions.test.mjs`、`table-swap.test.mjs` | 历史版本 / 回退 / 上传覆盖、自动保存存底节流；整表替换作为同一次状态转换并先做结构校验 |
| `write.test.mjs`、`compact.test.mjs`、`member-row-area.test.mjs` | 整理与写队列（段内分区、行号与序号不动、幂等不写）；删行后立刻压紧、锁与绑定跟搬；成员保存的业务行范围 |
| `cycle.test.mjs`、`comma-status.test.mjs`、`attack-status-scope.test.mjs` | 周期清榜与完成情况；逗号分隔的状态词；攻炼状态只作用于该榜 |
| `auto-anchor.test.mjs`、`anchors.test.mjs` | 自动主播收窄（`statusLabels` 与生产同源）；主播区排序与新增主播 |
| `autosave.test.mjs`、`reload-drafts.test.mjs`、`client-state.test.mjs` | 自动保存与草稿；重读与回退语义、撞号挪行；前端草稿状态、群昵称候选浮层、手机端只读与浮层 15 秒自动收 |
| `roster.test.mjs` | 名单候选 / 改名同步 / 退群删行并压紧（同一趟里改名 + 退群都要写成） |
| `body-limit.test.mjs` | 请求体契约：边界、超限后继续追加、连接中断 |

## 不参与 `run.mjs` 收集的脚本

- 公共设施：`_helper.mjs`（路径推导 / 断言器 / 框架全局桩）、`env.mjs`（隔离配置）、`fixtures/`（合成样本与快照）、
  `editor/test/{harness,page-vm,source,plugin,fake-dom,strip,_query}.mjs`。
- 手动工具：`render-check.mjs`（渲染成 PNG 人工看图，需在机器人根目录、要浏览器）、
  `verify-xlsx.ps1`（用 .NET 的 ZIP/XML 解析器独立复核生成的文件）、
  `check-deploy.mjs`（源码仓库与部署目录一致性）、`editor/test/compare-editors.mjs`（本机与线上编辑器对比）。

```powershell
powershell -File test/verify-xlsx.ps1 -Modified <生成的文件> -Original <原表格> -Sheet 2 -Row 27
node test/check-deploy.mjs "<部署目录>"      # 默认查本机部署目录
node test/render-check.mjs [输出目录]        # 产物默认写系统临时目录
```

`verify-xlsx.ps1` 的 `-Sheet` 是写入的工作表序号（1 起，对应 `xl/worksheets/sheetN.xml`），`-Row` 是写入行号；
脚本会回读该行 B–H 的文本、比对结构标签数量、校验未改动工作表逐字节一致。

## 前置与跳过

被测表格来源是**三层**（缺表不整套跳过）：`XLSX_PATH` 指了就用它 / 维护者机器上那份真实表 /
`fixtures/sample-table.mjs` 现生成匿名合成样本到 `test/.test-tmp/`（已忽略）。所以没有「缺表就整套跳过」这回事，
唯一会因此整套跳过的是 `editor-host.test.mjs`（要 `<插件根>/data/queue.xlsx` 真在）。

**「真实表」的判据不是路径是内容**（`_helper.mjs` 的 `isRealTable()`）：合成样本复制到别处再用 `XLSX_PATH`
指过去仍算样本，`template.test.mjs` 那条「数据区样式与下方空行一致」会跳过。CI 的第二个 job（`test-xlsx`）
先生成样本、复制到 `$RUNNER_TEMP`、再用 `XLSX_PATH` 指过去跑全量，覆盖「从磁盘读工作簿 → 按行号写回」这条链路
（第一个 job 走 `ABYSS_TEST_SYNTHETIC=1` 的内存样本，那条链路一步都不走）。`requireSource()` 因此是**异步**的，
一律写 `await requireSource()`。

真正缺前置的套件（浏览器、编辑器进程起不来）打印 `⏭ 套件跳过：原因` 并 `exit 0`，不算失败但也不算通过；
条件只对部分用例成立的，用 `check(name, fn, 跳过原因)` 记一条 `⏭`，同套件其余断言照跑。

## 约定

1. **任意 cwd 可跑**：路径一律经 `_helper.mjs` 的 `Paths` 推导，禁止裸相对字面量与盘符绝对路径。
2. **不改动源数据**：被测表格复制成副本再改，结束时校验原表哈希未变；夹具产物写 `test/.test-tmp/`。
3. **必须有断言与退出码**：断言器只有两个来源，都在 `test/_helper.mjs`——`createChecker()`（回调抛错即中断）
   与 `createSoftChecker()`（失败记 ❌ 继续跑，`finish()` 汇总并按失败数设退出码）。两者都**真的跑回调**：
   `typeof ok === "function"` 就调用、同步 / 异步都等结果——写成 `if (ok)` 只会印 ✅ 而一条断言都没执行。
4. **框架全局桩集中在 `_helper.mjs`**：`installFrameworkStubs()` 必须在 import 插件代码**之前**调用；
   上下文按「规则集 + 会话」隔离，多个 app 类不会互相串上下文。
5. **入口类必须经 `index.js` 装载**：`workflow.test.mjs` 用 `await import("../index.js")` 取 `apps`，与框架 loader 一致。
6. **数据目录口径只有一个**：数据固定在 `<插件根>/data`（`data/` 已被 git 忽略），生产口径不许离开插件目录。
   会起编辑器进程的套件必须显式设 `ABYSS_EDITOR_TEST_PATHS=1`；插件侧由 `env.mjs` 设 `ABYSS_QUEUE_TEST_PATHS=1`
   并用环境变量把落点指到临时目录（表格、绑定、白名单、重启标记等）。白名单必须重定向——它决定 `#排队`
   发群里还是私聊，不指的话维护者本机真实白名单会漏进套件。**生产部署绝不要设这两个开关。**
7. **端口一律现要**：会起编辑器的套件用 `freePort()` 绑 0 让系统挑，拿到的值原样传给 `--port`；
   `harness.startEditor()` 起不来会换端口重试。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `XLSX_PATH` | 指定被测表格（优先级最高） |
| `ABYSS_TEST_SYNTHETIC=1` | 强制用合成样本 |
| `ABYSS_TEST_TIMEOUT_MS` | 单套超时（毫秒），默认 `120000`；不是正数退 2 |
| `ABYSS_QUEUE_TEST_PATHS=1` | 插件侧落点放行开关（`env.mjs` 自动设） |
| `ABYSS_QUEUE_CONFIG` | 隔离配置的路径（`env.mjs` 自动设） |
| `ABYSS_QUEUE_{STORE,STATE,BACKUP,ADMINS,MANAGER_LINK,RESTART_FLAG,XLSX}_*` | 把绑定 / 进度 / 备份 / 白名单 / 私聊链接状态 / 重启标记 / 表格指到临时目录（只在放行开关下生效） |
| `ABYSS_EDITOR_TEST_PATHS=1` | 编辑器落点放行开关（起编辑器进程的套件必设） |
| `ABYSS_PLUGIN_DIR` | 编辑器套件定位插件根（默认按 `editor/test/` 上两级推） |
| `ABYSS_TEST_BROWSER`、`RENDER_CHECK_WIDTH` | `render-check.mjs` 的浏览器 / 截图宽度 |
| `ABYSS_DEPLOY_DIR` | `check-deploy.mjs` 的默认部署目录 |