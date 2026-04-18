<?php
/**
 * 简易 PHP 反向代理（适合虚拟主机）
 * 功能：
 * - 转发 HTTP 请求
 * - 伪装 Host / Origin / Referer
 * - 支持目标带路径
 * - 支持 Location 重写
 * - 支持 Set-Cookie 重写
 * - 支持 HTML 内常见标签链接重写
 * - 兼容部分虚拟主机环境
 *
 * 要求：
 * - PHP 7.4+
 * - cURL 扩展
 */

// ========================== 配置区 ==========================
$CONFIG = [
    // 目标站点，可带路径，例如：https://example.com 或 https://example.com/blog
    'target' => 'https://example.com',

    // 是否允许跨域
    'enable_cors' => true,

    // 是否删除部分安全头（部分站点嵌套/显示需要）
    'strip_security_headers' => true,

    // 超时时间
    'timeout' => 60,

    // 是否校验证书
    'verify_ssl' => true,

    // 是否重写 HTML 内容
    'rewrite_html' => true,

    // 是否移除响应压缩头（建议 true，避免内容被修改后长度不一致）
    'remove_content_encoding' => true,
];

// ========================== 兼容函数 ==========================
if (!function_exists('getallheaders')) {
    function getallheaders() {
        $headers = [];
        foreach ($_SERVER as $name => $value) {
            if (strpos($name, 'HTTP_') === 0) {
                $key = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))));
                $headers[$key] = $value;
            }
        }

        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['Content-Type'] = $_SERVER['CONTENT_TYPE'];
        }
        if (isset($_SERVER['CONTENT_LENGTH'])) {
            $headers['Content-Length'] = $_SERVER['CONTENT_LENGTH'];
        }

        return $headers;
    }
}

function proxy_error($status, $message) {
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Proxy-Error: true');
    echo $message;
    exit;
}

function is_https() {
    if (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if (isset($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443) {
        return true;
    }
    if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') {
        return true;
    }
    return false;
}

function current_origin() {
    $scheme = is_https() ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host;
}

function current_host() {
    return $_SERVER['HTTP_HOST'] ?? 'localhost';
}

function starts_with($haystack, $needle) {
    return substr($haystack, 0, strlen($needle)) === $needle;
}

function parse_target($target) {
    if (!preg_match('#^https?://#i', $target)) {
        $target = 'https://' . $target;
    }

    $parts = parse_url($target);
    if (!$parts || empty($parts['host'])) {
        proxy_error(500, '目标站点配置错误');
    }

    return [
        'raw'    => $target,
        'scheme' => $parts['scheme'] ?? 'https',
        'host'   => $parts['host'],
        'port'   => $parts['port'] ?? null,
        'path'   => isset($parts['path']) && $parts['path'] !== '/' ? rtrim($parts['path'], '/') : '',
        'query'  => $parts['query'] ?? '',
    ];
}

function build_target_url($targetInfo) {
    $requestUri = $_SERVER['REQUEST_URI'] ?? '/';
    $requestPath = $requestUri;

    if ($targetInfo['path'] && strpos($requestPath, $targetInfo['path']) !== 0) {
        $requestPath = $targetInfo['path'] . $requestPath;
    }

    $port = $targetInfo['port'] ? ':' . $targetInfo['port'] : '';
    return $targetInfo['scheme'] . '://' . $targetInfo['host'] . $port . $requestPath;
}

function normalize_header_name($name) {
    $parts = explode('-', str_replace('_', '-', strtolower($name)));
    $parts = array_map(function ($p) {
        return ucfirst($p);
    }, $parts);
    return implode('-', $parts);
}

function rewrite_absolute_url_to_proxy($url, $targetInfo, $proxyOrigin) {
    $targetHostPattern = preg_quote($targetInfo['host'], '#');
    $targetSchemePattern = preg_quote($targetInfo['scheme'], '#');
    $portPart = $targetInfo['port'] ? ':' . $targetInfo['port'] : '';
    $targetFullHostPattern = preg_quote($targetInfo['host'] . $portPart, '#');

    $url = preg_replace('#^' . $targetSchemePattern . '://' . $targetFullHostPattern . '#i', $proxyOrigin, $url);
    $url = preg_replace('#^//' . $targetFullHostPattern . '#i', preg_replace('#^https?:#i', '', $proxyOrigin), $url);

    return $url;
}

function rewrite_location($location, $targetInfo, $proxyOrigin) {
    if (!$location) return $location;

    // 绝对地址
    if (preg_match('#^https?://#i', $location) || starts_with($location, '//')) {
        return rewrite_absolute_url_to_proxy($location, $targetInfo, $proxyOrigin);
    }

    // 相对地址
    if (starts_with($location, '/')) {
        return $proxyOrigin . $location;
    }

    return $location;
}

function rewrite_set_cookie($cookie, $targetInfo) {
    $proxyHost = current_host();

    // 只改 domain 属性，不乱改 cookie 值
    $cookie = preg_replace(
        '/;\s*domain=' . preg_quote($targetInfo['host'], '/') . '/i',
        '; Domain=' . $proxyHost,
        $cookie
    );

    // 如果 domain 带前导点，也处理
    $cookie = preg_replace(
        '/;\s*domain=\.' . preg_quote($targetInfo['host'], '/') . '/i',
        '; Domain=' . $proxyHost,
        $cookie
    );

    // 如果你需要更宽松兼容，可以取消下面注释：
    // $cookie = preg_replace('/;\s*secure/i', '', $cookie);
    // $cookie = preg_replace('/;\s*samesite=[^;]*/i', '', $cookie);

    return $cookie;
}

function is_html_content_type($contentType) {
    return stripos($contentType, 'text/html') !== false;
}

function can_rewrite_attr_value($value, $targetInfo) {
    if ($value === '' || $value === null) return false;

    $host = preg_quote($targetInfo['host'], '#');
    $port = $targetInfo['port'] ? ':' . $targetInfo['port'] : '';
    $hostPort = preg_quote($targetInfo['host'] . $port, '#');

    if (preg_match('#^https?://' . $hostPort . '#i', $value)) return true;
    if (preg_match('#^//' . $hostPort . '#i', $value)) return true;

    return false;
}

function rewrite_html_body($html, $targetInfo, $proxyOrigin) {
    if (trim($html) === '') return $html;

    libxml_use_internal_errors(true);

    $encodingPrefix = '<?xml encoding="utf-8" ?>';
    $dom = new DOMDocument();

    if (!$dom->loadHTML($encodingPrefix . $html, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD)) {
        libxml_clear_errors();
        return $html;
    }

    $xpath = new DOMXPath($dom);
    $query = '//*[@href or @src or @action]';
    $nodes = $xpath->query($query);

    if ($nodes) {
        foreach ($nodes as $node) {
            foreach (['href', 'src', 'action'] as $attr) {
                if (!$node->hasAttribute($attr)) {
                    continue;
                }

                $value = $node->getAttribute($attr);
                if (!can_rewrite_attr_value($value, $targetInfo)) {
                    continue;
                }

                $node->setAttribute($attr, rewrite_absolute_url_to_proxy($value, $targetInfo, $proxyOrigin));
            }
        }
    }

    // 处理 meta refresh
    $metaNodes = $xpath->query('//meta[translate(@http-equiv,"REFSH","refsh")="refresh"]');
    if ($metaNodes) {
        foreach ($metaNodes as $meta) {
            $content = $meta->getAttribute('content');
            if ($content && preg_match('/url=(.+)$/i', $content, $m)) {
                $oldUrl = trim($m[1], " '\"");
                $newUrl = rewrite_location($oldUrl, $targetInfo, $proxyOrigin);
                $meta->setAttribute('content', str_replace($oldUrl, $newUrl, $content));
            }
        }
    }

    $result = $dom->saveHTML();
    $result = preg_replace('/^<\?xml.*?\?>/i', '', $result);

    libxml_clear_errors();
    return $result;
}

// ========================== 预处理 ==========================
if (empty($CONFIG['target'])) {
    proxy_error(500, '请先配置目标站点');
}

if (!function_exists('curl_init')) {
    proxy_error(500, '当前虚拟主机未启用 cURL 扩展');
}

$targetInfo = parse_target($CONFIG['target']);
$proxyOrigin = current_origin();
$targetUrl = build_target_url($targetInfo);
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$requestHeaders = getallheaders();

// OPTIONS 预检可直接响应
if ($method === 'OPTIONS') {
    if ($CONFIG['enable_cors']) {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: *');
        header('Access-Control-Max-Age: 86400');
    }
    http_response_code(204);
    exit;
}

// 虚拟主机纯 PHP 无法透明支持 WebSocket
if (!empty($requestHeaders['Upgrade']) && strtolower($requestHeaders['Upgrade']) === 'websocket') {
    proxy_error(501, '当前虚拟主机 PHP 方案不支持 WebSocket 透明代理');
}

// ========================== 构建请求 ==========================
$ch = curl_init();

curl_setopt($ch, CURLOPT_URL, $targetUrl);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 20);
curl_setopt($ch, CURLOPT_TIMEOUT, $CONFIG['timeout']);
curl_setopt($ch, CURLOPT_ENCODING, ''); // 自动解压 gzip/br/deflate（视环境支持）
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, $CONFIG['verify_ssl']);
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, $CONFIG['verify_ssl'] ? 2 : 0);

// 转发 body
if (!in_array($method, ['GET', 'HEAD'])) {
    $rawBody = file_get_contents('php://input');
    if ($rawBody !== false && $rawBody !== '') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    }
}

// 组装请求头
$forwardHeaders = [];
$skipHeaders = [
    'host',
    'content-length',
    'accept-encoding', // 让 curl 自己处理
    'connection',
];

foreach ($requestHeaders as $name => $value) {
    $lower = strtolower($name);
    if (in_array($lower, $skipHeaders, true)) {
        continue;
    }
    $forwardHeaders[] = normalize_header_name($name) . ': ' . $value;
}

// 伪装关键头
$targetHostWithPort = $targetInfo['host'] . ($targetInfo['port'] ? ':' . $targetInfo['port'] : '');
$targetPathForReferer = $_SERVER['REQUEST_URI'] ?? '/';
if ($targetInfo['path'] && strpos($targetPathForReferer, $targetInfo['path']) !== 0) {
    $targetPathForReferer = $targetInfo['path'] . $targetPathForReferer;
}

$forwardHeaders[] = 'Host: ' . $targetHostWithPort;
$forwardHeaders[] = 'Origin: ' . $targetInfo['scheme'] . '://' . $targetHostWithPort;
$forwardHeaders[] = 'Referer: ' . $targetInfo['scheme'] . '://' . $targetHostWithPort . $targetPathForReferer;

// 真实 IP
if (!empty($_SERVER['REMOTE_ADDR'])) {
    $forwardHeaders[] = 'X-Forwarded-For: ' . $_SERVER['REMOTE_ADDR'];
    $forwardHeaders[] = 'X-Real-IP: ' . $_SERVER['REMOTE_ADDR'];
}

$forwardHeaders[] = 'X-Forwarded-Proto: ' . (is_https() ? 'https' : 'http');
$forwardHeaders[] = 'X-Forwarded-Host: ' . current_host();

curl_setopt($ch, CURLOPT_HTTPHEADER, $forwardHeaders);

// HEAD 请求不取 body
if ($method === 'HEAD') {
    curl_setopt($ch, CURLOPT_NOBODY, true);
}

// ========================== 执行请求 ==========================
$response = curl_exec($ch);

if ($response === false) {
    $err = curl_error($ch);
    curl_close($ch);
    proxy_error(502, '反代请求失败：' . $err);
}

$httpCode   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

$rawHeader = substr($response, 0, $headerSize);
$body = substr($response, $headerSize);

// ========================== 解析响应头 ==========================
$responseHeaderLines = preg_split("/\r\n|\n|\r/", trim($rawHeader));
$responseHeaders = [];
$setCookies = [];

foreach ($responseHeaderLines as $line) {
    if ($line === '' || stripos($line, 'HTTP/') === 0) {
        continue;
    }

    $pos = strpos($line, ':');
    if ($pos === false) {
        continue;
    }

    $name = strtolower(trim(substr($line, 0, $pos)));
    $value = trim(substr($line, $pos + 1));

    if ($name === 'set-cookie') {
        $setCookies[] = $value;
        continue;
    }

    if (!isset($responseHeaders[$name])) {
        $responseHeaders[$name] = [];
    }
    $responseHeaders[$name][] = $value;
}

// ========================== 响应头处理 ==========================
http_response_code($httpCode);

if ($CONFIG['enable_cors']) {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: *');
}

if ($CONFIG['strip_security_headers']) {
    $removeHeaders = [
        'content-security-policy',
        'content-security-policy-report-only',
        'x-frame-options',
        'clear-site-data',
        'x-content-security-policy',
        'cross-origin-opener-policy',
        'cross-origin-embedder-policy',
        'cross-origin-resource-policy',
    ];

    foreach ($removeHeaders as $h) {
        unset($responseHeaders[$h]);
    }
}

// 如修改过 body，避免长度和压缩头不一致
if ($CONFIG['remove_content_encoding']) {
    unset($responseHeaders['content-encoding']);
    unset($responseHeaders['content-length']);
    unset($responseHeaders['transfer-encoding']);
}

// 处理 Location
if (!empty($responseHeaders['location'][0])) {
    $newLocation = rewrite_location($responseHeaders['location'][0], $targetInfo, $proxyOrigin);
    header('Location: ' . $newLocation, true);
    unset($responseHeaders['location']);
}

// 处理 Set-Cookie
foreach ($setCookies as $cookie) {
    $cookie = rewrite_set_cookie($cookie, $targetInfo);
    header('Set-Cookie: ' . $cookie, false);
}

// HTML 重写
$contentType = '';
if (!empty($responseHeaders['content-type'][0])) {
    $contentType = $responseHeaders['content-type'][0];
}

if ($CONFIG['rewrite_html'] && $method !== 'HEAD' && is_html_content_type($contentType)) {
    $body = rewrite_html_body($body, $targetInfo, $proxyOrigin);
}

// 不再透传某些容易冲突的头
$skipResponseHeaders = [
    'content-length',
    'transfer-encoding',
    'content-encoding',
    'set-cookie',
    'location',
];

foreach ($responseHeaders as $name => $values) {
    if (in_array($name, $skipResponseHeaders, true)) {
        continue;
    }

    foreach ($values as $value) {
        header(normalize_header_name($name) . ': ' . $value, false);
    }
}

// ========================== 输出内容 ==========================
echo $body;
