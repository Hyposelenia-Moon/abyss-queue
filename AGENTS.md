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
| `apps/` | 指令层：`queue.js`（`#排队` / `#主播` + 队列推送、进度轮询、月末催办）、`_base.js`（插件基类：`safe()`、`models()`、`store()`、`nickname()`） |
| `components/` | 组装层：`config.js`（默认值 + 合并 + 首启生成 config.yaml）、`render-html.js`（出图、图与文案合成一条消息、失败回退文本）、`roster.js`（把群名单推给编辑器）、`constants.js`、`font.js`、`pluginVersion.js` |
| `lib/` | 纯逻辑：`identity.js`（**身份签名 + 短码，编辑器共用**）、`schema.js`（xlsx 结构识别）、`progress.js`（完成判定 / 进度快照）、`render.js`（视图数据 + 文本），另有 `queue.js` / `router.js` / `aliases.js` / `text.js` / `xlsx.js` / `logger.js` / `patches.js`（部署补丁自检） |
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
```

## 五、测试约定

- 文件名 `<主题>.test.mjs`，放 `test/` 或 `editor/test/`；`run.mjs` 自动发现。
- **任意 cwd 可跑**：路径一律经 `_helper.mjs` 推导；临时产物只写 `test/.test-tmp/`（已 gitignore）。
- **缺前置就跳过**：真实表格、浏览器、假云端拿不到时打印 `⏭ 跳过` 并 `exit 0`，不算失败。
- 框架全局桩（`plugin`/`logger`/`segment`/`Bot`）由 `_helper.mjs` 的 `installFrameworkStubs()` 提供，必须在 import 插件代码**之前**调用；桩要跟着框架真实语义走（例如 `retType=base64` 只返回图片段、不自动发送）。
- 版式改动：`test/layout.test.mjs` 管"规则有没有被改回去"，`render-check.mjs` 管"长什么样"（后者要人看）。
- 部署一致性：`node test/check-deploy.mjs [部署目录]` 查源码仓库与机器人部署目录是否一致（避免 `#更新 abyss` 因未提交改动被 git 拒绝）；`test/check-launcher.ps1` 静态自检启动器脚本（只解析、不执行）。

## 六、这台机器上的事实（本机环境）

| 项 | 值 |
| --- | --- |
| 插件源码 | `D:\文件\游戏\原神\abyss-queue`（本仓库，唯一的开发处） |
| 机器人部署目录 | `D:\Program Files\Yunzai\Yunzai\plugins\abyss-queue`（**只在 `#更新 abyss` 时更新**，别手改） |
| 运行时数据 | `D:\Program Files\Yunzai\abyss-queue-data\`（本机编辑器启动器、群公告、nginx 部署手册都在这里） |
| 本机编辑器 | 计划任务 `AbyssQueueEditor` → `editor-launch.mjs`（`--owner-only --cloud --mount ""`，端口 7788，挂在**根目录**）；改 `editor.mjs` 要重启它，改 `editor.html` 刷新即可 |
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
- **定时通知靠群号**：`notify.groups` / `roster.group` 没配就什么都不发（启动日志会提示，别当成功能坏了）。
- **`#更新 abyss` 要求部署目录干净**：手改过部署目录里的被跟踪文件会让 git 拒绝快进，先跑 `test/check-deploy.mjs`。

## 八、不要做的事

- **不执行任何 git 操作**（用户自己 commit / push）；摘要格式见用户级规则。
- **不重启 Yunzai / QQ**；本机编辑器要重启时先说清再做。
- **不往群里发消息、不做不可逆操作**：需要时先说明再执行。
- **不把运行时资产提交进仓库**：`config/config.yaml`、`data/`、`test/.test-tmp/`、字体、真实表格都在 `.gitignore` 里。
