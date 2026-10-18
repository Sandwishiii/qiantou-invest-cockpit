# 部署到服务器

先说清楚：**不部署也能用**，双击 `启动钱途.bat` 就是完整形态。要往服务器上放，通常只有两个理由——手机/多台设备也想看，或者希望它 7×24 一直开着。

服务监听端口默认就是 **8618**，和安全组里填的保持一致即可。

## 0. 前提

- Node 18+（用到全局 `fetch` 和 `AbortSignal.timeout`）
- 一台 Linux 服务器（阿里云 ECS / 轻量应用服务器都行，1 核 1G 足够）
- 本项目零依赖，**不需要 `npm install`**，没有 `node_modules`

## 1. 装 Node

国内机器别走 nodejs.org 官方源，直接用 npmmirror 的二进制包最快：

```bash
cd /usr/local/src
curl -LO https://registry.npmmirror.com/-/binary/node/v20.18.0/node-v20.18.0-linux-x64.tar.xz
tar -xf node-v20.18.0-linux-x64.tar.xz
ln -sf /usr/local/src/node-v20.18.0-linux-x64/bin/node /usr/local/bin/node
node -v
```

Ubuntu / Debian 也可以 `apt-get install -y nodejs`，但发行版自带的常常是老版本，优先上面的二进制包。

## 2. 拉代码

```bash
cd /opt
git clone --depth 1 https://github.com/Sandwishiii/qiantou-invest-cockpit.git qiantou
cd qiantou
```

## 3. K 线图依赖（可选，1MB）

ECharts 不放进仓库，服务器上手动拉一次（等价于 Windows 上的 `装依赖.bat`）：

```bash
mkdir -p vendor
curl -L -o /tmp/echarts.tgz https://registry.npmmirror.com/echarts/-/echarts-5.5.1.tgz
tar -xzOf /tmp/echarts.tgz package/dist/echarts.min.js > vendor/echarts.min.js
ls -l vendor/   # 正常约 1030855 字节
```

不装也不影响别的页面，只是点开个股看不到 K 线。

## 4. 放数据

二选一：

```bash
node seed.js      # 生成一份中性演示数据
```

或者把你本机那份真实持仓传上去（在你 Windows 电脑的 Git Bash 里执行）：

```bash
scp /e/ai_life/钱途投资舱/data/portfolio.json root@服务器IP:/opt/qiantou/data/
```

这一步等于把真实持仓和金额放到云上，值不值你自己权衡；不想放就只跑演示数据，功能一样能看。

## 5. 先手动跑一次

```bash
cd /opt/qiantou
HOST=0.0.0.0 PORT=8618 node server.js
```

另开一个终端验证：

```bash
curl -s http://127.0.0.1:8618/api/health
# {"ok":true,"host":"0.0.0.0","port":8618,"node":"v20.18.0",...}
```

启动日志里会有一行 ⚠ 提醒：**这个服务没有登录鉴权**，能连上端口的人既能看也能改你的持仓。所以第 6 步的白名单不是可选项。

## 6. 放行端口（两层都得通）

1. **阿里云安全组**：入方向 → 自定义 TCP →端口范围 `8618/8618` → 授权对象填 `你的公网IP/32`。查自己出口 IP：`curl myip.ipip.net`。**不要填 `0.0.0.0/0`。**
2. **服务器本机防火墙**（装了 firewalld / ufw 的话）：

```bash
firewall-cmd --permanent --add-port=8618/tcp && firewall-cmd --reload
# 或者： ufw allow 8618/tcp
```

家宽出口 IP 会变（运营商重拨就换）。哪天突然打不开，第一件事是重新查出口 IP，看它和安全组里填的还是不是同一个。

## 7. 让它常驻（systemd）

新建 `/etc/systemd/system/qiantou.service`：

```ini
[Unit]
Description=钱途投资舱
After=network.target

[Service]
WorkingDirectory=/opt/qiantou
Environment=HOST=0.0.0.0
Environment=PORT=8618
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now qiantou
systemctl status qiantou --no-pager
journalctl -u qiantou -f        # 看实时日志，Ctrl+C 退出
```

顺手把时区对齐 A 股，否则「今天」「交易日」「除息日在不在窗口内」这些判断会偏一天：

```bash
timedatectl set-timezone Asia/Shanghai
```

## 8. 更省心的两种替代方案（建议优先考虑）

### A. 不开公网端口，用 SSH 隧道

服务器上什么都不用改（默认就监听 `127.0.0.1`），在你电脑上：

```bash
ssh -N -L 8618:127.0.0.1:8618 root@服务器IP
```

浏览器照常开 `http://127.0.0.1:8618`。安全组只需要 22 端口对你自己 IP 开放，8618 一条规则都不用建。手机想访问用 Termius / Blink 建同样的隧道。

### B. Tailscale 组虚拟内网

服务器和电脑都装 tailscale，直接用它的内网地址 `http://100.x.x.x:8618`。不开任何公网端口，出口 IP 怎么变都不影响，手机电脑一视同仁。

## 9. 一定要公网直接访问，就加一层口令

应用本身没有账号体系，公网裸奔等于谁都能改你的数据。最省事的是 nginx 反向代理 + basic auth，此时服务用默认 `HOST=127.0.0.1` 启动（只允许本机 nginx 访问），安全组开 80/443 而**不是** 8618：

```bash
yum install -y nginx httpd-tools        # Ubuntu: apt-get install nginx apache2-utils
htpasswd -c /etc/nginx/.htpasswd 你的名字
```

```nginx
server {
    listen 80;
    server_name _;

    auth_basic "qiantou";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:8618;
        proxy_set_header Host $host;
    }
}
```

```bash
systemctl enable --now nginx
```

## 10. 上云后的已知差异

- **东财接口对机房 IP 限流更凶**。表现为 ETF 页顶部提示「主力净流入取自新浪备用口径」，或者部分 ETF 缺当日数据。这不是坏了，等两三分钟点右上角「立即刷新」；两个口径数值不等价，页面里已经标了来源。
- 缓存、滚动备份都只在 `data/` 下（`cache/`、`backup/`）。换服务器直接整个 `data/` 拷走即可，`.gitignore` 已经保证它不会被提交。
- 数据是单个 JSON、没有并发控制。多台设备同时录入会互相覆盖，别两个人一起记流水。
- 改了代码要 `systemctl restart qiantou`；`git pull` 后同理。

## 附：Windows 本机部署

上面这些全都不需要。双击 `启动钱途.bat` 起服务并自动开浏览器；想开机自启，把它的快捷方式放进 `Win+R` → `shell:startup` 打开的那个目录。
