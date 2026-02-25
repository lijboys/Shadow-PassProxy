export default {
  async fetch(request, env) {
    const originalUrl = new URL(request.url);
    
    // 1. 读取你在网页版设置的变量 url (例如 "github.com")
    const targetDomain = env.url; 
    
    // 替换请求目标
    const fetchUrl = new URL(request.url);
    fetchUrl.hostname = targetDomain;
    fetchUrl.protocol = 'https:';

    // 2. 深度伪装请求头
    const newHeaders = new Headers(request.headers);
    // 告诉目标服务器：我就是直接访问你的
    newHeaders.set('Host', targetDomain);
    newHeaders.set('Origin', `https://${targetDomain}`);
    newHeaders.set('Referer', `https://${targetDomain}${originalUrl.pathname}`);
    
    // 抹除 Cloudflare 代理的痕迹，防止被目标网站的防火墙拦截
    newHeaders.delete('CF-Connecting-IP');
    newHeaders.delete('CF-Ray');
    newHeaders.delete('X-Forwarded-For');
    newHeaders.delete('X-Real-IP');

    // 3. 发起请求 (拦截重定向)
    const response = await fetch(new Request(fetchUrl, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      redirect: 'manual' // 核心：自己处理跳转，防止露馅
    }));

    // 4. 处理返回的数据
    const responseHeaders = new Headers(response.headers);
    
    // 解决跨域问题 (CORS)
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    
    // 核心：如果目标网站发生重定向，把它的域名替换回你自己的自定义域
    const location = responseHeaders.get('Location');
    if (location) {
      responseHeaders.set(
        'Location', 
        location.replace(`https://${targetDomain}`, `https://${originalUrl.hostname}`)
      );
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  }
}
