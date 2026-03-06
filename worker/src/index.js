/**
 * RomanceSpace Cloudflare Worker Entry Point
 * 
 * 此代码架构用于拦截子域名请求，并将其分发到对应的项目模板渲染引擎。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // 假设平台主域名是 romancespace.com
    // 如果是主域名访问，可以返回主平台介绍页或重定向到注册页
    if (hostname === "romancespace.com" || hostname === "www.romancespace.com") {
      return new Response("欢迎来到 RomanceSpace 主平台！", { status: 200 });
    }

    // 提取子域名
    // 例如：xiaoming.romancespace.com -> subDomain = xiaoming
    const subDomain = hostname.split('.')[0];

    try {
      // 1. 从 KV 中查询该子域名的配置参数
      // const projectConfig = await env.PROJECT_ROUTES.get(subDomain, { type: "json" });
      
      // MOCK 模拟逻辑
      let projectConfig = null;
      if (subDomain === "demo") {
        projectConfig = { type: "love_letter", title: "致最爱的你", content: "..." };
      }

      // 如果未找到该子域名项目
      if (!projectConfig) {
        return new Response("项目不存在或未配置", { status: 404 });
      }

      // 2. 根据项目类型渲染页面
      const htmlContent = renderTemplate(projectConfig);
      
      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });

    } catch (err) {
      return new Response("Serve Error: " + err.message, { status: 500 });
    }
  }
};

/**
 * 模板渲染引擎桩函数
 */
function renderTemplate(config) {
  if (config.type === "love_letter") {
    return `<!DOCTYPE html><html><body><h1>${config.title}</h1><p>这是一个测试模板页面。</p></body></html>`;
  }
  return `<h1>默认页面</h1>`;
}
