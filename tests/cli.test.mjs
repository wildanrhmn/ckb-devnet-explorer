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

function run(args) {
  const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // A test that expects failure does not wait for ready.
  ready.catch(() => {});
  return { child, closed, ready };
}

test('integration-info is a public offline contract and does not require offckb', () => {
  const result = spawnSync(process.execPath, [bin, '--integration-info'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.apiVersion, 1);
  for (const name of ['host', 'system-scripts', 'bridge', 'json-ready']) assert.ok(info.capabilities.includes(name));
});

test('public serve options consume scripts without PATH and bind loopback with one ready record', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const scripts = path.join(root, 'scripts.json');
  fs.writeFileSync(scripts, JSON.stringify({ devnet: {} }));
  const rpc = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const result = (call) => ({ jsonrpc: '2.0', id: call.id, result: call.method === 'get_block_by_number' ? null : '0x0' });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(body) ? body.map(result) : result(body)));
  });
  await new Promise((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${rpc.address().port}`;
  const app = run(['serve', '--system-scripts', scripts, '--rpc', url, '--project', root, '--port', '0', '--json']);
  try {
    const ready = await app.ready;
    assert.equal(ready.apiVersion, 1);
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(ready.url)).status, 200);
    assert.equal((await (await fetch(ready.url + '/api/info')).json()).rpcUrl, url);
  } finally {
    app.child.kill('SIGTERM');
    const exit = await app.closed;
    if (process.platform !== 'win32') assert.equal(exit.code, 143);
    assert.equal(exit.stdout.trim().split('\n').length, 1);
    rpc.closeAllConnections(); rpc.close(); fs.rmSync(root, { recursive: true, force: true });
  }
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
  const scripts = path.join(root, 'scripts.json'); fs.writeFileSync(scripts, '{}');
  const taken = net.createServer(); await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  try {
    const app = run(['serve', '--system-scripts', scripts, '--port', String(taken.address().port), '--json']);
    const result = await app.closed;
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /EADDRINUSE/);
  } finally { taken.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('bridge serves HTTP on outbound connections and closes them on shutdown', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const scripts = path.join(root, 'scripts.json'); fs.writeFileSync(scripts, '{}');
  const sockets = new Set();
  const bridge = net.createServer((socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const socketPath = path.join(root, 'bridge.sock'); await new Promise((resolve) => bridge.listen(socketPath, resolve));
  const app = run(['serve', '--system-scripts', scripts, '--bridge', socketPath, '--json']);
  try {
    assert.equal((await app.ready).transport, 'bridge');
    const socket = sockets.values().next().value;
    const response = new Promise((resolve) => { let data = ''; socket.on('data', (value) => { data += value; }); socket.once('end', () => resolve(data)); });
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(await response, /^HTTP\/1\.1 200/);
  } finally {
    app.child.kill('SIGTERM'); const result = await app.closed; assert.equal(result.code, 143);
    for (const socket of sockets) socket.destroy(); bridge.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unavailable bridge fails with no ready record', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const scripts = path.join(root, 'scripts.json'); fs.writeFileSync(scripts, '{}');
  try {
    const app = run(['serve', '--system-scripts', scripts, '--bridge', path.join(root, 'missing.sock'), '--json']);
    const result = await app.closed;
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /BRIDGE_UNAVAILABLE/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
