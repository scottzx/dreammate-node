import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  DEFAULT_SLIM_CONFIG,
  apply,
  inject,
  loadWsModule,
  name,
  rewriteFollowOpenPayload,
  slimFollowFrame,
  slimSessionEvent,
} from '../yima-shared-loopback.mjs';

function assertDshWireEventValid(event) {
  const allowedKeys = new Set(['type', 'seq', 'time', 'data', 'ignorable', 'surfaceOp', 'sourceEventSeqs']);
  for (const key of Object.keys(event)) {
    assert.ok(allowedKeys.has(key), `unexpected envelope key: ${key}`);
  }
  assert.equal(typeof event.type, 'string');
  assert.ok(Number.isSafeInteger(event.seq) && event.seq >= 0);
  if (event.type === 'request/header' && Array.isArray(event.data.header?.tools)) {
    assert.ok(event.data.header.tools.length > 0, 'request/header must omit empty tools');
  }
  if (event.type === 'tool/result' && event.data.error !== undefined) {
    assert.equal(event.data.message?.isError, true, 'tool/result error requires message.isError === true');
  }
}

test('ships the loader contract of the standalone profile adapter', () => {
  assert.equal(name, 'yima-shared-loopback');
  assert.deepEqual(inject, ['connection', 'webServer', 'typertGateway']);
  assert.equal(typeof apply, 'function');
});

test('refuses non-loopback hosts and invalid ports', () => {
  const ctx = {
    connection: { trustedHosts: [] },
    webServer: { protocol: 'http:', server: { emit() {} } },
    effect: (fn) => fn(),
  };
  assert.throws(() => apply(ctx, { host: '0.0.0.0', port: 3466 }), /loopback address/);
  assert.throws(() => apply(ctx, { host: '127.0.0.1', port: 0 }), /valid port/);
  assert.throws(() => apply(ctx, { host: '127.0.0.1', port: 70000 }), /valid port/);
});

test('rewriteFollowOpenPayload clamps session/follow window without mutating input', () => {
  const original = {
    args: {
      request: {
        address: { kind: 'session', sessionId: 'sess-1' },
        activate: true,
        assistantStream: true,
        maxMessages: 500,
        turnWindow: { minMessages: 50, minTurns: 2 },
      },
    },
  };
  const next = rewriteFollowOpenPayload(original, DEFAULT_SLIM_CONFIG);
  assert.deepEqual(Object.keys(next), ['args']);
  assert.equal(next.args.request.maxMessages, 24);
  assert.deepEqual(next.args.request.turnWindow, { minMessages: 12, minTurns: 1 });
  assert.equal(original.args.request.maxMessages, 500);
});

test('slimSessionEvent keeps user/assistant text blocks and trims tool payloads safely', () => {
  const userEv = Object.freeze({
    type: 'user/message',
    seq: 0,
    time: 1000,
    surfaceOp: 'append',
    data: Object.freeze({ role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] }),
  });
  assert.equal(slimSessionEvent(userEv), userEv);

  const assistantEv = Object.freeze({
    type: 'assistant/message',
    seq: 1,
    time: 1001,
    surfaceOp: 'append',
    data: Object.freeze({
      turn: 1,
      step: 1,
      message: Object.freeze({
        role: 'assistant',
        id: 'a1',
        content: [
          { type: 'reasoning', text: 'step by step' },
          { type: 'text', text: 'final answer' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"cat big"}' },
        ],
      }),
      stream: [{ type: 'chunk', text: 'x'.repeat(20_000) }],
    }),
  });
  const slimAssistant = slimSessionEvent(assistantEv);
  assertDshWireEventValid(slimAssistant);
  assert.deepEqual(slimAssistant.data.stream, []);
  assert.equal(slimAssistant.data.message.content[0].text, 'step by step');
  assert.equal(slimAssistant.data.message.content[1].text, 'final answer');
  assert.equal(slimAssistant.data.message.content[2].name, 'bash');
  assert.equal(slimAssistant.data.message.content[2].arguments, '{}');

  const attemptEv = {
    type: 'assistant/attempt',
    seq: 11,
    time: 1001,
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', payload: 'x'.repeat(50_000) }] },
  };
  const slimAttempt = slimSessionEvent(attemptEv);
  assert.deepEqual(slimAttempt.data.stream, []);

  const acpAssistantEv = {
    type: 'assistant/message',
    seq: 12,
    time: 1001,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', time: 1 }],
      message: {
        role: 'assistant',
        id: 'a2',
        content: [
          { type: 'text', text: 'visible reply' },
          {
            type: 'text',
            text: '',
            acpTool: {
              turn: 1,
              step: 1,
              tool: {
                toolCallId: 'call_1',
                name: 'Edit',
                title: 'Edit foo.js',
                status: 'completed',
                rawInput: { huge: 'x'.repeat(30_000) },
                rawOutput: { out: 'y'.repeat(30_000) },
                content: [{ type: 'text', text: 'z'.repeat(30_000) }],
              },
            },
          },
        ],
      },
    },
  };
  const slimAcp = slimSessionEvent(acpAssistantEv);
  assert.deepEqual(slimAcp.data.stream, []);
  assert.equal(slimAcp.data.message.content[0].text, 'visible reply');
  assert.equal(slimAcp.data.message.content[1].acpTool.tool.name, 'Edit');
  assert.equal(slimAcp.data.message.content[1].acpTool.tool.title, 'Edit foo.js');
  assert.deepEqual(slimAcp.data.message.content[1].acpTool.tool.rawInput, {});
  assert.deepEqual(slimAcp.data.message.content[1].acpTool.tool.rawOutput, {});
  assert.deepEqual(slimAcp.data.message.content[1].acpTool.tool.content, []);

  const callEv = {
    type: 'tool/call',
    seq: 2,
    time: 1002,
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"' + 'a'.repeat(5000) + '"}' },
  };
  const slimCall = slimSessionEvent(callEv);
  assertDshWireEventValid(slimCall);
  assert.equal(slimCall.data.name, 'bash');
  assert.equal(slimCall.data.arguments, '{}');

  const resultEv = {
    type: 'tool/result',
    seq: 3,
    time: 1003,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'c1',
        source: { callId: 'c1' },
        isError: false,
        content: [{ type: 'text', text: 'y'.repeat(50_000) }],
      },
      meta: { lines: ['a', 'b'] },
    },
  };
  const slimResult = slimSessionEvent(resultEv);
  assertDshWireEventValid(slimResult);
  assert.deepEqual(slimResult.data.message.content, []);
  assert.equal(Object.hasOwn(slimResult.data, 'meta'), false);

  const errorResultEv = {
    type: 'tool/result',
    seq: 4,
    time: 1004,
    surfaceOp: 'append',
    data: {
      error: { code: 'ERR', message: 'failed' },
      message: {
        role: 'tool',
        source: { callId: 'c2' },
        isError: true,
        content: [{ type: 'text', text: 'boom: ' + 'z'.repeat(400) }],
      },
    },
  };
  const slimError = slimSessionEvent(errorResultEv);
  assertDshWireEventValid(slimError);
  assert.equal(slimError.data.message.isError, true);
  assert.ok(slimError.data.message.content[0].text.length <= 241);

  const headerEv = {
    type: 'request/header',
    seq: 5,
    time: 1005,
    data: { header: { config: {}, tools: [{ name: 'bash' }] } },
  };
  const slimHeader = slimSessionEvent(headerEv);
  assertDshWireEventValid(slimHeader);
  assert.equal(Object.hasOwn(slimHeader.data.header, 'tools'), false);
});

test('slimFollowFrame keeps live text deltas and trims tool argument deltas', () => {
  const textDelta = {
    type: 'assistant-stream',
    frame: { revision: 1, type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'hi' } },
  };
  assert.equal(slimFollowFrame(textDelta), textDelta);

  const toolDelta = {
    type: 'assistant-stream',
    frame: {
      revision: 2,
      type: 'chunk',
      chunk: { type: 'tool-call-delta', index: 1, id: 'c1', name: 'edit_file', argumentsDelta: 'large payload' },
    },
  };
  const slimmed = slimFollowFrame(toolDelta);
  assert.equal(slimmed.frame.chunk.name, 'edit_file');
  assert.equal(slimmed.frame.chunk.argumentsDelta, '');
});

test('apply slims /api/remote.mux WS and /api/session/page HTTP, and respects slim: false', async (t) => {
  const wsMod = await loadWsModule();
  if (!wsMod) {
    t.skip('ws module unavailable in this environment');
    return;
  }
  const { WebSocket } = wsMod;

  const upstreamServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/session/page') {
      const body = Buffer.from(JSON.stringify({
        type: 'server-response',
        rpcId: 'rpc-1',
        result: {
          ok: true,
          value: {
            cursor: 1,
            hasMore: false,
            records: [
              { type: 'event', event: { type: 'tool/call', seq: 0, time: 1, data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"' + 'x'.repeat(5000) + '"}' } } },
              { type: 'event', event: { type: 'tool/result', seq: 1, time: 2, surfaceOp: 'append', data: { message: { role: 'tool', source: { callId: 'c1' }, content: [{ type: 'text', text: 'y'.repeat(10_000) }] }, meta: { lines: ['a'] } } } },
            ],
          },
        },
      }), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));

  let capturedOpen = null;
  const ctx = {
    logger: { info() {}, warn() {} },
    connection: {
      trustedHosts: [],
      admitConnection(req) {
        if (req.headers['x-reject']) return { rejection: 401 };
        return {
          peer: { id: 'p1', ctx: { effect: () => () => {} } },
          release: async () => {},
        };
      },
    },
    webServer: { protocol: 'http:', server: upstreamServer },
    typertGateway: {
      wireStream: {
        async open(endpoint, payload) {
          capturedOpen = { endpoint, payload };
          return (async function* () {
            yield {
              type: 'snapshot',
              cursor: 2,
              hasMore: true,
              records: [
                { type: 'event', event: { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } },
                { type: 'event', event: { type: 'tool/call', seq: 1, time: 2, data: { callId: 'c1', name: 'read_file', arguments: '{"path":"/a","junk":"' + 'z'.repeat(4000) + '"}' } } },
                { type: 'event', event: { type: 'tool/result', seq: 2, time: 3, surfaceOp: 'append', data: { message: { role: 'tool', source: { callId: 'c1' }, content: [{ type: 'text', text: 'huge'.repeat(5000) }] }, meta: { lines: ['l1'] } } } },
              ],
            };
          })();
        },
        failure(err) {
          return { code: 'gateway/internal', message: String(err), details: {} };
        },
      },
    },
    effect: (fn) => fn(),
  };

  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const dispose = await apply(ctx, { host: '127.0.0.1', port, logStats: false });
  try {
    assert.ok(ctx.connection.trustedHosts.includes(`127.0.0.1:${port}`));

    const pageRes = await fetch(`http://127.0.0.1:${port}/api/session/page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      body: '{}',
    });
    const pageJson = await pageRes.json();
    assert.equal(pageJson.result.value.records[0].event.data.arguments, '{}');
    assert.deepEqual(pageJson.result.value.records[1].event.data.message.content, []);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { perMessageDeflate: true });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const frames = [];
    const done = new Promise((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8'));
        frames.push(parsed);
        if (parsed.type === 'end') resolve();
      });
    });
    ws.send(JSON.stringify({
      type: 'open',
      streamId: 's1',
      endpoint: 'session/follow',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: 'sess-1' },
            maxMessages: 500,
            turnWindow: { minMessages: 50, minTurns: 2 },
          },
        },
      },
    }));
    await done;
    ws.close();

    assert.equal(capturedOpen.payload.args.request.maxMessages, 24);
    assert.deepEqual(capturedOpen.payload.args.request.turnWindow, { minMessages: 12, minTurns: 1 });
    const snap = frames[0].value;
    assert.equal(snap.records[0].event.data.content[0].text, 'hello');
    assert.equal(snap.records[1].event.data.name, 'read_file');
    assert.equal(snap.records[1].event.data.arguments, '{}');
    assert.deepEqual(snap.records[2].event.data.message.content, []);
    assert.equal(Object.hasOwn(snap.records[2].event.data, 'meta'), false);
  } finally {
    await dispose();
  }
  assert.equal(ctx.connection.trustedHosts.includes(`127.0.0.1:${port}`), false);

  const probe2 = createServer();
  await new Promise((resolve) => probe2.listen(0, '127.0.0.1', resolve));
  const port2 = probe2.address().port;
  await new Promise((resolve) => probe2.close(resolve));

  const disposePlain = await apply(ctx, { host: '127.0.0.1', port: port2, slim: false });
  try {
    const rawPage = await fetch(`http://127.0.0.1:${port2}/api/session/page`, { method: 'POST', body: '{}' });
    const rawJson = await rawPage.json();
    assert.ok(rawJson.result.value.records[0].event.data.arguments.length > 4000);
    assert.equal(rawJson.result.value.records[1].event.data.message.content[0].text.length, 10_000);
  } finally {
    await disposePlain();
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
});
