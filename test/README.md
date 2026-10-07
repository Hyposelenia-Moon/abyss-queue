# 回归套件

不依赖 Yunzai，也不启动机器人进程。`node test/run.mjs` 顺序跑 `test/*.test.mjs` 与
`editor/test/*.test.mjs`（插件侧 25 个 + 编辑器侧 26 个 = 51 个），汇总后按失败数给退出码。
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
ABYSS_TEST_TIMEOUT_MS=300000 pnpm test # 调单个套件的超时（默认 120000 = 120 秒）
```

关键词是**位置参数**（`--list` 之外，`--` 开头的参数一律被忽略）；给了关键词却一个都没匹配上时退 1，
打错名字不会静默变成"跑全量"。

**每套都有超时**：超时按**失败**计（"没跑完"不等于"通过"），并杀掉**整棵进程树**——套件会起真实
子进程（编辑器、宿主的 HTTP 服务），吊住一个就让 `pnpm test` 永远不返回，而 Windows 上
`child.kill()` 只杀直接子进程，留下的孤儿会继续占着那张表、把后面的套件一起带红。

**干净克隆先装依赖**：在机器人根目录 `pnpm install --filter=abyss-queue`（本仓库所在的工作区由机器人根
统一管理，锁文件也在那儿）；只想装这一个插件、或在插件目录里单独跑，则用 `npm i`。
`jszip` / `yaml` 是运行时依赖，`express` 只有
`test/editor-host.test.mjs` 用（要真摆出框架那四个 body parser，才验得了"请求体不被读空"），
所以列在 `devDependencies`。借宿主上层的 `node_modules` 也能跑到，但那是巧合，不是依赖声明。

## 插件侧套件（`test/`）

| 套件 | 覆盖 |
| --- | --- |
| `workbook.test.mjs`、`template.test.mjs` | 表格层：结构解析（表头行 / 列映射 / 下拉选项 / 主播区 / 数据区末日行）、报名写入、人工维护要素保全、特殊字符往返、改备注与退队、原表未被触碰；空模板"结构在、数据不在、样式规范" |
| `xlsx-row-tag.test.mjs` | 自闭合 `<row r="9"/>` 的写入：必须就地换成成对标签，不跟"这一行不存在"共用 `insertRow` 分支 |
| `clearrow-style.test.mjs`、`compact-style.test.mjs`、`save-row-style.test.mjs` | 逐行样式保全的三条路：清空同一行再填回来 / 删行后整体上移 / 普通保存写已存在的行——都不许抹平行自己的底色 |
| `workflow.test.mjs` | 工作流：经 `index.js` 的 `apps` 导出装载入口类，复刻 loader 的规则匹配与上下文分发，覆盖全部命令、引导流程、错误路径、**唯一一条定时任务**与进度通知末尾的 @ 下一位（绑定优先 / 名单兜底 / 都拿不到就不 @） |
| `commands.test.mjs` | 命令一致性：注册规则 / 处理器解析 / 分页提示同源（全名、简称、别名、序号、后缀式、全量查看） |
| `aliases.test.mjs`、`progress.test.mjs`、`locate-self.test.mjs` | 主播别名归一；完成判定与「下一位」；按 QQ 定位（同名不得认领别人已绑定的行） |
| `notify.test.mjs`、`notice.test.mjs` | 定时通知：一条 tick 里的五件事、开榜时刻口径、月末催办与名单同步/每日整理的去重（时间由 `tick(now)` 注入，不 mock 全局 `Date`）；关掉通知时名单同步与每日整理仍照做；主人首启提示 |
| `manager-link.test.mjs` | 管理员的私聊链接：主人 / 白名单管理员发 `#排队` 走私聊（群里一个都不发）、普通群友照旧群内发；私聊那份是带当期 `w/ws` 的长地址，**只在本人发 `#排队` 时给一次**（带那一刻的当期窗口、在那一刻验得过）；**tick 不主动发链**——窗口变没变都一条不发、也不动状态文件；状态文件记「发给了谁 / 哪个窗口 / 消息 id」；私聊发不出去只在群里报一句原因 |
| `roster.test.mjs` | 机器人推群成员名单：签名身份、成员映射、空名单不推 |
| `layout.test.mjs` | 版式契约：三张渲染模板与编辑器主表的列对齐规则（只查规则有没有被改回去，出图人工看走 `render-check.mjs`） |
| `render-fallback.test.mjs` | 出图发送链的失败口径：只有确认发出去了才算成功，重试仍失败要落到纯文本兜底；**规范署名行（小尾巴）**在单榜 / 主播列表的图上与文本兜底末尾都在 |
| `remote-cache.test.mjs`、`snapshot-backup.test.mjs`、`backup.test.mjs` | 快照缓存键（只改 `sharedStrings` 也要重建模型）；有效备份在解析 + 验收成功后才更新；本地每日备份只留最新一份 |
| `init.test.mjs` | `#排队初始化`（**三步**）：口令与密钥 / 白名单 / 探活走完；遇错即停、重复执行零落盘、非 master 一个字节都不写（探活走注入的桩）；**坏配置时第 1 步 ❌ 且原字节不动、报错不带配置行内容** |
| `editor-host.test.mjs`、`autostart.test.mjs` | 编辑器宿主：挂到 bot 自己的 HTTP server 后前缀认 `/queue`、`/queueX` 不吞、框架路径照旧、**带 body 的请求不挂死**、凭证只有 `config.remote` 一份来源、重复调用不重复挂载、互锁探针语义（**不带口令**，200 / 403 都算「有编辑器」）；`remote.autostart` 按扩展名挑解释器拉起编辑器 |
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
| `status-rename.test.mjs` | 群昵称变更 → 「帮帮完成情况」跟着改：三条路径（本人保存 / 管理员改行 / 群名单同步）都钉「旧名变成新名」（含别人那一行）与「不误伤」（前缀相同的别人的名字、主播名、状态词）；两行同名或没有可依据的绑定时**宁可不动**并给出说明 |
| `save-conflict.test.mjs`、`anchor-version.test.mjs`、`write-queue.test.mjs` | 保存时的版本冲突（前端接住 409、主播列表也带版本）；所有写入口共用同一条提交队列 |
| `anchor-add.test.mjs` | 主播列表**新增主播**：入口只对主人 / 白名单管理员渲染（本人 / 访客页面上根本没有这个控件）；保存走 `/api/anchors` 的 `added`（带 `version`、409 保留草稿）；真接口下这一行真的插进表里，且数据行逐字下移、行号引用与归属绑定一起跟着走 |
| `table-swap.test.mjs` | 整表替换：表、绑定、完成情况锁作为同一次状态转换，替换前做结构校验 |
| `lock-compact.test.mjs`、`member-row-area.test.mjs` | 压紧行时完成情况锁的迁移；成员保存的**业务行范围**（表头与主播区不能被当成新增成员行写） |
| `client-state.test.mjs`、`reload-drafts.test.mjs` | 前端草稿状态（新增行的提交口径、草稿的「榜 × 行」两维归属）；「重新读取」与「回到上一次修改状态」的语义 |
| `roster.test.mjs`、`versions.test.mjs` | 群成员名单的候选 / 改名同步 / 退群删行并压紧；历史版本、回退与上传覆盖云端（两个编辑器进程一起跑） |
| `empty-nick.test.mjs` | 身份里的群名片为空（云端群名单里没这个人）时：建行保存的昵称**再读一次仍在**（空串不许回写昵称格）、非空名片改名照旧同步、空名单/名单里没这个人不删行不清昵称 |
| `body-limit.test.mjs` | 请求体契约：边界、超限后继续追加、连接中断 |
| `link-claim.test.mjs` | 链接认领与 5 分钟时间窗：认领后同设备身份 / 角色正确、**别人带同一条链接只能看**（写接口 403）；管理员 cookie `Max-Age=86400`、群友只种会话 cookie；当前与上一窗口可用、更旧的窗口 410（含被改过的签名与"未来"的窗口）；**没带 `w/ws` 的老链**换一台设备一律 410 + 可读提示（口子已关）、认领过它的那台设备不带窗口照旧放行；认领文件损坏 / 条目过期一律当未认领、不崩 |

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

所以**没有"缺表就整套跳过"这回事**，唯一会因此整套跳过的是 `test/editor-host.test.mjs`：
它要 `<插件根>/data/queue.xlsx` 真在（宿主挂载编辑器必须有那张表），干净仓库上按设计打印 `⏭ 套件跳过`。

`requireSource()` 因此是**异步**的：一律写 `await requireSource()`（它对字符串 / thenable 都安全）。
`ABYSS_TEST_SYNTHETIC=1` 强制走第 3 层，用来在本机复验"没有真实表也零跳过、全绿"
（唯一按设计整套跳过的仍是需要 `data/queue.xlsx` 的 `test/editor-host.test.mjs`）。

真正缺前置的套件（浏览器、假云端、编辑器进程起不来等）打印 `⏭ 套件跳过：原因` 并 `exit 0`，
**不算失败**（但也不算通过：`run.mjs` 把它们单独计数并列出套件名）。
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
     —— 插件侧的落点已经**不是配置项**（配置里没有路径键），只能这样重定向。覆盖到的落点：
     绑定（`ABYSS_QUEUE_STORE_FILE`）、进度快照（`_STATE_FILE`）、快照备份（`_BACKUP_DIR`）、
     白名单（`_ADMINS_FILE`）、私聊链接状态（`_MANAGER_LINK_FILE`）、
     重启标记（`_RESTART_FLAG`）；表格（`_XLSX_PATH`）只给 `cloud: false` 的表格层套件。
     白名单那一处**不是方便而是隔离**：它决定 `#排队` 往群里发还是私聊发，不指的话维护者本机
     真实白名单会漏进套件——某条断言的绿红就取决于"本机恰好这个号是不是管理员"。
     备份与重启标记是本条口径补上的两处：前者由 `model/remote.js` 在拉到快照后写
     （默认 `data/backup`），后者由 `components/boot.js` 的**退出钩子**在子进程退出时写
     （默认 `data/restart.flag`，`boot()` 只由 `index.js` 装配，所以 import 了入口的套件都会碰到）。
     重启标记的兜底值由 `_helper.mjs` 在模块求值时设好——`init.test.mjs` 这类只经 `_helper.mjs`、
     不 import `env.mjs` 的套件同样跑在临时目录里，不会写进仓库 `data/`。
     **不要**为了"套件别写文件"去掉写标记的行为：那是启动器判断「重启还是停服」的机制。
   这条由 `editor/test/data-confinement.test.mjs` 钉住（生产拒绝 / 测试放行 / 出圈回落）；
   **生产部署绝不要设这两个开关**。
8. **端口一律现要，不写死**：会起编辑器进程的套件用 `freePort()`（`test/_helper.mjs`；编辑器侧从
   `editor/test/harness.mjs` 或 `../../test/_helper.mjs` 取）——绑 `0` 让系统挑一个空闲端口再放开，
   拿到的值**原样传给 `--port`**。固定端口只要撞上（两套并发跑、本机留着个没退干净的编辑器、别的
   程序占了那个号）就会以 `fetch failed` / "编辑器没起来"变红，排查成本全落在下一个人身上。
   放开到子进程重新绑上有极小窗口，所以 `harness.startEditor()` 那种"起不来就换一个端口重试"
   的机制照旧保留。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `XLSX_PATH` | 指定被测表格（优先级最高） |
| `ABYSS_TEST_SYNTHETIC=1` | 强制使用合成样本，跳过真实表 |
| `ABYSS_TEST_TIMEOUT_MS` | 单个套件的超时（毫秒），默认 `120000`；不是正数直接退 2 |
| `ABYSS_QUEUE_TEST_PATHS=1` | 插件侧落点放行开关（`env.mjs` 自动设，仅在测试进程内） |
| `ABYSS_QUEUE_CONFIG` | 隔离配置的路径（`env.mjs` 自动设，避免读写仓库里的 `config/config.yaml`） |
| `ABYSS_QUEUE_STORE_FILE`、`_STATE_FILE`、`_BACKUP_DIR`、`_ADMINS_FILE`、`_MANAGER_LINK_FILE`、`_RESTART_FLAG`、`_XLSX_PATH` | 把绑定 / 进度 / 备份 / 白名单 / 私聊链接状态 / 重启标记 / 表格指到临时目录（只在 `ABYSS_QUEUE_TEST_PATHS=1` 下生效；表格只给表格层套件用） |
| `ABYSS_EDITOR_TEST_PATHS=1` | 编辑器落点放行开关（起编辑器进程的套件必设） |
| `ABYSS_TEST_EDITOR_MJS` | **只给 `editor/test/empty-nick.test.mjs`**：换成别处的一份 `editor.mjs` 来跑（默认是工作树里那份）。用途是把"修复前的旧逻辑"复制出去跑一遍，看这套断言会不会变红——它是套件内置的对照入口，产品代码不读它 |
| `ABYSS_PLUGIN_DIR` | 编辑器套件定位插件根（默认按 `editor/test/` 上两级推） |
| `ABYSS_TEST_BROWSER`、`RENDER_CHECK_WIDTH` | `render-check.mjs` 指定浏览器 / 截图宽度 |
| `ABYSS_DEPLOY_DIR` | `check-deploy.mjs` 的默认部署目录 |
