export default {
  async fetch(request, env) {
    try {
      const targetStr = env.URL; // 推荐使用大写环境变量
      if (!targetStr) {
        return errorResponse(500, "请在 Worker 变量中设置 URL（目标站点）");
      }

      // 智能解析目标（支持带路径的情况）
      const targetUrl = new URL(targetStr.startsWith('http') ? targetStr : `https://${targetStr}`);
      const targetDomain = targetUrl.hostname;
      const targetBasePath = targetUrl.pathname === '/' ? '' : targetUrl.pathname;

      const url = new URL(request.url);
      url.hostname = targetDomain;
      url.protocol = 'https:';
      // 如果目标有子路径，自动拼接（保持兼容）
      if (targetBasePath && !url.pathname.startsWith(targetBasePath)) {
        url.pathname = targetBasePath + url.pathname;
      }

      // ==================== 请求头深度伪装 ====================
      const newHeaders = new Headers(request.headers);
      newHeaders.set('Host', targetDomain);
      newHeaders.set('Origin', `https://${targetDomain}`);
      newHeaders.set('Referer', `https://${targetDomain}${url.pathname}${url.search}`);
      
      // 传递真实 IP（很多网站依赖此防作弊）
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
      // 跨域
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');

      // 安全头清理
      ['content-security-policy', 'x-frame-options', 'clear-site-data', 'x-content-security-policy'].forEach(h => {
        responseHeaders.delete(h);
      });

      // 重写 Location
      rewriteLocation(responseHeaders, targetDomain, new URL(request.url).origin);

      // 重写 Set-Cookie（支持多个）
      rewriteSetCookie(responseHeaders, targetDomain, request.url);

      // ==================== 内容重写（核心升级）===================
      let body = response.body;
      const contentType = responseHeaders.get('content-type') || '';

      if (contentType.includes('text/html')) {
        // 使用 HTMLRewriter 流式重写所有绝对 URL
        body = new HTMLRewriter()
          .on('a[href], link[href], script[src], img[src], source[src], iframe[src], form[action]', {
            element(element) {
              const attr = element.getAttribute('href') || element.getAttribute('src') || element.getAttribute('action');
              if (!attr) return;
              if (attr.startsWith('http') || attr.startsWith('//')) {
                const newUrl = attr.replace(new RegExp(`(https?:)?//${targetDomain}`, 'gi'), new URL(request.url).origin);
                if (attr.startsWith('http') || attr.startsWith('//')) {
                  element.setAttribute(element.getAttribute('href') ? 'href' : 'src', newUrl);
                }
              }
            }
          })
          .transform(response.body);
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
    // 同时清除 Secure 和 SameSite 限制（防止 Cookie 无法设置）
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
