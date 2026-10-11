# 介绍页部署

ZPI 介绍页是纯静态页面，不需要 Node.js、构建工具、JavaScript、CDN 或外部字体。它介绍桌面客户端，不是在线运行的 Agent 服务。

## 访问路径

- 公开地址：[http://101.200.240.206/zpi/](http://101.200.240.206/zpi/)
- `/zpi`（无斜杠）由 Nginx 301 重定向到 `/zpi/`。
- 根路径 `/` 返回 404，不放置任何内容，为这台服务器保留其他路径。

## 文件

- `docs/site/index.html`：介绍内容与导航。
- `docs/site/styles.css`：桌面和移动端样式。
- `docs/site/favicon.svg`：站点图标。
- `docs/deploy/nginx.conf`：Nginx 站点配置，不属于公开站点目录。

页面没有统计脚本、Cookie 或表单。Nginx 默认仍会保存服务器访问日志，这与桌面客户端的「没有遥测」不是同一件事。

## 当前机器

- 服务器：`root@101.200.240.206`，Ubuntu 22.04。
- Web 根目录：`/var/www/zpi/html`；介绍页位于 `/var/www/zpi/html/zpi`，对应路径 `/zpi/`。
- Nginx 配置：`/etc/nginx/sites-available/zpi`，由 `sites-enabled/zpi` 链接启用。
- 旧配置备份：`/etc/nginx/sites-available/zpi.before-zpi-path`（根路径版本）和 `sites-available/default.before-zpi`（Nginx 默认站点），均不在启用目录中。
- Nginx 已设置开机启动。

当前仅使用 HTTP。没有配置域名或 TLS；不要在这个介绍站点传输凭据。若后续绑定域名，再更新 `server_name` 并配置 HTTPS。部署前应确认云安全组允许 TCP 80；不要为静态站点开放额外端口或关闭防火墙。

## 首次部署

以下命令从仓库根目录执行，适用于这台初始未安装 Nginx、80 端口无其他业务的服务器。对已有业务的机器，不要直接移除默认站点，应先检查 `nginx -T` 并使用独立域名配置。

```sh
ssh root@101.200.240.206 \
  'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y nginx'

ssh root@101.200.240.206 'install -d -m 755 /var/www/zpi/html/zpi'
scp docs/site/index.html docs/site/styles.css docs/site/favicon.svg \
  root@101.200.240.206:/var/www/zpi/html/zpi/
scp docs/deploy/nginx.conf root@101.200.240.206:/etc/nginx/sites-available/zpi

ssh root@101.200.240.206 '
  if [ -L /etc/nginx/sites-enabled/default ]; then
    cp -n /etc/nginx/sites-available/default /etc/nginx/sites-available/default.before-zpi
    rm /etc/nginx/sites-enabled/default
  fi
  chmod 644 /var/www/zpi/html/zpi/* /etc/nginx/sites-available/zpi
  ln -sfn /etc/nginx/sites-available/zpi /etc/nginx/sites-enabled/zpi
  nginx -t && systemctl enable --now nginx && systemctl reload nginx
'
```

只上传三个静态文件，不要把仓库、环境配置或凭据上传到公开目录。

## 更新与验证

更新前保留旧站点备份，之后上传静态文件即可；没有配置变更时无需重启 Nginx。

```sh
ssh root@101.200.240.206 \
  'cp -a /var/www/zpi/html/zpi "/var/www/zpi/zpi.backup-$(date +%Y%m%d-%H%M%S)"'
scp docs/site/index.html docs/site/styles.css docs/site/favicon.svg \
  root@101.200.240.206:/var/www/zpi/html/zpi/

ssh root@101.200.240.206 \
  'nginx -t && systemctl is-active nginx && systemctl is-enabled nginx'
curl -I http://101.200.240.206/zpi/
curl -I http://101.200.240.206/zpi/styles.css
```

若需更新配置，先备份 `/etc/nginx/sites-available/zpi`，上传后执行 `nginx -t && systemctl reload nginx`。验证失败时还原旧配置；回退网页时把备份目录中的三个静态文件复制回 `/var/www/zpi/html/zpi`。

本地预览可运行 `python3 -m http.server 8080 --directory docs/site --bind 127.0.0.1`，然后访问 [http://127.0.0.1:8080](http://127.0.0.1:8080)。直接用浏览器打开 `index.html` 也可查看，不依赖网络加载样式。

## 迁移记录

- 2026-10-11：介绍页从根路径 `/` 迁移到 `/zpi/`。服务器执行 `mkdir -p /var/www/zpi/html && mv /var/www/zpi/site /var/www/zpi/html/zpi` 保留原文件；旧配置备份为 `zpi.before-zpi-path`，替换配置后 `nginx -t` 通过并 reload。根路径不再提供内容。

## 本次部署验收

- `nginx -t` 通过，服务状态为 `active`。
- 路径行为：`/` 返回 404；`/zpi` 返回 301 且 `Location` 为 `http://101.200.240.206/zpi/`；`/zpi/`、`/zpi/styles.css`、`/zpi/favicon.svg` 返回 200；`/zpi/does-not-exist`、`/styles.css`、`/zpix` 返回 404；`/.env` 与 `/zpi/.env` 返回 403。
- 线上三个静态文件与仓库内容逐字节一致。
- 公网 `/zpi/` 通过 Chromium 的 320、375、390、768、1280、1440 px 布局检查：无横向溢出，资源加载正常，页内锚点存在，FAQ 支持键盘打开与关闭。
- CSP、`nosniff` 与缓存头在 `/zpi/` 正常。
- 站点文件通过 Biome 检查，Markdown 本地链接及 `git diff --check` 通过。

本次只修改文档、静态介绍页和 Nginx 配置，未运行桌面应用构建或完整单元测试；上述浏览器检查不代表桌面客户端的功能回归验证。
