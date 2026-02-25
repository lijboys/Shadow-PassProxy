//反代pages域名
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 直接读取你在网页版设置的环境变量 url
    url.hostname = env.url; 
    return fetch(new Request(url, request));
  }
}
