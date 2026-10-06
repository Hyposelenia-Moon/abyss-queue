# 回归套件

不依赖 Yunzai，也不启动机器人进程。`node test/run.mjs` 顺序跑 `test/*.test.mjs` 与
`editor/test/*.test.mjs`（插件侧 25 个 + 编辑器侧 22 个 = 47 个），汇总后按失败数给退出码。
被测表格只操作**副本**，结束时校验原表哈希未变。

## 运行

```bash
pnpm test                            # = node test/run.mjs
node test/run.mjs --list             # 列出全部套件（打印相对插件根的路径）
node test/run.mjs workbook cache     # 只跑相对路径含这些关键词的套件
node test/workbook.test.mjs          # 单跑某个套件（任意 cwd 均可）
node test/run.mjs editor             # 只跑编辑器那一半（关键词按相对路径匹配）
XLSX_PATH="D:/别的表.xlsx" pnpm test  # 指定被测表格
ABYSS_TEST_SYNTHETIC=1 pnpm test     # 强制用合成样本（验"没有真实表也全绿、零跳过"）
```

关键词是**位置参数**（`--list` 之外，`--` 开头的参数一律被忽略）；给了关键词却一个都没匹配上时退 1，
打错名字不会静默变成"跑全量"。

## 插件侧套件（`test/`）

| 套件 | 覆盖 |
| --- | --- |
| `workbook.test.mjs`、`template.test.mjs` | 表格层：结构解析（表头行 / 列映射 / 下拉选项 / 主播区 / 数据区末日行）、报名写入、人工维护要素保全、特殊字符往返、改备注与退队、原表未被触碰；空模板"结构在、数据不在、样式规范" |
| `xlsx-row-tag.test.mjs` | 自闭合 `<row r="9"/>` 的写入：必须就地换成成对标签，不跟"这一行不存在"共用 `insertRow` 分支 |
| `clearrow-style.test.mjs`、`compact-style.test.mjs`、`save-row-style.test.mjs` | 逐行样式保全的三条路：清空同一行再填回来 / 删行后整体上移 / 普通保存写已存在的行——都不许抹平行自己的底色 |
| `workflow.test.mjs` | 工作流：经 `index.js` 的 `apps` 导出装载入口类，复刻 loader 的规则匹配与上下文分发，覆盖全部命令、引导流程、错误路径与**唯一一条定时任务** |
| `commands.test.mjs` | 命令一致性：注册规则 / 处理器解析 / 分页提示同源（全名、简称、别名、序号、后缀式、全量查看） |
| `aliases.test.mjs`、`progress.test.mjs`、`locate-self.test.mjs` | 主播别名归一；完成判定与「下一位」；按 QQ 定位（同名不得认领别人已绑定的行） |
| `notify.test.mjs`、`notice.test.mjs` | 定时通知：一条 tick 里的四件事、开榜时刻口径、月末催办与名单同步去重（时间由 `tick(now)` 注入，不 mock 全局 `Date`）；主人首启提示 |
| `roster.test.mjs` | 机器人推群成员名单：签名身份、成员映射、空名单不推 |
| `layout.test.mjs` | 版式契约：三张渲染模板与编辑器主表的列对齐规则（只查规则有没有被改回去，出图人工看走 `render-check.mjs`） |
| `render-fallback.test.mjs` | 出图发送链的失败口径：只有确认发出去了才算成功，重试仍失败要落到纯文本兜底 |
| `remote-cache.test.mjs`、`snapshot-backup.test.mjs`、`backup.test.mjs` | 快照缓存键（只改 `sharedStrings` 也要重建模型）；有效备份在解析 + 验收成功后才更新；本地每日备份只留最新一份 |
| `init.test.mjs` | `#排队初始化`：五步走完、遇错即停、重复执行零落盘、非 master 一个字节都不写（计划任务与探活走注入的桩） |
| `init-launcher.test.mjs`、`launcher-guard.test.mjs`、`autostart.test.mjs` | 初始化产物 → 自动拉起 → 探活（临时合成宿主，路径故意带空格与中文）；启动器两条护栏（端口被占用只报告不杀进程、坏快照没通过工作簿验收就不替换）；编辑器随机器人启动 |
| `guoba.test.mjs` | 锅巴三段式配置：模板的 `${变量}` 与 `CONFIG_FIELDS` 一一对应、三份配置结构一致、真往返、注释按模板保留、schema 漂移守卫 |
| `update.test.mjs` | 自我更新：`#排队更新` / `#排队强制更新` 的判定（按提交号判有没有新代码、没有新代码不重启、失败不吞不谎报重启） |

## 编辑器侧套件（`editor/test/`）

| 套件 | 覆盖 |
| --- | --- |
| `editor.test.mjs` | 端到端：字段与下拉选项、口令与身份签名、白名单权限、完成情况锁定、写入校验、健康检查 |
| `mount.test.mjs`、`owner-only.test.mjs` | 子路径挂载（nginx `proxy_pass` 不带尾斜杠）；主人专用模式（除主人外一律打不开，`/api/snapshot` 例外） |
| `acl-roles.test.mjs`、`identity.test.mjs`、`sign-key.test.mjs` | 权限只按稳定 QQ 判（群昵称不算）；身份签名（换口令、改内容、过期都过不了）；签名密钥与访问口令分开后，拿口令伪造的身份必须被拒 |
| `fail-closed.test.mjs`、`data-confinement.test.mjs` | 漏配就"起不来"而不是"敞着门"；数据落点生产模式不许出插件，`ABYSS_EDITOR_TEST_PATHS=1` 才放行 |
| `row-ownership.test.mjs`、`ownership.test.mjs` | 行归属：同名的两个 QQ 走真接口互不认领；归属状态审计与按当前表重建 |
| `save-conflict.test.mjs`、`anchor-version.test.mjs`、`write-queue.test.mjs` | 保存时的版本冲突（前端接住 409、主播列表也带版本）；所有写入口共用同一条提交队列 |
| `table-swap.test.mjs` | 整表替换：表、绑定、完成情况锁作为同一次状态转换，替换前做结构校验 |
| `lock-compact.test.mjs`、`member-row-area.test.mjs` | 压紧行时完成情况锁的迁移；成员保存的**业务行范围**（表头与主播区不能被当成新增成员行写） |
| `client-state.test.mjs`、`reload-drafts.test.mjs` | 前端草稿状态（新增行的提交口径、草稿的「榜 × 行」两维归属）；「重新读取」与「回到上一次修改状态」的语义 |
| `roster.test.mjs`、`versions.test.mjs` | 群成员名单的候选 / 改名同步 / 退群删行并压紧；历史版本、回退与上传覆盖云端（两个编辑器进程一起跑） |
| `body-limit.test.mjs` | 请求体契约：边界、超限后继续追加、连接中断 |

## 不参与 `run.mjs` 收集的脚本

- 公共设施与夹具：`_helper.mjs`（路径推导 / 断言计数 / 框架全局桩）、`env.mjs`（隔离配置 + 假云端）、
  `fixtures/sample-table.mjs`（匿名合成样本生成器）、`fixtures/_snapshot-xlsx.mjs`（合成快照夹具）、
  `editor/test/harness.mjs`、`editor/test/page-vm.mjs`、`editor/test/source.mjs`、`editor/test/plugin.mjs`。
- `render-check.mjs`：把模板渲染成 PNG，人工看图（需在**机器人根目录**执行，要浏览器）。
- `verify-xlsx.ps1`：用 .NET 的 ZIP/XML 解析器（与插件实现完全不同的一套）独立复核生成的文件。
- `check-deploy.mjs`：源码仓库与部署目录的一致性自查（脏改动会挡住 `#更新`）。
- `editor/test/compare-editors.mjs`：本机编辑器与线上编辑器对同一份数据的行为对比。

```powershell
powershell -File test/verify-xlsx.ps1 -Modified <生成的文件> -Original <原表格> -Sheet 2 -Row 27
node test/check-deploy.mjs "<部署目录>"      # 默认查本机部署目录
node test/render-check.mjs [输出目录]        # 产物默认写系统临时目录
```

`verify-xlsx.ps1` 的 `-Sheet` 是写入的工作表序号（1 起，对应 `xl/worksheets/sheetN.xml`，如 sheet2 = 幽境危战），
`-Row` 是写入行号；脚本会回读该行 B–H 的文本、比对结构标签数量、校验未改动工作表逐字节一致。

## 前置与跳过

被测表格的来源是**三层**（缺表不整套跳过）：

1. `XLSX_PATH` 指了就用它（指向不存在的路径时也照跑，不会悄悄回落到真实表）；
2. 否则用维护者机器上那份真实表（与插件同级的 `2026年10月三路深渊排队.xlsx`）；
3. 都没有就由 `fixtures/sample-table.mjs` **现生成匿名合成样本**到 `test/.test-tmp/`（已忽略），
   输出里会打印「本次用合成样本（真实表不存在）」。

`requireSource()` 因此是**异步**的：一律写 `await requireSource()`（它对字符串 / thenable 都安全）。
`ABYSS_TEST_SYNTHETIC=1` 强制走第 3 层，用来在本机复验"没有真实表也零跳过、全绿"。

真正缺前置的套件（浏览器、假云端、编辑器进程起不来等）打印 `⏭ 套件跳过：原因` 并 `exit 0`，
**不算失败**；但 `run.mjs` 会把它们单独计数并列出套件名——"跳过"和"通过"不能混为一谈。
条件只在部分用例上成立的（例如没有 `.git` 元数据时没法验"运行时文件真被 git 忽略"），
用 `check(name, fn, 跳过原因)` 记一条 `⏭`，那一项不进 passed，同套件其余断言照跑。

## 约定

1. **任意 cwd 可跑**：路径一律经 `_helper.mjs` 的 `Paths` 推导，禁止裸相对字面量与盘符绝对路径；
   被测表格位置用 `XLSX_PATH` 覆盖。
2. **不改动源数据**：被测表格复制成副本后再改，结束时校验原表哈希未变；
   合成样本与夹具产物写 `test/.test-tmp/`（`.gitignore` 已忽略），
   编辑器 / 工作流 / 初始化套件的表副本与隔离配置写在系统临时目录（`env.mjs` 的 `fs.mkdtempSync`）。
3. **必须有断言与退出码**：`createChecker()` 记录每条断言，`finish()` 按失败数设置退出码；
   只打印不判定的脚本不是回归。
4. **框架全局桩集中在 `_helper.mjs`**：`installFrameworkStubs()` 提供 `plugin` / `logger` / `segment` / `Bot`，
   必须在 import 插件代码**之前**调用。上下文按「规则集 + 会话」隔离，一个插件目录下的多个 app 类不会互相串上下文。
5. **入口类必须经 `index.js` 装载**：`workflow.test.mjs` 用 `const { apps } = await import("../index.js")`，
   与框架 loader 的取法一致（插件根有 `index.js` 时 loader 只加载它）。这样"apps 导出漏了某个类"这类回归才测得到。
6. **数据来自假云端**：插件的数据源是云端 `/api/snapshot`，所以 `ensureEnv()` 默认起一个只认这个接口的
   小 HTTP 服务（`startStubCloud`），把临时副本当"云端表"吐出去，并把配置的 `remote.url` 指过去
   （`ttl_ms: 0` = 每次都拉）。表格层套件测本地读写，用 `ensureEnv({ cloud: false })`。
7. **数据目录口径只有一个**：数据固定在插件内 `<插件根>/data`（`data/` 已被 git 忽略），
   **生产口径不许离开插件目录**。套件的数据在临时目录里，所以：
   - 会起编辑器进程的套件必须显式设 `ABYSS_EDITOR_TEST_PATHS=1`（否则编辑器按生产口径直接拒绝启动）；
   - 插件侧套件由 `env.mjs` 统一设 `ABYSS_QUEUE_TEST_PATHS=1`，并用环境变量把落点指到临时目录
     —— 插件侧的落点已经**不是配置项**（配置里没有路径键），只能这样重定向。
   这条由 `editor/test/data-confinement.test.mjs` 钉住（生产拒绝 / 测试放行 / 出圈回落）；
   **生产部署绝不要设这两个开关**。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `XLSX_PATH` | 指定被测表格（优先级最高） |
| `ABYSS_TEST_SYNTHETIC=1` | 强制使用合成样本，跳过真实表 |
| `ABYSS_QUEUE_TEST_PATHS=1` | 插件侧落点放行开关（`env.mjs` 自动设，仅在测试进程内） |
| `ABYSS_QUEUE_CONFIG` | 隔离配置的路径（`env.mjs` 自动设，避免读写仓库里的 `config/config.yaml`） |
| `ABYSS_QUEUE_STORE_FILE`、`_STATE_FILE`、`_XLSX_PATH`、`_BACKUP_DIR` | 把绑定 / 进度 / 表格 / 备份指到临时目录（只在 `ABYSS_QUEUE_TEST_PATHS=1` 下生效） |
| `ABYSS_EDITOR_TEST_PATHS=1` | 编辑器落点放行开关（起编辑器进程的套件必设） |
| `ABYSS_PLUGIN_DIR` | 编辑器套件定位插件根（默认按 `editor/test/` 上两级推） |
| `ABYSS_TEST_BROWSER`、`RENDER_CHECK_WIDTH` | `render-check.mjs` 指定浏览器 / 截图宽度 |
| `ABYSS_DEPLOY_DIR` | `check-deploy.mjs` 的默认部署目录 |
