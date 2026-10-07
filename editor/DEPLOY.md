# 编辑器部署（要点速览）

> 这里只放**要点**，够你看出该准备什么、该注意什么。
> 具体的 nginx / systemd 配置、逐步命令与排障表**不写进插件**（插件里只抛砖引玉），需要时直接找我要一份。

## 一句话架构

**云端编辑器（云服务器）是唯一写入口** → 机器人只读它的 `/api/snapshot` 快照 → 本地留一份最新备份。
「云端」指这份部署在服务器上的编辑器，不是任何第三方在线文档。

## 要准备什么

| 项 | 说明 |
| --- | --- |
| Node | ≥ 20.11（用到 `import.meta.dirname`） |
| 依赖 | `jszip`、`yaml`：插件目录 `npm i --omit=dev` |
| 反向代理 | nginx（建议配 HTTPS），把 `https://<域名>/queue` 转到 **bot 的端口**（`<Yunzai>/config/config.yaml` 里 `server.port`，默认 2536）。**不是 7788**——编辑器现在挂在 bot 自己的 HTTP server 上 |
| 数据目录 | **固定、不可配置**：`<插件目录>/data`（插件装在 `<Yunzai>/plugins/abyss-queue`，所以就是 `<Yunzai>/plugins/abyss-queue/data`）：`queue.xlsx` + `versions/` + `archives/` + 白名单/绑定/锁/群名单/**链接认领记录**。**不允许离开插件目录** |
| 进程守护 | 不需要单独守护：编辑器随 bot 起停（bot 挂了它就没了，bot 起来它就回来）。三个密钥在 `config/config.yaml` 里，不走命令行、也不走环境变量 |
| 起始表 | 把插件自带的 `resources/空模板.xlsx` 复制成 `<插件目录>/data/queue.xlsx`。**没有这张表编辑器不会挂载**（fail-closed：记一行 **error** 日志、bot 照常跑） |

> 数据目录**固定、不可配置**：编辑器的表与它派生的一切（`.bak` / 绑定 / 白名单 / 锁 / 群名单 /
> `versions/` / `archives/`）都必须待在 `<插件根>\data` 里，`--file`（或 `ABYSS_EDITOR_FILE`）指到
> 插件外就**拒绝启动**；插件侧那三个落点（绑定 / 快照备份 / 进度快照）**本身就是 `data/` 下的常量**，
> 配置里连路径键都没有，所以没有"配到外面"这回事。`data/` 已被 git 忽略，所以 `#排队更新` 只动代码不动数据。
> 回归套件要指临时目录时用 `ABYSS_EDITOR_TEST_PATHS=1` 与 `ABYSS_QUEUE_*` 那组环境变量（**生产绝不要设**）。

## 三个密钥（**不要用同一个**）

都在机器人侧 `config/config.yaml` 的 `remote` 段（编辑器由宿主注入，只有这一份来源）：

| 配置键 | 作用 | 进不进链接 |
| --- | --- | --- |
| `remote.token` | 访问口令：能不能用这个服务 | **进**（每个人的链接里都有） |
| `remote.sign_key` | 身份签名密钥：你是谁、能改哪些行 | 不进（只留在机器人与编辑器） |
| `remote.admin_token` | 管理口令：主人维护白名单的备用入口（`?a=<这段>`） | 不进（可选，留空 = 不开这个入口） |

> 口令与签名密钥相同 = 任何拿到链接的人都能伪造别人的身份（包括主人）。不配签名密钥时编辑器会退回
> 用口令签，并在启动日志里明确警告——正式部署务必单独配。

## 必须写对的几处

1. `data/abyss-editor-admins.json` 里的 `owner` **必填**（开 `--owner-only` 时没它就拒绝启动）
2. 机器人侧 `remote.url` 填**对外那个地址**（`https://<域名>/queue`）；`remote.token` / `remote.sign_key` /
   `remote.admin_token` 是插件与编辑器**共用**的那一份，不用再去别处对齐；`roster.group` 填群号（**要在群里填**）
3. nginx 的 `client_max_body_size` 要够大（上传整张表，建议 32m）
4. 表文件别用 Excel/WPS 直接打开着改（会写失败）

## 部署后逐条验收

- `curl https://<域名>/queue/healthz?k=<口令>`：`auth`/`sign_key`/`owners`/`roster` 都对
- 群友点自己链接：只看到、只改得动自己那一行；没签名的链接只读
- 机器人日志：`已连上云端表：…`、`群成员名单已同步到编辑器：N 人`
- 主人页面：「历史版本」能列出、能回退、能下载；本机的「上传覆盖云端」能推上去

## 数据安全（已经做在代码里）

每次写表**前**存历史版本（滚动 20 份，可回退，回退也留一份）＋ 每月的最后一次修改长期归档（默认 12 个月）
＋ 每日归档只留最近 7 天；覆盖类操作先校验再原子替换，替换前落 `.bak`；
退群删行会压紧（不留空洞）；空名单拒绝对账。

**链接认领与时间窗**：链接由**第一台打开它的设备**认领（设备 cookie + `<插件根>/data/abyss-editor-claims.json`），
别人再点同一条链接只能看；管理员及以上 24 小时内不必再带链接，普通群友只到本次会话；
链接带 5 分钟时间窗，旧窗一律 410。**建议走 HTTPS**：外网 https 下设备 cookie 才会带 `Secure`
（判据是 `req.socket.encrypted` 与反代的 `x-forwarded-proto`，nginx 记得把真实协议传下来）。

## 需要详细步骤时

找我拿《nginx 部署手册》：包含 systemd 单元、nginx `location /queue` 两种挂法、逐步命令、
权限矩阵、换月流程与排障表。
