// Fetch 标准端口阻断：https://fetch.spec.whatwg.org/#port-blocking
// 跳过全部低端口及标准禁止的高端口；每次重试先关闭本轮监听器。
const FETCH_BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

function listen(app, attempt = 0) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (address.port < 1024 || FETCH_BLOCKED_PORTS.has(address.port)) {
        server.close(error => {
          if (error) return reject(error);
          if (attempt >= 31) return reject(new Error('测试监听端口连续落入 Fetch 禁止范围'));
          listen(app, attempt + 1).then(resolve, reject);
        });
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

async function json(baseUrl, method, pathname, body) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

module.exports = { listen, json };
