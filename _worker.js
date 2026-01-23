export default {
  async fetch(request, env) {
    // 读取 Pages 后台设置的环境变量 "url"
    const targetUrl = env.url;

    // 检查是否设置了变量
    if (!targetUrl) {
      return new Response("配置错误: 未在 Pages 设置中找到 url 变量。\n请在 Settings -> Environment variables 中添加。", {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    }

    // 执行 302 重定向
    return Response.redirect(targetUrl, 302);
  },
};
