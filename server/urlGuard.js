// A6（第二轮重审查）：SSRF + 密钥外带防护。
//
// 攻击链（报告 §5-1）：本应用无鉴权，任何能改 base_url 的来源（本机恶意进程 / 浏览器
// DNS rebinding）都能让服务端携带 `Authorization: Bearer <真key>` 去请求任意 URL
//（PUT /api/settings 后的 scheduleRefresh 与 /api/settings/test 均会外带）。
// 本模块提供两道闸：
//   1. base_url 出网校验：只允许公网 http(s) 地址，拒绝回环/私网/链路本地段
//      （测试与本地开发可用 NOVEL_ALLOW_PRIVATE_BASE_URL=1 显式放行）；
//   2. 请求来源校验：浏览器发起的请求必带 Origin/Host，二者必须指向本机，
//      堵住 DNS rebinding 把恶意域名解析到 127.0.0.1 的路径。
const DEFAULT_ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function allowPrivateOverride() {
  return process.env.NOVEL_ALLOW_PRIVATE_BASE_URL === '1';
}

// 主机名是否属于回环/私网/链路本地等“非公网”段（IPv4 点分 / IPv6 / 假想内网后缀）
function isPrivateHostname(hostname) {
  if (!hostname) return true;
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (DEFAULT_ALLOWED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  // IPv4（含 IPv4-mapped IPv6 ::ffff:1.2.3.4）
  const m = host.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;                      // 0/8、10/8、127/8
    if (a === 172 && b >= 16 && b <= 31) return true;                       // 172.16/12
    if (a === 192 && b === 168) return true;                                // 192.168/16
    if (a === 169 && b === 254) return true;                                // 169.254/16 链路本地
    if (a === 100 && b >= 64 && b <= 127) return true;                      // 100.64/10 CGNAT
  }
  return false;
}

// 校验 base_url：仅允许 http(s) 且主机为公网地址。违规抛错（消息可直接回给前端）。
function assertPublicBaseUrl(url, { label = 'base_url' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} 只允许 http/https 协议`);
  }
  if (isPrivateHostname(parsed.hostname) && !allowPrivateOverride()) {
    throw new Error(
      `${label} 指向回环/私网地址（${parsed.hostname}），已拒绝：服务端会携带 API Key 请求该地址，` +
      '可能造成密钥外带。如为本地测试，请设环境变量 NOVEL_ALLOW_PRIVATE_BASE_URL=1 后重启。'
    );
  }
  return parsed;
}

// 从 Host/Origin 头提取主机名（剥离端口与方括号）
function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  return String(hostHeader).toLowerCase().replace(/^\[|\]$/g, '').split(':')[0].replace(/^.*@/, '');
}

function extraAllowedHosts() {
  return new Set(String(process.env.NOVEL_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

// Host 头校验（DNS rebinding 防线）：无 Host 或指向本机（或 NOVEL_ALLOWED_HOSTS 白名单）才放行
function isAllowedHost(hostHeader) {
  if (!hostHeader) return true; // 非浏览器客户端（curl/测试）可不带
  const host = hostnameOf(hostHeader);
  if (!host) return true;
  if (DEFAULT_ALLOWED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  return extraAllowedHosts().has(host);
}

// Origin 头校验：非浏览器请求（无 Origin）放行；有 Origin 则必须指向本机或白名单
function isAllowedOrigin(originHeader, hostHeader) {
  if (!originHeader) return true;
  if (originHeader === 'null') return false; // sandboxed iframe / file:// —— 一律拒绝
  try {
    const o = new URL(String(originHeader));
    const host = hostnameOf(o.host);
    if (DEFAULT_ALLOWED_HOSTNAMES.has(host)) return true;
    if (extraAllowedHosts().has(host)) return true;
    // Origin 与本次请求 Host 同源也放行（例如通过 NOVEL_ALLOWED_HOSTS 配置的局域网域名访问）
    if (hostHeader && host === hostnameOf(hostHeader)) return true;
    return false;
  } catch {
    return false;
  }
}

module.exports = { isPrivateHostname, assertPublicBaseUrl, isAllowedHost, isAllowedOrigin, hostnameOf };
