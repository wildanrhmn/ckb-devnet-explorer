import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/ckb-devnet-explorer.js', import.meta.url));
const env = { ...process.env, PATH: '', NODE_USE_ENV_PROXY: '0' };
const genesis = `0x${'11'.repeat(32)}`;

function run(args, environment = {}) {
  const child = spawn(process.execPath, [bin, ...args], { env: { ...env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (value) => { stdout += value; });
  child.stderr.on('data', (value) => { stderr += value; });
  const closed = new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr })));
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (value) => {
      buffer += value;
      if (buffer.includes('\n')) {
        try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
    child.once('close', () => reject(new Error(stderr || 'Exited before ready')));
  });
  ready.catch(() => {});
  return { child, closed, ready };
}

async function startRpc() {
  let firstGenesis = true;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const result = (call) => {
      if (call.method === 'get_block_hash') return genesis;
      if (call.method === 'get_header_by_number' && call.params[0] === '0x0') return { number: '0x0', hash: genesis, timestamp: '0x0' };
      if (call.method === 'get_block_by_number') {
        if (call.params[0] === '0x0' && firstGenesis) {
          firstGenesis = false;
          return { header: { number: '0x0', hash: genesis }, transactions: [] };
        }
        return null;
      }
      if (call.method === 'get_blockchain_info') return { chain: 'ckb_dev', difficulty: '0x1' };
      return '0x0';
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(Array.isArray(body) ? body.map((call) => ({ jsonrpc: '2.0', id: call.id, result: result(call) })) : { jsonrpc: '2.0', id: body.id, result: result(body) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

function scriptsFile(root) {
  const file = path.join(root, 'scripts.json');
  fs.writeFileSync(file, JSON.stringify({ devnet: {} }));
  return file;
}

function bridgeFile(root, config) {
  const file = path.join(root, 'bridge.json');
  fs.writeFileSync(file, JSON.stringify({ apiVersion: 1, ...config }));
  return file;
}

async function startRelay(token, { fragmentedAck = false, piggybackRequest = false } = {}) {
  const authenticated = [];
  const sockets = new Set();
  let resolvePiggyback, rejectPiggyback;
  const piggyback = new Promise((resolve, reject) => { resolvePiggyback = resolve; rejectPiggyback = reject; });
  piggyback.catch(() => {});
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let received = '';
    const authenticate = (chunk) => {
      received += chunk.toString();
      if (!received.includes('\n')) return;
      socket.removeListener('data', authenticate);
      assert.equal(received, `offckb-http/1 ${token}\n`);
      authenticated.push(socket);
      if (piggybackRequest && authenticated.length === 1) {
        let raw = '';
        socket.on('data', (value) => {
          raw += value.toString();
          if (raw.includes('\r\n0\r\n\r\n')) { socket.destroy(); resolvePiggyback(raw); }
        });
        socket.once('end', () => resolvePiggyback(raw));
        socket.once('error', rejectPiggyback);
        const request = 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n';
        if (fragmentedAck) {
          socket.write('O');
          setImmediate(() => socket.write(`K\n${request}`));
        } else socket.write(`OK\n${request}`);
        return;
      }
      if (fragmentedAck) {
        socket.write('O');
        setImmediate(() => socket.write('K\n'));
      } else socket.write('OK\n');
    };
    socket.on('data', authenticate);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const used = new Set();
  return {
    port: server.address().port,
    piggyback,
    async request(pathname, { method = 'GET', body = '' } = {}) {
      const socket = authenticated.find((candidate) => !used.has(candidate) && !candidate.destroyed && !candidate.readableEnded && !candidate.writableEnded);
      assert.ok(socket, 'an authenticated reverse channel is available');
      used.add(socket);
      const response = new Promise((resolve, reject) => {
        let raw = '';
        socket.on('data', (value) => {
          raw += value.toString();
          if (raw.includes('\r\n0\r\n\r\n')) { socket.destroy(); resolve(raw); }
        });
        socket.once('end', () => resolve(raw));
        socket.once('error', reject);
        setTimeout(() => reject(new Error('relay request timed out')), 5000).unref();
      });
      socket.write(`${method} ${pathname} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      const raw = await response;
      const split = raw.indexOf('\r\n\r\n');
      assert.ok(split >= 0, raw);
      const headers = raw.slice(0, split);
      let payload = raw.slice(split + 4);
      if (/transfer-encoding: chunked/i.test(headers)) {
        let decoded = '';
        while (payload) {
          const end = payload.indexOf('\r\n');
          const size = Number.parseInt(payload.slice(0, end), 16);
          if (!size) break;
          decoded += payload.slice(end + 2, end + 2 + size);
          payload = payload.slice(end + 4 + size);
        }
        payload = decoded;
      }
      return { status: Number(headers.match(/^HTTP\/1\.1 (\d+)/)?.[1]), body: payload };
    },
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

async function stop(app, code = 143) {
  app.child.kill('SIGTERM');
  const result = await app.closed;
  if (process.platform !== 'win32') assert.equal(result.code, code, result.stderr);
  return result;
}

test('integration-info is a public offline contract and does not require offckb', () => {
  const result = spawnSync(process.execPath, [bin, '--integration-info'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.apiVersion, 1);
  for (const name of ['host', 'system-scripts', 'bridge', 'json-ready', 'read-only', 'genesis-check', 'address-prefix', 'rpc-queue']) assert.ok(info.capabilities.includes(name));
});

test('public serve options consume scripts without PATH, verify genesis and bind loopback', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const rpc = await startRpc();
  const app = run(['serve', '--system-scripts', scriptsFile(root), '--rpc', rpc.url, '--project', root, '--port', '0', '--expected-genesis', genesis, '--address-prefix', 'ckt', '--json']);
  try {
    const ready = await app.ready;
    assert.equal(ready.apiVersion, 1);
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(ready.url)).status, 200);
    const info = await (await fetch(ready.url + '/api/info')).json();
    assert.equal(info.rpcUrl, rpc.url);
    assert.equal(info.features.downloads, true);
    assert.equal((await stop(app)).stdout.trim().split('\n').length, 1);
  } finally {
    app.child.kill('SIGKILL'); rpc.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a genesis mismatch fails before readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const rpc = await startRpc();
  try {
    const app = run(['serve', '--system-scripts', scriptsFile(root), '--rpc', rpc.url, '--expected-genesis', `0x${'22'.repeat(32)}`, '--json']);
    const result = await app.closed;
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /genesis mismatch/i);
  } finally { rpc.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid explicit scripts fail without falling back to offckb on PATH', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const scripts = path.join(root, 'scripts.json'); fs.writeFileSync(scripts, '{invalid');
  try {
    const app = run(['serve', '--system-scripts', scripts, '--json']);
    const result = await app.closed;
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /isn't on your PATH/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('port conflicts fail on stderr without a ready record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const scripts = scriptsFile(root);
  const taken = net.createServer(); await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  try {
    const app = run(['serve', '--system-scripts', scripts, '--port', String(taken.address().port), '--json']);
    const result = await app.closed;
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /EADDRINUSE/);
  } finally { taken.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('tcp-v1 authenticates before ready, serves read-only HTTP and reconnects', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const token = 'tcp-test-token';
  const relay = await startRelay(token, { fragmentedAck: true, piggybackRequest: true });
  const rpc = await startRpc();
  const config = bridgeFile(root, { transport: 'tcp-v1', endpoint: `127.0.0.1:${relay.port}`, token, url: 'http://127.0.0.1:7070' });
  const app = run(['serve', '--system-scripts', scriptsFile(root), '--rpc', rpc.url, '--project', root, '--bridge', config, '--json']);
  try {
    const ready = await app.ready;
    assert.deepEqual(ready, { ok: true, apiVersion: 1, url: 'http://127.0.0.1:7070', transport: 'tcp-v1' });
    assert.match(await relay.piggyback, /^HTTP\/1\.1 200/);
    assert.equal((await relay.request('/')).status, 200);
    const info = JSON.parse((await relay.request('/api/info')).body);
    assert.equal(info.features.faucet, false);
    assert.equal(info.features.broadcast, false);
    assert.equal(info.features.downloads, false);
    const write = await relay.request('/api/faucet', { method: 'POST', body: '{}' });
    assert.equal(write.status, 403);
    await stop(app);
  } finally {
    app.child.kill('SIGKILL'); relay.close(); rpc.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('proxy-connect-v1 uses proxy credentials and the authenticated relay protocol', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const token = 'proxy-test-token';
  const relay = await startRelay(token);
  const endpoint = `127.0.0.1:${relay.port}`;
  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    seen.push({ path: req.url, authorization: req.headers['proxy-authorization'] });
    const upstream = net.connect(relay.port, '127.0.0.1');
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const rpc = await startRpc();
  const config = bridgeFile(root, { transport: 'proxy-connect-v1', endpoint, token, url: 'http://127.0.0.1:7070' });
  const proxyUrl = `http://user:pass@127.0.0.1:${proxy.address().port}`;
  const app = run(['serve', '--system-scripts', scriptsFile(root), '--rpc', rpc.url, '--bridge', config, '--json'], { HTTP_PROXY: proxyUrl });
  try {
    assert.equal((await app.ready).transport, 'proxy-connect-v1');
    assert.equal((await relay.request('/')).status, 200);
    const style = await relay.request('/style.css');
    assert.equal(style.status, 200);
    assert.ok(style.body.length > 40000);
    assert.match(style.body, /animation: none !important/);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((call) => call.path === endpoint));
    assert.ok(seen.every((call) => call.authorization === `Basic ${Buffer.from('user:pass').toString('base64')}`));
    await stop(app);
  } finally {
    app.child.kill('SIGKILL'); relay.close(); rpc.close(); proxy.closeAllConnections(); proxy.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unavailable authenticated bridge fails with no ready record', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const available = net.createServer(); await new Promise((resolve) => available.listen(0, '127.0.0.1', resolve));
  const port = available.address().port;
  await new Promise((resolve) => available.close(resolve));
  const config = bridgeFile(root, { transport: 'tcp-v1', endpoint: `127.0.0.1:${port}`, token: 'unused' });
  try {
    const app = run(['serve', '--system-scripts', scriptsFile(root), '--bridge', config, '--json']);
    const result = await app.closed;
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /BRIDGE_UNAVAILABLE/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
