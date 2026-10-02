# abyss-queue（三路深渊排队）

在 QQ 群里排队报名，数据直接读写**人工维护的本地 xlsx 排表**——不改表结构、不丢条件格式/下拉/公式/超链接。

适用于「主播帮帮」类深渊排表：群友自助报名、退队、改备注，主播照旧用 Excel 维护这张表。

## 命令

| 命令 | 说明 |
| --- | --- |
| `#排队` | 查看三榜人数总览与命令帮助 |
| `#排队 <榜> [全部]` | 查看某个榜的队列；榜名可写全名或简称（`危战` / `剧诗` / `深渊` / `幽境` / `幻想` / `螺旋`）或序号，加 `全部` 显示全量（旧写法 `#危战排队` / `#剧诗排队` / `#深渊排队` 仍兼容） |
| `#我的` | 查看自己的排队记录（图片渲染，样式与原表一致；含每个榜的位置、群昵称、游戏名、主播、难度、强度、完成情况、主播直播入口与备注） |
| `#主播` | 列出主播：**三个榜合并成一张表**（同一主播只出现一次），含「专职」列标明他打哪个榜 |
| `#主播 <榜>` | 只列该榜的主播 |
| `#主播 <名字>` | 文本输出这位主播的详情：专职、各榜强项、直播入口（跨榜汇总） |
| `#清空 [榜]` | 清空整榜（需二次确认「确认清空 <榜>」，默认仅主人可用） |

命令只有 **4 条**：聊天端只负责**查询**（`#排队` / `#我的` / `#主播`）与清空，**填表在在线编辑器里做**（报名、退队、改备注都等价于在表里改单元格），链接与口令随 `#排队` 发放。`#报名`、`#退队`、`#改备注` 以及更早的 `#深渊报名` 等写法都已移除。

### 菜单里的榜单状态

`#排队` 的「排队人数」列平时显示人数；若某个榜**整榜状态一致**（典型是深境螺旋还没开、每行都写着「等待开启」），该列改为显示这个状态，同时不再把它计入排队总人数。这样不必打开表格就知道某个榜是"还没开始"而不是"有人排队"。

### 主播的「专职」列

`#主播` 的合并表里，「专职」表示这位主播打哪个榜。它有两级来源：

1. **表里手填**：各榜主播区的 **D 列**（"核心强项" C 列与"直播入口" G/H 列之间那个空格）写上他专职的榜。想区分同一位主播在不同榜的定位时填这里。
2. **自动推断**：D 列留空时，按这位主播出现在哪些榜的主播区来显示——他出现在哪个榜就说明他接哪个榜。

两种都留空的情况下不显示 `—`，不会影响表格。

### 在线编辑器（填表的唯一入口）

群友在浏览器里填表，机器人在群里发链接与口令。编辑器是一个零额外依赖的 Node 服务
（只用 node 内置模块 + `jszip`），**独立部署到云服务器**，与机器人解耦。

**完整部署步骤见 [`tools/DEPLOY.md`](tools/DEPLOY.md)**（云服务器 + systemd/pm2 + Nginx HTTPS + 口令 + 备份）。

本机试跑（不部署也能看界面）：

```bash
node plugins/abyss-queue/tools/editor.mjs                 # http://127.0.0.1:7788
node plugins/abyss-queue/tools/editor.mjs --port 8899
node plugins/abyss-queue/tools/editor.mjs --file "D:/别的表.xlsx"
node plugins/abyss-queue/tools/editor.mjs --bind 0.0.0.0 --token 口令   # 对外 + 口令
```

打开后只有一个填写表单，**只显示需要填的字段**：

```
#  群昵称*  原神游戏名*  选择主播▾  难度及目标▾  账号强度▾  备注
```

- 序号（公式）与「帮帮完成情况」（主播的进度）**不出现在界面里**
- **带 `*` 的是必填**；主播 / 难度 / 账号强度是下拉框，选项取自原表的数据验证
- 「＋ 新增一行」自动选中数据区第一个空行；「删除」清空该行（序号公式保留）
- 保存走插件自己的 `Table.mutate`：**写前备份 `.bak`、写入后回读自检**；保存前还会校验必填、同榜昵称重复、下拉值是否命中
- 手机可直接用（窄屏适配）

**访问控制**：编辑器启动时设 `ABYSS_EDITOR_TOKEN`，未带口令打开只会看到一个输入口令的页面。
机器人的 `config.yaml` 里配好 `editor_url` 与 `editor_token` 后，群里发 `#排队` 会：

1. 发三榜总览图（图内底部显示编辑器地址）
2. 再发一条文字：`https://你的域名/?k=<口令>`

口令只随这条回复发放，**不在群里的人拿不到口令**——这就是"仅群成员可访问"。前端拿到口令后会存进
localStorage 并把地址栏里的口令抹掉，避免截图泄露；口令失效时保存会直接提示"在群里重新发 #排队"。

环境变量：`ABYSS_EDITOR_FILE`（表格文件）、`ABYSS_EDITOR_TOKEN`（口令）、`ABYSS_EDITOR_BIND`（默认 `127.0.0.1`）、`ABYSS_EDITOR_PORT`、`ABYSS_EDITOR_MOUNT`（挂载前缀，默认 `/queue`）、`ABYSS_EDITOR_ONLINE`（界面里附带的在线版链接，可选）。

**数据一致性**：编辑器读写的是**服务器上那一份 xlsx**。要么把它作为唯一数据源、定期拷回机器人这台机器，要么继续用腾讯文档而不要同时用这个编辑器——避免两份各改一份互相覆盖。

桌面上有 **「排队表编辑器」** 快捷方式（指向 `E:\Apps\启动排队表编辑器.vbs`），**只用于本机测试**：双击以隐藏窗口在 `127.0.0.1:7788` 起服务并打开浏览器，失败会弹提示并附 `E:\Apps\editor.log` 尾部。生产部署仍按 `tools/DEPLOY.md` 走。

## 配置

配置文件 `config/config.yaml`（首次加载时若不存在，会自动从 `config/config.yaml.example` 复制一份）：

```yaml
# 表格文件路径：绝对路径，或相对插件目录
xlsx_path: "D:/文件/游戏/原神/2026年10月三路深渊排队.xlsx"

# 默认榜：引导首项、退队时的优先项
default_sheet: 幽境危战

# 各表报名时写入的「帮帮完成情况」
sheets:
  幻想真境剧诗: { default_status: 排队中 }
  幽境危战: { default_status: 排队中 }
  深境螺旋: { default_status: 等待开启 }

list_limit: 20            # 名单显示行数，0 = 全部；超过则提示「还有较多成员排队，请耐心等待」
render_image: true        # 是否用图片渲染榜单/主播/菜单（渲染后端不可用时自动回退文本）
render_scale: 2           # 出图分辨率倍数（设备像素比）
render_name_max: 40       # 图片模式列截断宽度（显示宽度，中文算 2；0 = 不截断）
render_status_max: 40
font_download: true       # 首次渲染时从云端拉取原神风格字体并缓存到 data/fonts（不入库）
font_mirrors: []          # 字体镜像基地址；留空用内置多镜像（jsDelivr / raw.githubusercontent）
backup: true              # 写表前备份为 <原文件名>.bak
editor_url: ""            # 在线编辑器地址（群友填表），留空则不展示也不发链接
editor_token: ""          # 在线编辑器口令，随 #排队 发给群成员；须与服务器 ABYSS_EDITOR_TOKEN 一致
permission:               # 命令权限：all / master
  clear: master
push:                     # 定时推送，默认关闭
  enable: false
  cron: "0 12 * * *"
  groups: []
  sheets: []
  limit: 10
store_file: data/bindings.json  # QQ→行号 绑定（相对插件目录）
```

回归测试可用环境变量 `ABYSS_QUEUE_CONFIG` 指定另一份配置，避免动到真实配置。

## 部署

1. 把整个 `abyss-queue` 目录放进 Yunzai 的 `plugins/` 下（**不要**放 `node_modules`，`pnpm i` 会自己装）。
2. 在 Yunzai 根目录执行 `pnpm i`（或 `pnpm i --filter abyss-queue`）安装 `jszip`、`yaml`。
3. 编辑 `plugins/abyss-queue/config/config.yaml` 填写 `xlsx_path` 指向你的表格。
4. 重启 Yunzai。加载成功时日志里会看到插件数 +1。

### 部署须知：仓库之外的 3 处改动

下面这些**不在本仓库里**（属于框架或运行环境），换机部署时最容易漏。插件的报名、排队、查榜**不依赖**它们；缺失只影响「更新指令」与「重启联动」。插件启动时会自检前两项，缺失会写日志并私聊主人。

**① 框架 `#更新` 支持 `abyss` 简称 —— 必需**（否则 `#更新 abyss` 认不出插件）

文件：`<bot根>/plugins/other/update.js`，在 `getPlugin()` 里：

```js
const alias = { abyss: "abyss-queue" }
plugin = String(plugin ?? "").trim()
const names = [alias[plugin] ?? plugin, `${plugin}-Plugin`, `${plugin}-plugin`, alias[plugin]].filter(Boolean)
for (const i of names) if (await Bot.fsStat(`plugins/${i}/.git`)) { this.typeName = i; return i }
return false
```

**② 框架强制更新后能重启 —— 必需**（否则 `#强制更新` 会"更新了却不重启"）

文件同上，在 `runUpdate()` 里，把「是否已是最新」的判定补上提交号比较：

```js
const newCommitId = await this.getCommitId(plugin)
const commitChanged = Boolean(this.oldCommitId && newCommitId && this.oldCommitId !== newCommitId)
if (/Already up|已经是最新/.test(ret.stdout) && !commitChanged) {
  if (!this.quiet) await this.reply(`${this.typeName} 已是最新\n最后更新时间：${time}`)
} else {
  this.isUp = true
  ...
}
```

> 原因：强制更新是 `git reset --hard origin/main && git pull --rebase`，reset 已把工作区对齐，随后 `git pull` 必然报 `Already up to date`，原判定会误认为"没变化"而跳过重启。

这两处在本机文件里都带 `本地补丁 START / END` 标记，**框架升级会覆盖该文件，升级后按标记重新加回**。

**③ 渲染后端支持高清出图 —— 出图清晰度必需**

插件把「出图倍数」放在 `config.render_scale`（默认 `2`），通过渲染链的 `cfg.scale` → `data.sys.scale` 传下去；截图后端必须认这个值，否则出图恒为 1 倍（820px 宽，放大发虚）：

- `renderers/puppeteer/lib/puppeteer.js`：截图前 `page.setViewport({ deviceScaleFactor })`（`multiPage` 分支重设视口时也要带上）
- `renderers/shotium/lib/shotium.js`：`options.scale` 改为优先取 `data.sys.scale`

两个后端都带 `本地补丁 START / END` 标记。**注意**：`shotium` 是进程内引擎，改完必须重启 Yunzai 才生效（`puppeteer` 会重启浏览器进程，无需重启）。本机实际生效的是 `shotium`（`puppeteer` 因缺少 `renderers/puppeteer/config.yaml` 而未启用）。

**④ 启动器：窗口联动与重启标记 —— 可选但推荐**

自建启动脚本（如 `启动云崽与QQ.vbs`）负责三件事，缺失时代价是多几个空窗口或服务掉线：

1. 依次拉起 NapCat（`node.exe ./index.js -q <QQ>`）与 Yunzai（`node .`），各留一个窗口
2. 任一方退出时关闭另一方，并清理承载用的空壳 `cmd.exe`（否则每轮操作都堆窗口）
3. 退出后若存在 `plugins/abyss-queue/data/restart.flag`，视为"重启"：重新拉起两个服务（插件在进程退出时会写这个标记，用于区分「重启」与「停服」）

不使用时：`#重启` 之后需要手动开 NapCat；`#更新` 拉到新代码后也需要手动重启一次。

要求 Node ≥ 20（用到 `import.meta.dirname` 需 Node 20.11+）。

## 更新与「部署目录不被改动」的约定

**更新指令由框架（TRSS-Yunzai）提供，本插件不自带**：

| 指令 | 行为 |
| --- | --- |
| `#更新 abyss` | 等价于 `#更新 abyss-queue`，拉取本插件最新代码（框架 `plugins/other/update.js` 处理） |
| `#强制更新 abyss` | 框架的强制更新：`git reset --hard <上游>` 对齐远端，丢弃被跟踪文件的本地改动 |
| `#全部更新` | 框架的整机更新（本体 + 全部插件，含 `pnpm install`） |

`abyss` 这个缩写是框架侧的别名映射（`plugins/other/update.js` 的 `getPlugin()` 里有一行本地补丁）。插件自身不注册任何更新规则——避免与框架重复接管同一条命令。

为了让更新永远不冲突，仓库遵守两条约定：

1. **配置与数据只以模板形式入库**：仓库跟踪 `config/config.yaml.example`，运行时 `config/config.yaml` 由它在首启时复制生成；绑定数据在 `data/`。两者都在 `.gitignore` 内，因此**更新（含强制对齐）不会碰用户的配置与数据**。
   - 新增配置项必须同时写进 `config.yaml.example`，否则老部署不会自动获得该键（`test/workbook.test.mjs` 有断言守这条契约）。
2. **部署目录只由更新指令改动**：不要用手工复制/编辑去同步代码——那会让部署目录产生未提交改动，一旦与远端提交重叠，快进就会被 git 拒绝（表现为「有本地改动，无法快进」）。正确的做法是：改动先在本仓库落地并推送，再在群里发 `#更新 abyss` 拉取。
   - **开发期也不要"先拷过去试"**：验证新功能必须在源仓库跑离线套件（`pnpm test`），需要真机验证时就先推送再 `#更新 abyss`。文件复制是这套流程里唯一的冲突来源。
   - 配置与数据安全：`config/config.yaml` 与 `data/` 都在 `.gitignore` 内，`test/workbook.test.mjs` 用 `git check-ignore` 断言守着这条——因此即使走到 `#强制更新 abyss`（`reset --hard`），用户的配置与绑定数据也不会被清掉。

`.gitignore` 覆盖的内容：`node_modules/`、`data/`、`config/config.yaml`、`test/.test-tmp/`、`pnpm-lock.yaml`、`*.bak`、`*.tmp`。

行尾策略同样是为了让更新不冲突：`.gitattributes` 固定 `* text=auto eol=lf`。Windows 上 git 默认 `core.autocrlf=true`，会把工作区文件签出为 CRLF，而代码与配置通常是 LF——两者不一致时 git 会把「行尾不同」判定为本地改动，于是 `#更新` 的快进被拒绝。固定 `eol=lf` 后，git 期望的工作区行尾与工具产出一致，部署目录不会再因此变脏。

> 若克隆时已经按 CRLF 签出过，执行一次 `git add --renormalize .` 即可让索引与工作区按新策略对齐。
>
> **同时要把两个仓库的 `core.autocrlf` 都设为 `false`**：`.gitattributes` 已经固定了 `eol=lf`，再叠加 `autocrlf=true` 会出现"写 LF、期望 CRLF"的对立，制造幻影本地改动。本机两个仓库均已设置；换机克隆后各执行一次：
>
> ```bash
> git -C "<源码仓库>" config core.autocrlf false
> git -C "<bot根>/plugins/abyss-queue" config core.autocrlf false
> git -C "<源码仓库>" add --renormalize .
> ```

### 一条命令自查部署一致性

两个目录是同一仓库的两份**独立克隆**（不是同一个目录，也不应做成软链接——框架要求插件真实位于 `<bot根>/plugins/` 下）：

- **源码仓库**：改代码、跑测试、提交、推送
- **部署目录** `<bot根>/plugins/abyss-queue`：只由 `#更新 abyss` 拉取，**不接受任何手工拷贝**

排查"`#更新` 报本地冲突"时跑：

```bash
node test/check-deploy.mjs                 # 默认查本机部署目录
node test/check-deploy.mjs "<部署目录>"     # 或指定路径
```

它会输出两边 HEAD、工作区改动、未跟踪文件、两棵树的内容差异（按行尾归一，避免假差异）与 `core.autocrlf` 状态；发现会挡住 `#更新` 的问题时列出具体文件并给出处理命令，退出码非 0。

## 表格要求

- 三个工作表（榜）名称可自定义，插件按表内内容识别，不写死行号/表名。
- 每个工作表需有一行表头，**A 列写着「序号」**；表头行之上是主播区（A 列主播名、C 列强项、G/H 列直播入口）。
- 数据列按表头关键字识别：群昵称 / 原神游戏名 / 选择主播 / 难度 / 账号强度 / 帮帮完成情况 / 备注。
- 主播、难度、强度列的下拉验证（数据验证）会被当作合法选项读出来，报名时据此归一与校验。
- 序号列（A 列）的公式不会被改动；退队只删 B–H 的单元格，不删整行。

## 实现要点

分层遵循 Yunzai 插件仓库惯例（`index.js` 薄加载器 + `apps/` 入口 + `model/` 数据 + `components/` 组件 + `lib/` 公共库）：

```
abyss-queue/
├── index.js              薄加载器：首启生成配置 + 聚合 apps/ 下的入口类（框架只认这个文件）
├── apps/                 入口层 — 每个文件导出 class，rule 定义正则 → 方法
│   ├── _base.js          AppBase：日志、异常出口、取表/取绑定、上下文装配
│   ├── queue.js          #排队 [榜] / #主播 / #我的 + 定时推送
│   └── admin.js          #清空（主人）
├── model/                数据层
│   ├── index.js          Table / BindStore 单例（保证写操作共用一把锁）
│   ├── table.js          xlsx 读-改-校验-原子替换 + 进程内串行
│   └── store.js          QQ → 表格行号 绑定（老数据兼容；编辑器填表不再新增绑定）
├── tools/                在线编辑器（填表的唯一入口）与部署指南
│   ├── editor.mjs        零依赖 HTTP 服务，读写都走 Table.mutate（可部署到云服务器）
│   ├── editor.html       填写界面：只显示需要填的字段（手机可用）
│   └── DEPLOY.md         云服务器部署指南（systemd / Nginx HTTPS / 口令 / 备份）
├── components/           可复用组件
│   ├── config.js         配置读取、默认值合并、路径解析、configHint、ensureConfig
│   ├── constants.js      榜名、上下文名、插件名
│   └── pluginVersion.js  版本号（回复页脚用）
├── lib/                  底层公共库（纯函数，不依赖 Yunzai）
│   ├── xlsx.js           极简 xlsx 容器读写
│   ├── schema.js         工作表结构解析（含主播区与「专职」列）
│   ├── queue.js          排队业务逻辑
│   ├── render.js         文本渲染与各视图数据
│   └── router.js         输入解析（选榜 / 榜名简称与序号）
├── config/               config.yaml（运行时，入库忽略）+ config.yaml.example（参考）
├── test/                 回归套件
└── data/                 运行时数据（绑定文件，入库忽略）
```

- `lib/xlsx.js`：极简 xlsx 容器。不整表解析重排，而是**外科手术式替换目标 `<c>` 节点**，写入用 `inlineStr` 从而完全不动 `sharedStrings.xml`；未改动的工作表逐字节保持原样。
- `model/table.js`：每次操作都重新读盘（人工可能刚用 Excel 改过表），写入走「读-改-校验-原子替换」；替换前会用新缓冲重新解析并核对写入结果，核对不过就放弃写入；所有写操作进程内串行，多群同时报名不会互相覆盖。
- `components/config.js`：首次启动自动从 `config.yaml.example` 生成运行时配置；缺 `xlsx_path` 时回复明确提示而不是静默失败。
- `lib/` 下全部是纯函数（不 import Yunzai、不碰文件系统），因此可以脱离机器人做回归测试。
- `apps/` 下的类由 `index.js` 聚合导出为 `module.apps`——这是框架 loader 的取法：插件根一旦存在 `index.js`，loader 就只导入它、不再扫 `apps/`（`lib/plugins/loader.js:58-62`、`:130`）。

## 已知限制

- **宿主的命令冷却会吞消息**：TRSS-Yunzai 的 `config/config/group.yaml` 里有 `singleCD`（默认 2000ms，同群同一人）与 `groupCD`（默认 500ms，同群）。用户连续快发独立指令时，冷却期内的消息在规则匹配前就被丢弃，插件收不到。实测发消息间隔 >2s 时 16/16 全部得到回复。
  引导式报名走的是 loader 的上下文分发（在冷却判定之前），**不受冷却影响**。
- 表格里没有 QQ 号列，「你是谁」靠群昵称判定：登记绑定后每次操作都会回表核对昵称，昵称被人工改动会提示「绑定已失效，请重新报名」。同群多人同昵称时以表内先出现的那行为准。
- 表格正被 Excel/WPS 打开时可能写入失败（`EPERM/EBUSY`），插件会明确提示「请关闭后重试」，不会写坏原文件。
- 只支持 `.xlsx`；`.xls` 与在线文档（腾讯文档等）不支持——需要在线协同时，请把在线表格定时导出成本地 xlsx。

### 与其它插件的命令冲突

框架的规则分发**先命中先执行**，顺序是 `priority` 升序（相同则按插件加载顺序）。与本插件相关的撞车点只有「裸榜名」，因此本插件的榜单命令**一律要求带 `排队` / `列表` 后缀**，与下列规则天然错开：

| 会被抢的命令 | 占用方 | 对方 priority |
| --- | --- | --- |
| `#幽境危战` / `#幻想真境剧诗` / `#深境螺旋` / `#深渊` / `#危战` / `#剧诗` | `Axiu-Plugin`「终局挑战」（`plugins/Axiu-Plugin`） | `1` |
| `#排队` | 框架示例 `plugins/example/排队.js`（「三路深渊排队」示例，各版本可能自带） | `500` |

因此：`#排队` / `#排队 危战` 这些写法在任何组合下都不会被抢（`#排队列表` 之类的旧后缀写法也保留兼容）。`#排队`（本插件保留的菜单入口）在本机 `plugins/example/排队.js` 已被移除，可用；若某次框架升级把它带回来，`#排队` 会改由示例插件响应，届时把入口命令换掉即可。

`plugins/system/add.js` 的「添加消息」用 `reg: ""` + `priority: Infinity` 做兜底，永远最后执行，不参与抢占。

## 测试

不依赖 Yunzai，直接跑：

```bash
pnpm test                              # = node test/run.mjs，顺序跑全部套件并汇总
node test/run.mjs --list               # 列出套件
node test/run.mjs workbook             # 只跑文件名含 workbook 的
node test/workbook.test.mjs            # 单跑某个套件
XLSX_PATH="D:/别的表.xlsx" pnpm test    # 指定表格
```

| 套件 | 覆盖 |
| --- | --- |
| `test/workbook.test.mjs` | 44 项：表格结构解析 / 报名写入 / 格式保全 / 特殊字符 / 原表未被触碰 / 视图数据与配置契约 |
| `test/workflow.test.mjs` | 60 项：经 `index.js` 的 `apps` 装载入口类、复刻 loader 分发，覆盖全部命令、上下文流程与错误路径 |

两个套件都只操作表格**副本**，结束时校验源表格哈希未变；被测表格不存在时按约定「跳过、不算失败」。约定细节见 `test/README.md`。

`test/render-check.mjs` 是渲染自查：把三张模板渲染成 PNG，检查字体是否代入、模板变量是否残留、图片是否真的出得来（需在**机器人根目录**执行；字体走 `data/fonts` 缓存，因此也顺带验证字体拉取链路）：

```bash
node plugins/abyss-queue/test/render-check.mjs [输出目录]
```

字体说明：**原神标准字体**（`HYWH-65W` 汉仪文黑，即 miao-plugin 默认字体栈里的 `"汉仪文黑-65W"`；数字用 `tttgbnumber`）**不入库**，首次渲染时从云端拉取并缓存到 `data/fonts/`（已被忽略），之后离线可用；镜像可用 `font_mirrors` 配置，全部失败时回落系统字体，不影响出图。

> 正文与标题统一用 `HYWH-65W`。此前正文用的是 `NZBZ`（印品南征北战NZBZ体）——那是 miao-plugin 提供的**可选装饰字体**，字形本身带倾斜感，出图会像斜体，已弃用。

`test/verify-xlsx.ps1` 用 .NET 的 ZIP/XML 解析器独立复核生成的文件（与插件实现完全不同的一套实现）：

```powershell
powershell -File test/verify-xlsx.ps1 -Modified <生成的文件> -Original <原表格> -Sheet 2 -Row 27
```

`-Sheet` 是写入的工作表序号（1 起，对应 `xl/worksheets/sheetN.xml`，如 sheet2 = 幽境危战），`-Row` 是写入行号；脚本会回读该行 B–H 的文本、比对结构标签数量、校验未改动工作表逐字节一致。
