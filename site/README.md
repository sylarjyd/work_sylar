# WorkSylar 官网（应用介绍站）

静态单页官网，零运行依赖：`index.html` + `styles.css` + `script.js`。
`preview.png` 是 Hero 视觉预览（截图模式 `?static=1`）。

```bash
node site/server.mjs        # http://127.0.0.1:3002
```

- `/?static=1`：关闭滚动入场动画，用于截图、打印与自动化视觉检查；
- CTA 默认指向本地工作台（`http://localhost:3000/login`）与套餐页（`/billing`），
  上线前改成本域名；
- 页面结构：Hero → 产品能力 → 工作方式 → 应用场景 → 安全与部署 → 定价 → FAQ → CTA / Footer；
- 无外部字体、图片与第三方脚本，可直接交给 Nginx / 对象存储托管。

## 部署

```bash
# 静态托管（Nginx 示例见 nginx.conf）
rsync -av site/ user@host:/var/www/worksylar/site/
```

- `site/nginx.conf`：HTTP/HTTPS、gzip、静态缓存与安全响应头示例；
- 域名、证书、分析统计需要你提供：正式域名、证书方式（Let's Encrypt / 已有证书）、
  统计平台（如 Plausible / 百度统计 / GA4 的站点 ID）。
  统计脚本建议放在 `</body>` 前，先征得同意再接入。

```nginx
server {
  listen 80;
  server_name worksylar.com;
  root /var/www/worksylar/site;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
}
```

## 修改入口

- 文案与结构：`site/index.html`
- 主题色、间距、响应式：`site/styles.css`（`:root` 变量）
- 交互：`site/script.js`（导航滚动、移动端菜单、入场动画）
