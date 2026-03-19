export default {
  async fetch(request, env) {
    try {
      // 1. 读取你在 CF 后台设置的变量 url
      const targetStr = env.url; 
      
      if (!targetStr) {
        return new Response("还没设置跳转目标哦！请在 Worker 设置 -> 变量中添加名为 url 的变量。", { 
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      // 智能处理你填写的变量：不管你填的是 https://abc.com 还是 abc.com/xxx，都只提取纯域名
      const targetDomain = targetStr.replace(/^https?:\/\//, '').split('/')[0];

      const url = new URL(request.url);
      url.hostname = targetDomain;
      url.protocol = 'https:'; // 强制用 HTTPS 去拉取目标网站

      // 2. 构造新的请求头，深度伪装
      const newHeaders = new Headers(request.headers);
      newHeaders.set('Host', targetDomain);
      newHeaders.set('Origin', `https://${targetDomain}`);
      newHeaders.set('Referer', `https://${targetDomain}${url.pathname}`);
      
      // 3. 构造 Fetch 参数
      const init = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual' // 核心：拦截重定向，防止跳回原域名
      };
      
      // 核心修复：GET 和 HEAD 请求坚决不能带 body，否则会报错
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
      }

      // 4. 发起反代请求
      const response = await fetch(url.toString(), init);

      // 5. 处理返回的响应头
      const responseHeaders = new Headers(response.headers);
      
      // 解决跨域问题
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      
      // 核心：如果有重定向，把目标网站的域名替换回你自己的 Worker 域名，防止露馅
      const location = responseHeaders.get('Location');
      if (location) {
        responseHeaders.set(
          'Location', 
          location.replace(new RegExp(`https?://${targetDomain}`, 'ig'), new URL(request.url).origin)
        );
      }

      // 抹除目标网站防反代、防嵌套的安全头，避免浏览器白屏
      responseHeaders.delete('Content-Security-Policy');
      responseHeaders.delete('X-Frame-Options');
      responseHeaders.delete('Clear-Site-Data');

      // 返回最终内容给浏览器
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });

    } catch (err) {
      // 如果出错，直接把报错信息打出来，方便排查，而不是显示死板的 CF 错误页
      return new Response(`反代执行出错啦: \n${err.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};
