# 排队表编辑器（`abyss-queue/editor/`）

排队表的**写入程序**，就住在本插件里（`editor/`），随插件一起部署到云服务器。

本文档里的「**云端**」= 部署在云服务器上的这份编辑器；它不是任何第三方在线文档。

## 谁在改表

| 角色 | 能不能改表 |
|---|---|
| **云端编辑器**（云服务器，本目录的代码） | ✅ 唯一的程序写入方 |
| 三路深渊排队插件（机器人） | ❌ 只读：取快照 → 渲染 → 推送（顺带把群成员名单推给云端） |
| **本机编辑器**（同一份代码，开 `--owner-only`） | ✅ 但**只有主人**能打开；本机那份是云端数据的备份/工作副本，改完点「上传覆盖云端」才会回到云端 |

## 与插件的关系

编辑器和插件住在一起，但**表格读写、别名归一、身份签名只有一份实现**（复制一套迟早漂移，
那才是会污染数据的做法）。编辑器按绝对路径从插件目录加载共用模块：

```
--plugin <插件目录>            显式指定
ABYSS_PLUGIN_DIR=<插件目录>    环境变量
默认                           自己所在的插件根（editor/ 的上一级）
```

被复用的部分：`model/`（表格读写 + 绑定存储）、`lib/`（xlsx / schema / queue / aliases / identity）、
`components/`（配置 / 字体）、`test/_helper.mjs`（断言脚手架）。
本目录自己只有：`editor.mjs`、`editor.html` 与本目录的测试。

## 本机跑（主人自己用）

```bash
# 本机那份是"云端数据的备份/工作副本"：先从云端拉一份，再起编辑器（只给主人用）
node editor.mjs --file "D:/Program Files/Yunzai/abyss-queue-data/排队表-本地.xlsx" --port 7788 \
  --token <访问口令> --sign-key <签名密钥> --owner-only \
  --cloud https://<你的域名>/queue
# 浏览器打开 http://127.0.0.1:7788/?k=<口令>&u=<主人身份>&s=<签名>
#   —— 用启动器（D:\Program Files\Yunzai\abyss-queue-data\editor-launch.mjs）会自动签好主人身份并打开页面
```

## 参数

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--file <xlsx>` | `ABYSS_EDITOR_FILE` | 要编辑的表格 |
| `--plugin <dir>` | `ABYSS_PLUGIN_DIR` | 插件目录（共用模块来源） |
| `--port` | `ABYSS_EDITOR_PORT` | 监听端口，默认 7788 |
| `--bind` | `ABYSS_EDITOR_BIND` | 监听地址，默认 127.0.0.1（云端部署用 0.0.0.0 并靠 nginx/口令兜着） |
| `--token` | `ABYSS_EDITOR_TOKEN` | **访问口令**：决定"能不能用这个服务"，会出现在每个人的链接里 |
| `--sign-key` | `ABYSS_EDITOR_SIGN_KEY` | **身份签名密钥**：决定"你是谁"，不进链接；不配则退回用口令签（等于谁拿到链接都能伪造身份，正式部署必须单独配） |
| `--admin-token` | `ABYSS_EDITOR_ADMIN_TOKEN` | 管理口令：用它打开 `?a=<口令>` 维护白名单（主人的备用入口） |
| `--owner-only` | `ABYSS_EDITOR_OWNER_ONLY` | **只有主人能打开**（本机编辑器用；`/api/snapshot`、`/healthz` 仍只凭口令放行） |
| `--owner` | `ABYSS_EDITOR_OWNER` | 主人名单（QQ 或群昵称，逗号分隔），与白名单文件里的 `owner` 合并 |
| `--admins <json>` | `ABYSS_EDITOR_ADMINS_FILE` | 白名单文件，默认与表格同目录的 `abyss-editor-admins.json` |
| `--cloud <url>` | `ABYSS_EDITOR_CLOUD` | 云端编辑器地址：配了才有「上传覆盖云端」按钮 |
| `--roster-qq` | `ABYSS_EDITOR_ROSTER_QQ` | 允许推送群成员名单的机器人身份，默认 `0` |
| `--versions-keep` | `ABYSS_EDITOR_VERSIONS_KEEP` | 历史版本保留份数，默认 20（0 = 不存版本） |
| `--mount` | `ABYSS_EDITOR_MOUNT` | 挂在子路径时的前缀，默认 `/queue` |
| `--log` | `ABYSS_EDITOR_LOG` | 把日志写进文件（本机启动器用） |

## 接口

| 路径 | 说明 |
|---|---|
| `GET /` | 填写界面（无口令给出口令输入页；`--owner-only` 时非主人看到"只有主人能打开"） |
| `GET /healthz?k=` | 版本、字段、功能清单、口令/签名密钥/白名单/群名单状态（探活与一致性自检用） |
| `GET /api/data?k=&u=&s=` | 按身份裁剪后的数据（界面用），含群昵称候选 |
| `GET /api/snapshot?k=` | **表格快照**：返回 xlsx 原始字节，给机器人当只读数据源（插件按 `remote.ttl_ms` 定期拉） |
| `POST /api/save` · `POST /api/anchors` | 保存数据行 / 主播列表 |
| `GET /api/versions` · `POST /api/restore {id}` | 历史版本列表 / 回退到某个版本（主人） |
| `POST /api/upload` | 用上传的 xlsx 覆盖当前表（主人；本机「上传覆盖云端」走这里） |
| `POST /api/push-cloud` | 本机编辑器专用：把本机那份表推给云端覆盖（需要 `--cloud`） |
| `POST /api/roster` | 机器人推群成员名单（只认机器人身份或主人）：候选 + 按 QQ 对账 |
| `GET/POST /api/admins` | 白名单维护（主人或管理口令） |
| `GET /font/cn.woff` | 编辑器页面的中文字体（原神字体，本机缓存/云端拉取） |

## 权限

- **主人**：能改所有人的行、改主播列表、维护白名单、看/回退历史版本、上传覆盖云端
- **白名单管理员**：能改所有人的行、改主播列表
- **带身份签名的人**（`?u=&s=`，密钥是**签名密钥**）= 本人：只能改自己那一行；完成情况被主播填过的行对他上锁
- **没有签名** = 只读访客
- 本机编辑器开 `--owner-only`：以上之外的人一律 403（只有 `/api/snapshot`、`/healthz` 仍凭口令放行）

## 数据安全

- 写入是「读 → 改 → **写后自检**（重新解析新文件核对写入值）→ 原子替换」，核对不过就放弃写入
- 每次写表**前**把当前状态存进 `<表目录>/versions/`（默认留最近 20 份；默认是空的，第一次写表才有第一份）
- 回退前也会先存一份当前状态 → 回退错了能再退回来
- 覆盖类操作（回退 / 上传）先校验「能否解析」+「工作表清单与当前一致」，防传错文件把表搞坏
- 替换前落 `<表>.bak`；群成员名单为空时**拒绝**按它对账（防止全员被当成退群）
- 群成员退群时删掉他那行并**压紧**（下面的人整体上移，队列不留空洞），删前自动存版本

## 测试

```bash
# 在插件根目录跑：同时包含插件与编辑器的全部套件
node test/run.mjs
# 编辑器自己的套件：editor/test/{editor,identity,mount,owner-only,sign-key,versions,roster}.test.mjs
# 拿不到真实表格时会自动跳过（可用 XLSX_PATH 指一份 xlsx）
```

## 部署到云服务器

见 [`DEPLOY.md`](./DEPLOY.md)（systemd + nginx `location /queue` 的写法、口令与签名密钥、备份、健康检查、
权限矩阵与换月流程）。要点：**把插件目录一起带上**（共用模块），并**务必单独配签名密钥**。
