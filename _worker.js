export default {
  async fetch(request, env) {
    try {
      const targetStr = env.URL;
      if (!targetStr) {
        return errorResponse(500, "请在 Worker 变量中设置 URL（目标站点）");
      }

      // 智能解析目标（支持带路径）
      const targetUrl = new URL(targetStr.startsWith('http') ? targetStr : `https://${targetStr}`);
      const targetDomain = targetUrl.hostname;
      const targetBasePath = targetUrl.pathname === '/' ? '' : targetUrl.pathname;

      const url = new URL(request.url);
      url.hostname = targetDomain;
      url.protocol = 'https:';
      if (targetBasePath && !url.pathname.startsWith(targetBasePath)) {
        url.pathname = targetBasePath + url.pathname;
      }

      // ==================== 请求头深度伪装 ====================
      const newHeaders = new Headers(request.headers);
      newHeaders.set('Host', targetDomain);
      newHeaders.set('Origin', `https://${targetDomain}`);
      newHeaders.set('Referer', `https://${targetDomain}${url.pathname}${url.search}`);

      if (request.headers.get('cf-connecting-ip')) {
        newHeaders.set('X-Forwarded-For', request.headers.get('cf-connecting-ip'));
      }

      // WebSocket 直通
      if (newHeaders.get('Upgrade')?.toLowerCase() === 'websocket') {
        return fetch(url.toString(), { headers: newHeaders, redirect: 'manual' });
      }

      const init = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual',
        body: !['GET', 'HEAD'].includes(request.method) ? request.body : null,
      };

      const response = await fetch(url.toString(), init);
      const responseHeaders = new Headers(response.headers);

      // ==================== 响应头处理 ====================
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');

      // 清理安全头
      ['content-security-policy', 'x-frame-options', 'clear-site-data', 'x-content-security-policy'].forEach(h => {
        responseHeaders.delete(h);
      });

      // 重写 Location
      rewriteLocation(responseHeaders, targetDomain, new URL(request.url).origin);

      // 重写 Set-Cookie（支持多个）
      rewriteSetCookie(responseHeaders, targetDomain, request.url);

      // ==================== 内容重写（已修复）===================
      let body = response.body;
      const contentType = responseHeaders.get('content-type') || '';

      if (contentType.includes('text/html')) {
        const transformed = new HTMLRewriter()
          .on('a[href], link[href], script[src], img[src], source[src], iframe[src], form[action]', {
            element(element) {
              const attrs = ['href', 'src', 'action'];
              for (const attrName of attrs) {
                let attr = element.getAttribute(attrName);
                if (!attr) continue;

                // 只重写 http/https 和 // 开头的绝对链接
                if (attr.startsWith('http') || attr.startsWith('//')) {
                  const newUrl = attr.replace(
                    new RegExp(`(https?:)?//${targetDomain}`, 'gi'),
                    new URL(request.url).origin
                  );
                  element.setAttribute(attrName, newUrl);
                  break; // 一个元素只处理一个属性
                }
              }
            }
          })
          .transform(response);   // ← 关键修复：传入 response 而不是 response.body

        body = transformed.body;
      }

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

    } catch (err) {
      return errorResponse(500, `反代出错: ${err.message}\n${err.stack}`);
    }
  }
};

// ====================== 辅助函数 ======================
function rewriteLocation(headers, oldDomain, newOrigin) {
  const location = headers.get('location');
  if (location) {
    headers.set('location', location.replace(new RegExp(`(https?:)?//${oldDomain}`, 'gi'), newOrigin));
  }
}

function rewriteSetCookie(headers, oldDomain, requestUrl) {
  const cookies = headers.getAll ? headers.getAll('set-cookie') : [headers.get('set-cookie')].filter(Boolean);
  headers.delete('set-cookie');

  const origin = new URL(requestUrl).origin;
  for (const cookie of cookies) {
    let newCookie = cookie.replace(new RegExp(`(domain=)?${oldDomain}`, 'gi'), `domain=${origin.replace('https://', '')}`);
    newCookie = newCookie.replace(/;\s*secure/gi, '').replace(/;\s*samesite=[^;]*/gi, '');
    headers.append('set-cookie', newCookie);
  }
}

function errorResponse(status, message) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Proxy-Error': 'true'
    }
  });
}
