# AGENTS.md（abyss-queue 项目级开发文档）

> **规则分两层，先看这一段的归属**：
> - **用户级**：`~/.dsh/AGENTS.md` —— 跨项目通用（先设计再动手、**不执行任何 git 操作**、提交摘要格式、只用简体中文、向外部发东西前先确认…）。本项目同样适用，本文不再重复。
> - **项目级**：就是本文 —— 只对 `abyss-queue` 生效：结构、数据链路、硬约定、命令、本机事实、踩过的坑。
>
> 两者冲突时以项目级为准（更具体）；项目级没写的按用户级来。

---

## 一、这是什么

群友在 QQ 群里查「三路深渊排队」的机器人插件（TRSS-Yunzai v3；`index.js` 导出 `{ apps }`，loader 只认它）＋随仓库一起部署的**云端编辑器**。

- **插件只读**：从 `<remote.url>/api/snapshot?k=<token>` 拉一份 xlsx 快照 → 解析 → 渲染成图发群；
- **编辑器是唯一写入口**：填表 / 改表 / 白名单 / 历史版本 / 归档都在它那儿（`editor/`）；
- **数据本体是服务器上那份 xlsx**，仓库里只有 `resources/空模板.xlsx`（结构在、数据不在）。

数据链路：

```
群友 ──#排队──▶ 机器人出图 + 个人短链 ──点开──▶ 编辑器 /s/<码>
                                                  │ 验码 → 302 到带身份的长地址
                                                  ▼
                                        只改自己那一行 → 存回 xlsx
                                                  │
                    机器人下次拉快照（ttl_ms）◀─────┘
```

## 二、目录（新文件该放哪）

| 目录 | 职责 |
| --- | --- |
| `apps/` | 指令层：`queue.js`（`#排队` / `#主播` + **唯一一条定时任务** `tick()`：完成轮询、开榜提醒、月末催办、名单同步）、`_base.js`（插件基类：`safe()`、`models()`、`store()`、`nickname()`） |
| `components/` | 组装层：`config.js`（默认值 + 合并 + 首启生成 config.yaml）、`render-html.js`（出图、图与文案合成一条消息、失败回退文本）、`roster.js`（把群名单推给编辑器）、`init.js`（`#排队初始化`：本机编辑器那套手工初始化的编排，主人专用、遇错即停）、`constants.js`、`font.js`、`pluginVersion.js` |
| `lib/` | 纯逻辑：`identity.js`（**身份签名 + 短码，编辑器共用**）、`schema.js`（xlsx 结构识别）、`progress.js`（完成判定 / 进度快照 / 开榜时刻 / 「到点没到点」）、`notify.js`（唯一那条定时任务的编排：去重状态 + 这一轮该发什么，纯函数）、`render.js`（视图数据 + 文本），另有 `queue.js` / `router.js` / `aliases.js` / `text.js` / `xlsx.js` / `logger.js` / `patches.js`（部署补丁自检） |
| `model/` | 数据层：`table.js`（读写 xlsx、保留格式）、`remote.js`（拉云端快照 + 本地备份）、`store.js`（QQ→行 绑定）、`index.js` |
| `resources/queue/*.html` | 三张渲染模板（`menu` / `queue` / `anchors`），样式内联、不引外部资源 |
| `editor/` | 云端编辑器：`editor.mjs`（服务端）+ `editor.html`（前端），**本机与云端同一份代码**；说明见 `editor/README.md`、`editor/DEPLOY.md` |
| `test/`、`editor/test/` | 回归套件 + `env.mjs`（假云端）、`_helper.mjs`（路径/断言/框架全局桩）、`render-check.mjs`（出图自查） |
| `tools/` | `make-template.mjs`：从真实表生成 `resources/空模板.xlsx` |
| `config/config.yaml.example` | **新增配置键的唯一来源**（运行时 config.yaml 由它复制生成） |

## 三、硬约定（改代码前必读）

1. **插件不写表**：任何写操作都在编辑器里；插件连 `.bak` 都不碰。
2. **三个密钥互不相同**：`token`（口令，会出现在链接里）／`sign_key`（身份签名，**绝不进链接**）／`admin_token`（管理备用入口）。签名用口令 = 谁拿到链接都能伪造身份（`editor/test/sign-key.test.mjs` 盯着）。
3. **短链**：`<remote.url>/s/<16 字符码>`；码 = 用签名密钥置换后的 QQ + 7 字节 MAC（`signTicket` / `verifyTicket`），**单段、不透明、编辑器不用存映射**；有效期按 30 天一个窗口，认"当期 + 上一期"→ 实际 30~60 天。改这段逻辑要同时跑 `editor/test/short-link.test.mjs`。
4. **出图与文案同一条消息**：渲染时必须传 `cfg.retType = "base64"`（框架默认会把图自己发掉 → 变成两条消息），再自己 `reply([图, "\n", 文案])`。
5. **框架的 `e.reply` 把发送失败吞成返回值 `{ error }`**（`lib/plugins/loader.js` 的 reply 包装），不抛错 —— 兜底判断必须看返回值（`components/render-html.js` 的 `sendFailed()`）。
6. **列对齐规则**：文本列左、状态/数字列居中、**表头跟着内容走**（三张模板 + 编辑器主表一致，`test/layout.test.mjs` 钉住）。
7. **xlsx 一切靠内容识别**：表头行、列映射、数据区末日行、主播区都从内容推断（`lib/schema.js`），不写死行号列号；各榜表头行号本来就不同。
8. **配置可自行修改**：群号、口令、签名密钥等都在 `config/config.yaml`；新增键要同时写进 `config.yaml.example`、`README.md` 和（必要时）部署手册；缺群号时启动日志要提示。
9. **注释与命名**：中文注释讲"为什么"（这个项目的历史坑很多，注释就是防再踩）；对外函数写 JSDoc；纯逻辑放 `lib/`、可测试，`apps/`/`components/` 只做组装。
10. **测试与文档同步**：改了行为就改对应套件与 README；套件里的断言必须**能失败**。
11. **数据只能待在插件目录里**（`<插件根>/data`，即 `<Yunzai>\plugins\abyss-queue\data`）——表格副本、启动器、日志、绑定/进度/字体/版本/归档都在这里。`data/` 已被 git 忽略，所以 `#更新 abyss` 只动代码不动数据。**没有任何配置项能把数据挪出去**，两种口径分得很清：
    - **生产**（默认）：编辑器解析出的表（`--file` / `xlsx_path`）不在 `<插件根>\data` 里 → **报错退出**（不"纠正"到别处继续跑）；`ABYSS_EDITOR_*_FILE` / `_DIR` 与 `--admins` 一律忽略（记 warn），绑定/白名单/锁/群名单/`versions/`/`archives/` 全部派生自 `<插件根>\data`。插件侧 `store_file` / `snapshot_backup.dir` / `notify.state_file` 解析到插件外 → 记 **error** 并**回落到 `data/` 下的默认值**（机器人要能起来，不静默写到外面、也不崩）；字体缓存没有配置项，本身就是 `data/fonts`。
    - **测试**：套件显式设 `ABYSS_EDITOR_TEST_PATHS=1`（编辑器）与 `ABYSS_QUEUE_TEST_PATHS=1`（插件侧，由 `test/env.mjs` 统一设），才允许指到系统临时目录。**生产部署绝不要设这两个开关**——设了规则就等于不存在。
    - 部署脚本（`tools/deploy-windows.ps1`）的数据目录固定为 `<插件根>\data`，**连 `-DataDir` 参数都没有**（传了会被 PowerShell 当场拒绝），老口径 `abyss-queue-data` 已废弃；`test/deploy-windows.test.mjs` 与 `editor/test/data-confinement.test.mjs` 钉住这两条。
12. **初始化只认 master，遇错即停、不自动覆盖已有产物**：`#排队初始化`（`components/init.js`）把本机编辑器那套手工初始化按固定顺序做完（数据目录 → 表格副本 → 口令/签名密钥 → 启动器产物 → 白名单 → 计划任务 → 探活）。
    - **只认 master**：规则上 `permission: "master"`（框架 `filtPermission`）与 handler 里 `e.isMaster` 各挡一道，两道都留着；非主人**一个字节都不写**（连数据目录都不看）。
    - **遇错即停**：任何一步 ❌ 立刻返回，后面的步骤一步都不做，报告里列清「已完成 / 未做」；把异常翻成 ❌ 也只是**停在那里**，绝不吞掉继续。
    - **不覆盖**：文件 / 计划任务已存在就只校验 + 报告；与当前配置不一致宁可 ❌ 把差异摆给主人看（口令被换掉、任务被改写都会打断正在跑的编辑器）。
    - 副作用（读写文件 / 注册计划任务 / 探活）全部是**可注入的 deps**（`runInit({ fs, exec, fetch, pluginRoot })`，handler 侧的注入点是 `initDeps`）：`test/init.test.mjs` 在临时假插件根里跑完整流程，**不碰真实机器**（不注册真实计划任务、不动仓库 `data/`）。数据目录没有覆盖口子，恒为 `<插件根>\data`。
13. **定时任务只许有一条**（`notify.cron`，默认 `*/3 * * * *` → `apps/queue.js` 的 `tick()`）：四条按频率注册的 cron（队列推送 / 完成轮询 / 月末催办 / 名单同步）已合并成它，**新增任何周期性行为都加在 `tick()` 里，不要再注册第二条任务**。配套口径：
    - **判断与状态在 `lib/notify.js`（纯函数）**：`tickTasks()` 一次性算出「新状态 + 这一轮该发什么」，`apps/queue.js` 只负责取表、@ 人、发消息。周期判断用**内部时间**（`atOrAfter` / `isLastDayOfMonth`），不靠 cron 方言（`L` 之类）。
    - **先算 → 一次落盘 → 再发消息**：四件事的去重状态（`rows` / `open` / `daily`）同在一个 `notify.state_file` 里，一次写清。分开放就会出现"提醒发了、标记没落盘"的窗口，重启就重复 @。发送失败宁可不补发，也不要重复发。
    - **首轮只记基线**：任何"状态翻转才提醒"的功能（当前是开榜提醒）都必须在首轮只记基线，否则首次部署就在群里 @ 所有人。
    - **"到点之后"= 一整天都算数**：机器人半夜关着、早上才起来时要能补做当天那次；重复 tick 由当天标记（本地日期）挡住。
    - 时间要能注入（`tick(now)`）：月末与"每天几点"按真实日历没法在一秒内跑完，`test/notify.test.mjs` 靠注入的日期把两条路径都钉住。

## 四、常用命令

```bash
pnpm test                          # = node test/run.mjs（插件 + 编辑器，全部套件）
node test/run.mjs short-link       # 只跑文件名含关键词的套件
node test/workflow.test.mjs        # 单跑某个套件（任意 cwd）
XLSX_PATH="D:/别的表.xlsx" pnpm test  # 指定被测表格（表格类套件用）

# 出三张图人工看版式（**必须在机器人根目录执行**，字体走 data/fonts 缓存）
node plugins/abyss-queue/test/render-check.mjs [输出目录]

# 起编辑器（本机联调；云端见部署手册）
node editor/editor.mjs --port 7788 --token <口令> --sign-key <签名密钥> \
  --file <xlsx> --mount "" --owner-only
#   ↑ --file 必须指到 <插件根>/data 里的表（生产的硬规则，指到外面直接拒绝启动）；
#     回归套件要指系统临时目录才能用 ABYSS_EDITOR_TEST_PATHS=1
```

## 五、测试约定

- 文件名 `<主题>.test.mjs`，放 `test/` 或 `editor/test/`；`run.mjs` 自动发现。
- **任意 cwd 可跑**：路径一律经 `_helper.mjs` 推导；临时产物只写 `test/.test-tmp/`（已 gitignore）。
- **数据落点的两个开关**：一切套件的数据都在系统临时目录里，所以**会起编辑器进程的套件必须显式设 `ABYSS_EDITOR_TEST_PATHS=1`**（工作区在临时目录，否则编辑器按生产口径拒绝启动）；插件侧套件由 `test/env.mjs` 统一设 `ABYSS_QUEUE_TEST_PATHS=1`。这两条规则由 `editor/test/data-confinement.test.mjs` 钉住，新写套件别忘了。
- **缺前置就跳过**：真实表格、浏览器、假云端拿不到时打印 `⏭ 跳过` 并 `exit 0`，不算失败。
- 框架全局桩（`plugin`/`logger`/`segment`/`Bot`）由 `_helper.mjs` 的 `installFrameworkStubs()` 提供，必须在 import 插件代码**之前**调用；桩要跟着框架真实语义走（例如 `retType=base64` 只返回图片段、不自动发送）。
- 版式改动：`test/layout.test.mjs` 管"规则有没有被改回去"，`render-check.mjs` 管"长什么样"（后者要人看）。
- 定时通知（唯一那条 tick 的四件事）看 `test/notify.test.mjs`：时间一律用 `tick(now)` 注入，**不要 mock 全局 `Date`**；月末催办与"每天几点"按真实日历没法在一秒内跑完。开榜提醒的用例必须包含"首轮只记基线不发"与"重启/重复 tick 不重复"两条，否则等于没验去重。
- 部署一致性：`node test/check-deploy.mjs [部署目录]` 查源码仓库与机器人部署目录是否一致（避免 `#更新 abyss` 因未提交改动被 git 拒绝）；`test/check-launcher.ps1` 静态自检启动器脚本（只解析、不执行）。

## 六、这台机器上的事实（本机环境）

| 项 | 值 |
| --- | --- |
| 插件源码 | `D:\文件\游戏\原神\abyss-queue`（本仓库，唯一的开发处） |
| 机器人部署目录 | `D:\Program Files\Yunzai\Yunzai\plugins\abyss-queue`（**只在 `#更新 abyss` 时更新**，别手改） |
| 运行时数据 | `D:\Program Files\Yunzai\Yunzai\plugins\abyss-queue\data\`（**固定在插件内**；`data/` 已被 git 忽略，所以 `#更新 abyss` 只动代码不动数据。本机编辑器启动器、本地表格副本、群公告、nginx 部署手册都在这里） |
| 本机编辑器 | 启动链：计划任务 `AbyssQueueEditor` → `data\editor-launch.vbs` → `data\editor-launch.mjs` → `editor\editor.mjs`（两个 vbs 都按自身位置自定位）；`--owner-only --cloud --mount ""`，端口 7788，挂在**根目录**；改 `editor.mjs` 要重启它，改 `editor.html` 刷新即可。**注意 `editor-launch.mjs` 读的 `editor-path.txt` 第 1 行必须是部署目录那份 `editor.mjs`**——指到别的仓库就等于把插件根搬到别处，生产口径下会因为表不在它的 `data/` 里而拒绝启动 |
| 机器人 / 主人 / 群 | 机器人 QQ `970464854`；主人 `1733491779`；排队群 `965272093` |
| 协议端 | NapCat（`E:\Apps\NapCat`，OneBot11 → `ws://127.0.0.1:2536`）；NapCat 支持的出站段里**没有 `share`**，卡片类（json/xml）会被 QQ 以"发送者版本过低"挡掉 |
| 出图自查 | Edge headless（`test/render-check.mjs`）；编辑器页面也可 `msedge --headless=new --screenshot` |

## 七、这台机器上的坑（都是踩过的）

- **PowerShell 5.1 的文本 cmdlet 会按 GBK 解码中文**：中文文件一律用 read/write/edit 工具或 node（显式 UTF-8）读写，别用 `Get-Content … | Set-Content …`（曾把 `editor.mjs` 变成一屏 `U+FFFD`）。
- **从会话里起的进程会随会话结束被带走**：长期进程（本机编辑器）必须用计划任务 / 启动器（vbs）拉起，别直接 `node … &`。
- **框架的 `render` 默认自己发图**（见硬约定 4）；`e.reply` 吞异常（见硬约定 5）。
- **别用 `-` / `_` 当短码分隔符**：base64url 里就含这两个字符（曾导致码被切错、偶发 410）。
- **别人能看到的链接里不要放 QQ**：短码走置换加密，别退回"QQ 转 base36 拼签名"。
- **写 xlsx 只经 `model/table.js`**：它能保住条件格式/下拉/公式；清行用 `clearRow`（保持隔行配色与下方空行一致）。
- **定时通知靠群号**：`notify.groups` / `roster.group` 没配就什么都不发（启动日志会提示，别当成功能坏了）。定时任务**只有一条**（`notify.cron` → `tick()`），四件事都在它里面按内部时间判断；"为什么这条通知没发"先看 `notify.state_file` 里的 `open` / `daily` 标记，别再去找第二条 cron。
- **`#更新 abyss` 要求部署目录干净**：手改过部署目录里的被跟踪文件会让 git 拒绝快进，先跑 `test/check-deploy.mjs`。

## 八、安全审查（公网可达 + 会改文件，动编辑器之前对照一遍）

这个项目的编辑器是**公网可达、能改文件**的接口，任何改动都要过一遍这六面（改完把对应套件一起改）：

| 面 | 现状与做法 |
| --- | --- |
| 任意文件读取 | 只有 `/api/download` 会读版本/归档：先 `path.basename()`，再用文件名正则卡死（`queue-\d{8}-\d{6}(-\d+)?\.xlsx` / `queue-\d{4}-\d{2}(-\d{2})?\.xlsx`）；`/api/snapshot` 的全量取是设计内（只凭口令，给机器人用）；没有静态文件服务 |
| 任意文件写入 / 路径穿越 | 写入目标全部由配置派生（`xlsxPath` / `VERSIONS_DIR` / `ARCHIVES_DIR` / `sibling()`）且**必须落在 `<插件根>\data` 里**（生产口径：表出圈就拒绝启动，其余出圈回落插件内默认值；见硬约定 11）；客户端只提供 `id`，用同一套正则校验；上传的字节经 `replaceTable` 解析 + 工作表清单校验后才原子替换 |
| 命令执行 | 编辑器里**没有** `child_process`；插件里只有 `model/remote.js` 的 `autostart`（值来自配置、不是请求），是"本机联调兜底" |
| SSRF | 没有任何"用请求输入拼 URL"的地方：`fetch` 只打配置里的 `remote.url`（插件）与 `CLOUD_URL`（`/api/push-cloud`） |
| 认证绕过 | **漏配就拒绝启动**：无口令 → 必须显式 `--allow-no-token` 才起（否则谁来都是管理员、能覆盖整张表）；`--owner-only` 无 owner → 也拒绝启动；口令与签名密钥必须分开（`editor/test/sign-key.test.mjs`） |
| 口令能碰到什么 | 口令写在每个人的跳转地址里，**不算秘密**：只凭口令 = guest（全表只读）+ `/api/snapshot`；所有写接口都要签名身份或 owner。加新接口时别把"无签名"的路径接到写操作上 |
| 泄露面 | `/healthz` 只回布尔与计数，不回服务器路径与云端地址 |

对应套件：`editor/test/fail-closed.test.mjs`（漏配）、`sign-key.test.mjs`（伪造身份）、`owner-only.test.mjs`（主人专用）、`short-link.test.mjs`（短链那套凭证）、`versions.test.mjs`（上传/回退/穿越）。

## 九、审核沉淀下来的硬约束（2026-10-04 外部审核后新增）

这几条是审核报告里反复出现的根因，改任何身份 / 写入 / 通知相关代码前先对齐：

1. **权限只认稳定身份（QQ），昵称只用于显示**：`owner` / `admins` 名单里的昵称写法是历史包袱，
   不能作为授权依据（昵称可改，且签名只证明"这是你的 QQ 和当前昵称"，不证明任何权力）。
2. **身份 / 位置 / 昵称三者分开**：成员身份（QQ）是权威；表中的物理行号只是**位置**；
   群昵称只是**展示**。换表、压紧行、改名片都不该转移所有权 —— 整表替换（上传/回退）必须
   把「版本 + QQ→行绑定 + 完成情况锁」当作**同一次状态转换**处理，无法确认身份时作废旧绑定并安全重建。
   **2026-10-04 决定（方案 B）：不给表加"稳定成员 ID"列**，稳定身份放在编辑器侧的状态里
   （绑定/锁文件 + 表指纹 + 可按当前表与群名单重建的审计接口）。代价要认下来：
   别人手工把 A 的名字写进 B 的那一行，原理上无法与"A 改名了"区分——这类改动靠群名单对账与人工核对兜底。
   归属状态的**唯一直属入口**是主人专用的 `GET/POST /api/ownership`（审计：QQ→行/记的昵称/表里现值/
   stale/conflict/表指纹/锁摘要；`{action:"rebuild"}` 按当前表 + 群名单重建并回报 kept·moved·dropped·
   unconfirmed·missing）。**同一行被多个 QQ 争用一律作废**——这条规则在共用的 `rebuildOwnership` 上，
   所以上传/回退/自动对账都用同一口径（作废后本人下次发 `#排队` 按昵称重新认领）。
3. **所有写入口共享同一个提交机制**：普通保存、整表上传、回退、身份同步、名单整理、备份快照
   都要进同一队列/临界区；读取 + 校验 + 备份 + 提交同临界区；外部（Excel/WPS/别的进程）改动
   要能用文件指纹检出并返回明确冲突，不能静默覆盖。
4. **昵称兜底不得越权**：按昵称找行时，先排除"已经有效绑定给别的 QQ"的行。
5. **通知/命令这类"边缘路径"同样要有能失败的回归**（首次部署、冷却期、跨榜、重试失败…），
   不能只测 happy path。
6. **插件部署工具不碰网络基础设施**：`tools/` 只输出"应用交接信息"（监听地址、端口、挂载路径、
   应用上传上限、健康接口）。nginx / 证书 / 反向代理 / 防火墙 / DNS 由服务器所有者负责
   （本项目的服务器所有者是阿修 Axiu），插件不生成网络配置、不检查 nginx、不重载服务。
7. **宿主根目录靠推导，不靠问**：部署脚本从自身位置（`$PSScriptRoot` → `<Yunzai>/plugins/abyss-queue/tools`）
   推出插件根与宿主根；JS 用 `components/config.js` 的 `pluginRoot` 推导并校验宿主标识，
   **不要用 `process.cwd()`**（它由启动方式决定）；推导不出来就明确报告"不适用于部署"，不要去猜另一套安装。

## 十、不要做的事

- **不执行任何 git 操作**（用户自己 commit / push）；摘要格式见用户级规则。
- **不重启 Yunzai / QQ**；本机编辑器要重启时先说清再做。
- **不往群里发消息、不做不可逆操作**：需要时先说明再执行。
- **不把运行时资产提交进仓库**：`config/config.yaml`、`data/`、`test/.test-tmp/`、字体、真实表格都在 `.gitignore` 里。
