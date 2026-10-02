# 在线编辑器部署指南

群友在浏览器里填表，机器人在群里发链接与访问口令。编辑器是一个**零额外依赖**的
Node 服务（只用 node 内置模块 + `jszip`），可以单独部署到云服务器。

---

## 一、它需要什么

| 项 | 说明 |
| --- | --- |
| Node | ≥ 20.11（用到 `import.meta.dirname`） |
| 依赖 | `jszip`（读 xlsx 用）。插件目录里 `pnpm i` 一次即可 |
| 文件 | `tools/editor.mjs`、`tools/editor.html`、`lib/`、`model/`、`components/`、以及那份 xlsx |
| 端口 | 默认 `7788`（可改） |
| 域名/证书 | 建议有；没有的话浏览器会提示"不安全"，功能仍可用 |

---

## 二、最短部署步骤（云服务器）

假设服务器是 Linux，放 `/srv/abyss`。

```bash
# 1) 建目录：插件里除 node_modules 外的东西 + 表格
mkdir -p /srv/abyss/plugin
# 把本地插件目录内容传上去（tools/ lib/ model/ components/ package.json 等）
scp -r tools lib model components package.json user@server:/srv/abyss/plugin/
scp "2026年10月三路深渊排队.xlsx" user@server:/srv/abyss/queue.xlsx

# 2) 装依赖（只有 jszip）
cd /srv/abyss/plugin && npm i --omit=dev

# 3) 生成口令（随机 32 位）
TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
echo "口令：$TOKEN"   # 记下来，稍后填进机器人配置

# 4) 先手工跑一次，确认能起来
cd /srv/abyss/plugin
ABYSS_EDITOR_FILE=/srv/abyss/queue.xlsx \
ABYSS_EDITOR_TOKEN=$TOKEN \
ABYSS_EDITOR_BIND=0.0.0.0 \
ABYSS_EDITOR_PORT=7788 \
node tools/editor.mjs
# 另开一个终端： curl -s "http://127.0.0.1:7788/healthz?k=$TOKEN"
#   期望： {"ok":true,"file":"/srv/abyss/queue.xlsx",...}
```

### 做成常驻服务（systemd）

`/etc/systemd/system/abyss-editor.service`：

```ini
[Unit]
Description=Abyss queue online editor
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/abyss/plugin
Environment=ABYSS_EDITOR_FILE=/srv/abyss/queue.xlsx
Environment=ABYSS_EDITOR_TOKEN=把第 3 步生成的口令粘这里
Environment=ABYSS_EDITOR_BIND=0.0.0.0
Environment=ABYSS_EDITOR_PORT=7788
ExecStart=/usr/bin/node tools/editor.mjs
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now abyss-editor
systemctl status abyss-editor
```

没有 systemd 时，用 `pm2 start tools/editor.mjs --name abyss-editor`，环境变量写在 `ecosystem.config.cjs` 里。

### 反向代理 + HTTPS（推荐）

Nginx：

```nginx
server {
  listen 443 ssl;
  server_name 你的域名;

  ssl_certificate     /etc/letsencrypt/live/你的域名/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/你的域名/privkey.pem;

  client_max_body_size 4m;   # 与编辑器自己的上限一致

  location / {
    proxy_pass http://127.0.0.1:7788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

证书可用 `certbot --nginx -d 你的域名` 自动申请。

---

## 三、把地址与口令填进机器人

编辑 `<bot根>/plugins/abyss-queue/config/config.yaml`：

```yaml
# 在线编辑器地址（群友访问的地址，不要带结尾斜杠）
editor_url: "https://你的域名"
# 访问口令：必须与服务器上的 ABYSS_EDITOR_TOKEN 完全一致
editor_token: "第 3 步生成的口令"
```

重启机器人（`#重启`）后，群里发 `#排队` 会：

1. 发一张三榜总览图（图内底部显示编辑器地址）
2. 再发一条文字：带口令的完整链接 `https://你的域名/?k=<口令>`

口令只随这条回复发放，所以**不在群里的人拿不到口令**——这就是"仅群成员可访问"的实现方式。
链接被转发出去、对方没有口令时会看到"请输入访问口令"页，仍然进不去。

---

## 四、表格数据怎么保持最新

编辑器读写的是**服务器上那一份 xlsx**。有两个选择：

- **只让群友在在线编辑器里填**：把服务器那份作为唯一数据源；本机要用机器人查数据时，定期把它拷回来
  ```bash
  # 在机器人这台机器上执行（示例：scp 拉回）
  scp user@server:/srv/abyss/queue.xlsx "D:/文件/游戏/原神/2026年10月三路深渊排队.xlsx"
  ```
- **继续在腾讯文档里维护**：那就不要同时用这个编辑器，避免两份各改一份互相覆盖。

> 无论哪种，编辑器每次保存都会写一份 `queue.xlsx.bak`，改错了可以从它恢复。

---

## 五、安全与运维要点

| 事项 | 做法 |
| --- | --- |
| 只暴露必要的端口 | 云安全组只放行 443（以及 80 用于跳转），**不要**把 7788 直接开到公网 |
| 口令轮换 | 改服务器上的 `ABYSS_EDITOR_TOKEN` 并同步改机器人配置，旧链接立即失效 |
| 备份 | 每天备份服务器上的 xlsx 与 `.bak`（`cron` + 异地存一份） |
| 日志 | `journalctl -u abyss-editor -f` |
| 健康检查 | `GET /healthz?k=<口令>` 返回 `{"ok":true,...}` |
| 出错排查 | 保存失败时页面会直接显示原因（必填缺失 / 昵称重复 / 下拉值不在选项里 / 文件被占用） |

---

## 六、本机测试（不部署也能试）

```bash
# 在机器人根目录
ABYSS_EDITOR_BIND=127.0.0.1 ABYSS_EDITOR_TOKEN=test node plugins/abyss-queue/tools/editor.mjs
# 浏览器打开 http://127.0.0.1:7788/?k=test
```

不带 `--token`/`ABYSS_EDITOR_TOKEN` 时不校验口令，**只建议在本机这样用**。
