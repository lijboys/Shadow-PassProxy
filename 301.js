export default {
  async fetch(request, env) {
    try {
      // ==============================
      // 方法 1：硬编码 URL（优先使用）
      // ==============================
      const hardcodedUrl = ""; // 例如 "https://example.com"

      // ==============================
      // 方法 2：通过环境变量
      // ==============================
      const envUrl = env.url; // Cloudflare Worker 设置的变量

      // 选择使用硬编码 URL（非空）或者环境变量
      let targetBase = hardcodedUrl || envUrl;

      if (!targetBase) {
        return new Response("还没设置跳转目标！请在 Worker 里设置 hardcodedUrl 或环境变量 url。", {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // 确保 targetBase 不带结尾斜杠
      targetBase = targetBase.replace(/\/$/, "");

      // 保留原始请求路径
      const path = new URL(request.url).pathname + new URL(request.url).search;

      // 构造最终跳转 URL
      const redirectUrl = targetBase + path;

      // 返回 301 永久重定向
      return Response.redirect(redirectUrl, 301);

    } catch (err) {
      return new Response(`重定向执行出错啦:\n${err.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }
};
