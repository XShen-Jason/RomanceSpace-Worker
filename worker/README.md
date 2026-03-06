# RomanceSpace Worker

该目录存放 Cloudflare Worker 边缘节点的逻辑代码。该 Worker 负责拦截平台所有的通配符子域名请求，并通过查询 KV 或 D1 渲染对应的项目页面。

## 本地开发指南

1. 进入当前目录:
```bash
cd worker
```

2. 安装依赖:
```bash
npm install
```

3. 本地测试运行:
```bash
npm run dev
```

## Cloudflare 部署配置

在实际部署前，请确保在根目录下你已登录了你的 Cloudflare 账号：
```bash
npx wrangler login
```
*执行后会在浏览器弹窗，登录确认即可。*

如果你想静态使用 Token，请配置环境变量：
```bash
set CLOUDFLARE_API_TOKEN="your-api-token"
```

修改 `wrangler.toml` 文件，启用 KV、D1 数据库绑定；然后执行发布：
```bash
npm run deploy
```
