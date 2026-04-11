export default {
  async fetch(request, env) {
    try {
      const newDomain = env.url;

      if (!newDomain) {
        return new Response("未设置环境变量 url", {
          status: 500,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }

      const reqUrl = new URL(request.url);
      const targetUrl = new URL(newDomain);

      // 防止目标域名也挂了同一个 Worker，出现循环跳转
      if (reqUrl.hostname === targetUrl.hostname) {
        return new Response("当前已是目标域名，无需跳转", {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }

      // 保留原路径和查询参数
      targetUrl.pathname = reqUrl.pathname;
      targetUrl.search = reqUrl.search;

      // 正式环境用 301，测试时可改 302
      return Response.redirect(targetUrl.toString(), 301);
    } catch (err) {
      return new Response(`跳转失败：${err.message}`, {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
  },
};
