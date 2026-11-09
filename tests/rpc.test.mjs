import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { register } from 'tsx/esm/api';

register();
const { rpc, rpcBatch } = await import('../src/rpc.ts');

async function upstream(handler) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    await handler(JSON.parse(raw), res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

const reply = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('RPC scheduling keeps unbounded callers within the host concurrency limit', async () => {
  let active = 0, maximum = 0;
  const server = await upstream(async (body, res) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
    reply(res, { jsonrpc: '2.0', id: body.id, result: '0x1' });
  });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => rpc(server.url, 'get_tip_block_number')));
    assert.equal(results.length, 20);
    assert.ok(maximum <= 4, `maximum concurrent requests: ${maximum}`);
  } finally { server.close(); }
});

test('RPC retries transient gateway load responses with backoff', async () => {
  let calls = 0;
  const server = await upstream(async (body, res) => {
    calls++;
    if (calls < 3) return reply(res, { error: 'busy' }, 503);
    reply(res, { jsonrpc: '2.0', id: body.id, result: '0x2a' });
  });
  try {
    assert.equal(await rpc(server.url, 'get_tip_block_number'), '0x2a');
    assert.equal(calls, 3);
  } finally { server.close(); }
});

test('RPC batches are bounded and preserve result order', async () => {
  const sizes = [];
  const server = await upstream(async (body, res) => {
    sizes.push(body.length);
    reply(res, body.map((call) => ({ jsonrpc: '2.0', id: call.id, result: call.params[0] })));
  });
  try {
    const calls = Array.from({ length: 120 }, (_, i) => ['get_block_by_number', [i]]);
    const results = await rpcBatch(server.url, calls);
    assert.deepEqual(results, calls.map((call) => call[1][0]));
    assert.equal(sizes.length, 12);
    assert.ok(sizes.every((size) => size === 10));
  } finally { server.close(); }
});

test('RPC surfaces host string errors instead of reading undefined message fields', async () => {
  const server = await upstream(async (_body, res) => reply(res, { error: 'RPC method is not permitted' }, 403));
  try {
    await assert.rejects(rpc(server.url, 'send_transaction'), /403: RPC method is not permitted/);
  } finally { server.close(); }
});
