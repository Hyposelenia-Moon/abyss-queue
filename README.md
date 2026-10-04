# abyss-queue（三路深渊排队）

在 QQ 群里查排队情况：从**云端编辑器**拉一份排表快照（不改表结构、不丢条件格式/下拉/公式/超链接），渲染成图发出去。

本文档里的「**云端**」指**部署在云服务器上的在线编辑器**（本仓库 `editor/` 那份代码），不是任何第三方在线文档。
填表与改表都在云端编辑器里做，它是**唯一的写入口**；**插件自己一个字都不写表**（`#清空` 等写表指令已移除）。
编辑器就在本仓库里（`editor/`），随插件一起部署。

## 命令

| 命令 | 说明 |
| --- | --- |
| `#排队` | **只发一条消息**：一张图（三榜人数总览 + 发送者本人的排队信息，按群昵称/QQ 定位，表里没有就不显示这一块；常用指令在图底部）+ 图后面接的两段——第一段写填写情况，第二段是填报入口的**短链**：`点此填表：<remote.url>/s/<16 字符码>`（整条约 40 字符；`remote.link_markdown: true` 时改成「点此填表」四个字本身带链接的 markdown 段）。码里只有加密后的 QQ + MAC（看不出是谁、也不用编辑器存映射），有效期按 30 天窗口算、认当期与上一期 → **约 30~60 天**。点开短链 → 编辑器验码 → 302 到带身份签名的完整地址，**只让他改自己那一行**。填写情况按 `未填：<榜名…>；已完成：<榜名…>` 写：还没排的榜进「未填」，已经打完的（表里是主播名）和自己点过完成的（表里落成了群昵称）都进「已完成」，还在排队的两边都不提；两边都没有（三个榜都填过）就只给入口——已填的内容也能回去改。链接要「地址 + 口令 + 签名密钥」齐备才签得出，缺任一项就写「暂无链接」；编辑器还是老版本（没有 `/s/` 路由）时把 `remote.short_link` 改成 `false`，退回原来的长链接 |
| `#排队 <榜> [全部]` | 查看某个榜的队列；榜名可写全名或简称（`危战` / `剧诗` / `深渊` / `幽境` / `幻想` / `螺旋`）或序号，加 `全部` 显示全量（旧写法 `#危战排队` / `#剧诗排队` / `#深渊排队` 仍兼容）。同样是**一条消息**：图 + 该榜的填写情况与填报入口（有他没他都照附） |
| `#主播` | 列出主播：**三个榜合并成一张表**（同一主播只出现一次），含「专职」列标明他打哪个榜 |
| `#主播 <榜>` | 只列该榜的主播 |
| `#主播 <名字>` | 文本输出这位主播的详情：专职、各榜强项、直播入口（跨榜去重，平台与链接拼在一起，如 `直播入口：B站https://…`） |

命令只有 **2 条**（`#排队` / `#主播`），聊天端只负责**查询**。
`#报名`、`#退队`、`#改备注`、`#我的`（已并入 `#排队`）、`#清空` 以及更早的 `#深渊报名` 等写法都已移除。

### 「我的排队信息」怎么定位（按 QQ）

`#排队` 出的那张图里，「我的排队信息」接在榜单表下面。发送者的 QQ 是**权威身份**，群昵称只是用来第一次认人：

1. **有绑定** → 直接按绑定认这一行：即使他改了群名片，也认这个人
2. **没有绑定** → 按群昵称在表里找；找到就记下 QQ→行 的绑定，以后都按 QQ 认
3. 绑定指向的行已被清掉（退队）或已经属于别的 QQ → 绑定作废，回到第 2 步
4. 仍然找不到 → **只发菜单**，不会多发一条「没有你的记录」

**名片与表里昵称不一致时，插件只记日志，不会去改表**（表只读，改表由云端编辑器做：
本人打开编辑器时会按群名片同步，机器人每天的群成员名单核对也会兜一遍）；
图里显示的始终是表里的昵称。匹配**只看群昵称**，游戏名不参与判断。
绑定存在 `data/bindings.json`（相对插件目录，已被 git 忽略）。


### 主播别名（表里/群里的其它写法）

同一位主播在表里、群里常有多种写法。配置里登记「正名 → 别名」，读的时候统一归到正名：

```yaml
anchor_aliases:
  阿修Axiu: ["阿修"]          # #主播 阿修 也能查到
  摸头妹: ["璃月第一深情"]     # 表里写「璃月第一深情」的行算作摸头妹，直播入口照样带出来
```

- 别名按**正则整串匹配**（忽略大小写），所以 `纸笑.*` 这种写法也可以；写错的正则会跳过、不影响出图
- 影响范围：`#主播 <名字>` 的查找、`#排队` 里本人那一行的直播入口；编辑器侧的下拉同样会归一（见 `editor/`）
- 表里的原文不会因为别名被改写

### 数据链路：纯云端（插件只读）

```
云端编辑器（云服务器，唯一写入口） ── 服务器上那份 xlsx
      │  GET <remote.url>/api/snapshot?k=<remote.token>
      ▼
插件（机器人）── 解析成 models → 渲染 → 推送
      └── 每次成功拉取都往本地写一份备份（data/backup，只留最新一份）
```

- 插件**按 TTL 拉快照**（默认 30 秒内复用内存里那份），**对比差异、有差异才换**：
  新快照与上一份逐表比 XML，没变的表沿用原来的解析结果，日志里会写清哪几张表变了
- **网络抖动不当失败**：拉取出错时继续用上一次成功的快照（记一条 warn）；从来没成功过才报错，
  命令里会直接说「云端表不可达（地址）」
- **本地备份**（`snapshot_backup`）：每次成功拉取都写 `data/backup/queue-日期.xlsx`，只留最新一份；
  备份失败只记日志，绝不影响读表
- 插件不写任何表格文件；`xlsx_path` 与同步脚本都已移除
- 裸链接与请求格式：`GET <remote.url>/api/snapshot?k=<token>` 返回 xlsx 原始字节；
  口令错是 403，编辑器没挂上或路径不对会拿到 404 / 站点首页（这时日志会提示"拿到的可能不是 xlsx"）

### 菜单里的榜单状态

`#排队` 的「排队人数」列平时显示人数；若某个榜**整榜状态一致**（典型是深境螺旋还没开、每行都写着「等待开启」），该列改为显示这个状态，同时不再把它计入排队总人数。这样不必打开表格就知道某个榜是"还没开始"而不是"有人排队"。

### 完成情况与两个自动通知

「帮帮完成情况」这一列的值分三类，通知逻辑都建立在这个约定上：

| 值 | 含义 |
| --- | --- |
| `等待开启` | 这个榜还没开，既不算排队也不算完成 |
| `排队中` | 还在等（还没轮到他） |
| 其它任何值（主播名、`本人已完成`…） | 这一位已经处理过了 |

1. **上一位完成 → @ 下一位**：机器人按 `notify.progress_cron`（默认每 3 分钟）读一遍表，与上次的快照比对；
   某一行从「未完成」变成「已完成」时，就 @ 这一榜里**下一个还在排队的人**（中间的已完成者自动跳过）。
   @ 需要把群昵称映射回 QQ，靠的是群成员名单——昵称对不上（改过名片、不在群里）时只发文字名字，不会 @ 错人。
2. **月末催办**：每天按 `notify.monthly_cron` 检查一次「今天是不是当月最后一天」，是就把三个榜里**还在排队的人** @ 一遍。

两个通知都发到 `notify.groups`（留空则跟随 `push.groups`），并且都有去重：进度快照存在 `notify.state_file`（默认 `data/progress.json`），
第一次运行只记基线不发消息；状态没变化、或重启后重复轮询，都不会重复 @。月末催办同一天只发一次。

#### 群号（写在配置里，可自己改）

**两条 @ 通知和「群昵称候选」都靠群号，不配就不会跑**（插件加载时会写日志提示），改完重启机器人生效：

| 配置键 | 作用 | 怎么写 |
| --- | --- | --- |
| `notify.groups` | 「上一位完成后 @ 下一位」与「月末 @ 所有排队中的人」发到哪些群 | 群号列表，可多个：`groups: [123456789, 987654321]`；留空则跟随 `push.groups`；两个都空 = 这两条通知都不发 |
| `roster.group` | 从哪个群拉成员名单 → 编辑器的「群昵称候选」+ 按 QQ 对账（改名同步、退群删行） | 只能填一个群号：`group: "123456789"`；留空 = 关闭群名单（编辑器里就没有候选） |

两者**可以是不同的群**（例如名单从主群拉、通知发到通知群）。注意 `roster.group` 只影响编辑器的候选人名单；
`notify.groups` 里可以填多个群，通知会逐群发。

```yaml
notify:
  enable: true
  groups: [123456789]        # ← 发 @ 通知的群（可多个）
roster:
  group: "123456789"         # ← 拉群成员名单的群（只能一个）
```

### 主播的「专职」列

`#主播` 的合并表里，「专职」表示这位主播打哪个榜。它有两级来源：

1. **表里手填**：各榜主播区的 **D 列**（"核心强项" C 列与"直播入口" G/H 列之间那个空格）写上他专职的榜。想区分同一位主播在不同榜的定位时填这里。
2. **自动推断**：D 列留空时，按这位主播出现在哪些榜的主播区来显示——他出现在哪个榜就说明他接哪个榜。

两种都留空的情况下不显示 `—`，不会影响表格。

### 主播的「直播入口」列

主播区的入口占 **G、H 两列**，拆分规则是「**一个格子 = 一个入口位**」：

| G 列 | H 列 | 渲染结果 |
| --- | --- | --- |
| `B站` | *(空)* | `B站` |
| `B站` | `抖音（付费）` | `B站` / `抖音（付费）`（两行） |
| `B站/抖音（付费）` | *(空)* | `B站/抖音（付费）`（**一行**：`/` 是普通字符，不拆项） |
| `群语音通话（屏幕共享）` | `腾讯会议370-976-3227` | 两行 |
| `B站、抖音` | *(空)* | `B站` / `抖音`（两行） |
| `B站` | `https://live.bilibili.com/1960956034` | `B站https://live.bilibili.com/1960956034`（一行） |

- **斜杠 `/` 不再是分隔符**（它是普通字符，链接里的斜杠也照旧不拆）：想写在同一行就用 `B站/抖音`
- 想拆成多行：把平台写在**两个格子**里（G、H），或同一格内用 `、` `,` `，` 并列
- 整格是一个链接时，贴到前面最近一个**还没有链接**的入口上（就是上面的「平台+链接」写法）；没有可贴的入口才单独成行
- 入口按**一项一行**渲染（每项一个 `<div>`，不依赖 CSS 换行），所以 G/H 都填了内容时**不会挤在同一行**
- `#主播` 与 `#主播 <名字>` 里入口**不按深渊分组**，是跨榜去重后的平台列表（同一位主播在三个榜填了同一个入口也只显示一行）
- `#主播 <名字>` 的文本形态即 `直播入口：B站https://…`

### 编辑器（就在本仓库 `editor/`，部署在云服务器上）

填表与改表都在**云端编辑器**里做，它是**唯一的写入口**：

- 白名单管理员能改所有人的行；带身份签名的人只能改自己那一行；没签名只能只读浏览
- 群昵称有**候选**（机器人每天推一次群成员名单），选中即照抄群名片，手写也行
- 名人改了群名片 → 打开编辑器时按新名片同步表里的群昵称；退群/被移出 → 每天核对时删掉那一行并**压紧**（不留空洞）
- **历史版本 + 回退**：每次写表前自动存一份（留最近 20 份，默认是空的），主人可在页面上回退；回退前也会先存一份，回退错了还能再退回来
- 服务器上的那份表就是数据本体；**本机那份只是备份/工作副本**（`#排队` 的链接永远指向云端）
- 编辑器细节（字段、权限模型、签名密钥、部署与 nginx 挂载）见 [`editor/README.md`](editor/README.md) 与 [`editor/DEPLOY.md`](editor/DEPLOY.md)

## 配置

配置文件 `config/config.yaml`（首次加载时若不存在，会自动从 `config/config.yaml.example` 复制一份）：

```yaml
# 数据来源：云端编辑器（部署在云服务器上；插件只读它，不碰任何表格文件）
remote:
  url: "https://yunzai.axiu.uno/queue"   # 本机联调可写 http://127.0.0.1:7788
  token: ""                              # 访问口令，与编辑器 ABYSS_EDITOR_TOKEN 一致
  sign_key: ""                           # 身份签名密钥，与编辑器 ABYSS_EDITOR_SIGN_KEY 一致
                                         # （不配就退回用 token 签：拿到链接的人能伪造身份，正式部署务必单独配）
  short_link: true                       # 群里发短链 <url>/s/<16 字符码>；编辑器还没更新（无 /s/ 路由）时改 false
  link_markdown: false                   # true = 入口做成「点此填表」可点文字（QQ 的 markdown 段，多数群不认）
  ttl_ms: 30000                          # 内存快照有效期
  timeout_ms: 15000                      # 单次拉取超时
  autostart: ""                          # 编辑器随机器人启动：插件加载后探不到编辑器就跑这个脚本（单机部署填它，编辑器单独部署留空）

# 云端快照的本地备份：每次成功拉取写一份，只留最新 keep 份（0 = 不备份）
snapshot_backup:
  dir: "data/backup"
  keep: 1

# 群成员名单：机器人推给云端编辑器（「群昵称候选」+ 按 QQ 每天对账）
#   group 填群号（**要在群里填**），留空 = 关闭；编辑器会按它同步改名、删掉退群的人那一行
roster:
  group: ""                              # 例：123456789
  cron: "0 5 * * *"                      # 每天推一次（机器人启动时也会推一次）

# 默认榜：`#排队 全部` 不带榜名时使用
default_sheet: 幽境危战

list_limit: 20            # 名单显示行数，0 = 全部；超过则提示「还有较多成员排队，请耐心等待」
render_image: true        # 是否用图片渲染榜单/主播/菜单（渲染后端不可用时自动回退文本，文案与链接跟着文本一起发）
render_scale: 2           # 出图分辨率倍数（设备像素比）
render_name_max: 40       # 图片模式列截断宽度（显示宽度，中文算 2；0 = 不截断）
render_status_max: 40
font_download: true       # 首次渲染时从云端拉取原神风格字体并缓存到 data/fonts（不入库）
font_mirrors: []          # 字体镜像基地址；留空用内置多镜像（jsDelivr / raw.githubusercontent）
backup: true              # 写表前备份为 <原文件名>.bak（这条只对编辑器的表生效；插件不写表）
push:                     # 定时推送，默认关闭
  enable: false
  cron: "0 12 * * *"
  groups: []
  sheets: []
  limit: 10
notify:                   # 进度通知（默认开，但要配了群才真的发）
  enable: true
  groups: []              # 留空则跟随 push.groups
  progress_cron: "*/3 * * * *"   # 多久检查一次「上一位是否已完成」
  monthly_cron: "0 12 * * *"     # 每天检查一次是不是月末
  monthly_enable: true
  state_file: data/progress.json # 进度快照（识别状态变化、避免重复 @）
store_file: data/bindings.json  # QQ→行号 绑定（相对插件目录）
```

回归测试可用环境变量 `ABYSS_QUEUE_CONFIG` 指定另一份配置，避免动到真实配置。

## 部署

1. 把整个 `abyss-queue` 目录放进 Yunzai 的 `plugins/` 下（**不要**放 `node_modules`，`pnpm i` 会自己装）。
2. 在 Yunzai 根目录执行 `pnpm i`（或 `pnpm i --filter abyss-queue`）安装 `jszip`、`yaml`。
3. 编辑 `plugins/abyss-queue/config/config.yaml` 填 `remote.url`（云端编辑器地址）、`remote.token`（访问口令）
   与 `remote.sign_key`（身份签名密钥，**务必与云端一致且单独随机**）。
4. 重启 Yunzai。加载成功时日志里会看到插件数 +1。
5. 要能填表，把同目录的 `editor/` 一起部署到云服务器（编辑器就在本插件里，见 [`editor/DEPLOY.md`](editor/DEPLOY.md)）；
   本机不需要装第二份，本机那份只是备份/工作副本。
6. **数据目录固定在插件内**：`<bot根>/plugins/abyss-queue/data`（Windows 本机就是
   `D:\Program Files\Yunzai\Yunzai\plugins\abyss-queue\data`）——本地表格副本、`editor-launch.mjs`、
   日志、绑定/进度/字体缓存都在这里。`data/` 已在 `.gitignore` 里，所以 `#更新 abyss` 只动代码、不动数据。
   Windows 一键部署脚本 `tools/deploy-windows.ps1` 的默认数据目录就是它（`<插件根>\data`），要换地方才用 `-DataDir` 覆盖。
   本机编辑器由计划任务 `AbyssQueueEditor` 拉起：
   `data\editor-launch.vbs` → `data\editor-launch.mjs` → `editor\editor.mjs`，两个 vbs 都按自身位置自定位
   （细节见 [`editor/README.md`](editor/README.md)）。

### 部署须知：仓库之外的改动

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
│   └── queue.js          #排队 [榜]（含本人的排队信息） / #主播 + 定时任务（推送 / 进度轮询 / 月末催办）
├── model/                数据层
│   ├── index.js          单例：getRemote()（云端只读）/ getTable()（编辑器用）/ getStore()
│   ├── remote.js         云端表：按 TTL 拉快照、对比差异、拉不到就用上一次（不落盘）
│   ├── table.js          xlsx 读-改-校验-原子替换（**只有编辑器在用**）
│   └── store.js          QQ → 表格行号 绑定（只在 #排队 认人时更新，不写表）
├── components/           可复用组件
│   ├── config.js         配置读取、默认值合并、路径解析、configHint、ensureConfig
│   ├── constants.js      榜名、插件名
│   └── pluginVersion.js  版本号（回复页脚用）
├── lib/                  底层公共库（纯函数，不依赖 Yunzai）
│   ├── xlsx.js           极简 xlsx 容器读写
│   ├── schema.js         工作表结构解析（含主播区「专职」列与 G/H 入口）
│   ├── queue.js          排队业务逻辑
│   ├── render.js         文本渲染与各视图数据
│   ├── router.js         输入解析（选榜 / 榜名简称与序号）
│   ├── progress.js       完成判定、下一位、状态变化检测、月末判断
│   └── text.js           纯文本处理（并列项拆分，保护链接不被斜杠拆碎）
├── config/               config.yaml（运行时，入库忽略）+ config.yaml.example（参考）
├── test/                 回归套件
└── data/                 运行时数据（表格副本 / 启动器 / 日志 / 绑定 / 进度 / 字体，入库忽略）
```

编辑器就在本仓库的 `editor/` 里（`editor.mjs` / `editor.html` / `DEPLOY.md`），
它按绝对路径复用本插件的 `model/`、`lib/`、`components/`（表格读写只有一份实现，避免两套逻辑漂移）。

- `lib/xlsx.js`：极简 xlsx 容器。不整表解析重排，而是**外科手术式替换目标 `<c>` 节点**，写入用 `inlineStr` 从而完全不动 `sharedStrings.xml`；未改动的工作表逐字节保持原样。
- `model/table.js`：每次操作都重新读盘（可能刚被其它工具改过），写入走「读-改-校验-原子替换」；替换前会用新缓冲重新解析并核对写入结果，核对不过就放弃写入；所有写操作进程内串行，多人同时保存不会互相覆盖。
- `components/config.js`：首次启动自动从 `config.yaml.example` 生成运行时配置；缺 `remote.url` 时回复明确提示而不是静默失败。
- `components/roster.js`：取群成员（群名片优先）并推给云端编辑器，供「群昵称候选」与按 QQ 对账用。
- `lib/` 下全部是纯函数（不 import Yunzai、不碰文件系统），因此可以脱离机器人做回归测试。
- `apps/` 下的类由 `index.js` 聚合导出为 `module.apps`——这是框架 loader 的取法：插件根一旦存在 `index.js`，loader 就只导入它、不再扫 `apps/`（`lib/plugins/loader.js:58-62`、`:130`）。

## 已知限制

- **宿主的命令冷却会吞消息**：TRSS-Yunzai 的 `config/config/group.yaml` 里有 `singleCD`（默认 2000ms，同群同一人）与 `groupCD`（默认 500ms，同群）。用户连续快发独立指令时，冷却期内的消息在规则匹配前就被丢弃，插件收不到。实测发消息间隔 >2s 时 16/16 全部得到回复。
- 表格里没有 QQ 号列，「你是谁」靠群昵称 + QQ 绑定判定：绑定过之后按 QQ 认人；昵称被改动时由云端编辑器按群名片/群名单同步。
- 表格正被 Excel/WPS 打开时可能写入失败（`EPERM/EBUSY`），编辑器会明确提示「请关闭后重试」，不会写坏原文件。
- 表必须是 `.xlsx`（编辑器只认这一种）。

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
XLSX_PATH="D:/别的表.xlsx" pnpm test    # 指定被测表格
ABYSS_TEST_SYNTHETIC=1 pnpm test       # 强制用合成样本（验"没有真实表也全绿、零跳过"）
```

| 套件 | 覆盖 |
| --- | --- |
| `test/workbook.test.mjs` | 63 项：表格结构解析 / 写入与格式保全（含清行与换行的逐行样式）/ 特殊字符 / 源表未被触碰 / 视图数据与配置契约 |
| `test/workflow.test.mjs` | 50 项：经 `index.js` 的 `apps` 装载入口类、复刻 loader 分发，覆盖命令分发、定时任务、进度通知、按 QQ 定位与「插件不写表」；数据来自**假云端**（`test/env.mjs` 起的快照桩服务） |
| `test/aliases.test.mjs` / `test/progress.test.mjs` / `test/locate-self.test.mjs` | 别名归一 / 完成判定 / **按 QQ 定位与行归属**（同名不得认领别人已绑定的行） |
| `test/layout.test.mjs` | 4 项：**列对齐契约**——三张渲染模板与编辑器主表都是「文本列左、状态/数字列居中、表头跟着内容走」（只查规则有没有被改回去；长什么样用下面的 `render-check.mjs` 出图看） |
| `test/{commands,render-fallback,notice,clearrow-style,compact-style,save-row-style}.test.mjs` | 命令定义一致性 / 出图失败回退 / 首启通知 / 清行与换行的逐行样式 / 普通保存不抹平逐行样式 |
| `test/{remote-cache,snapshot-backup,autostart,deploy-windows,patches-host}.test.mjs` | 快照缓存失效 / 有效备份不被坏快照覆盖 / 编辑器随机器人启动 / Windows 一键部署产物（宿主根与默认数据目录都从脚本自身位置推导，默认数据目录 = `<插件根>\data`）/ 宿主根推导 |

**回归不依赖维护者的真实表**（外部审核「改进意见 #3」）：被测表格按 `XLSX_PATH` > 本机真实表 >
`test/fixtures/sample-table.mjs` 现生成的**匿名合成样本**（以 `resources/空模板.xlsx` 为骨架）三层取用，
合成产物写在 `test/.test-tmp/`（已忽略）。**没有"缺表就跳过"这回事**：`test/run.mjs` 会把"整套跳过"
单独计数，`ABYSS_TEST_SYNTHETIC=1` 可在本机复验"零跳过"。全量现在是 **36 个套件**。

`test/env.mjs` 默认起一个只认 `/api/snapshot?k=` 的小 HTTP 服务当"云端表"，并把配置指向它；
表格层套件要测本地读写，用 `ensureEnv({ cloud: false })` 走 `xlsx_path`。表格套件只操作表格**副本**，
结束时校验源表格哈希未变。约定细节见 `test/README.md`。

编辑器的套件（端到端 / 身份签名 / **短链** / 子路径挂载 / 主人专用 / 签名密钥 / 历史版本 / 群名单）就在 `editor/test/` 下，
`node test/run.mjs` 会一起跑（拿不到真实表格时自动跳过）。

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
