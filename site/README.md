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
