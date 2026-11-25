// Loader adapter shipped with the DreamMate DSH plugin; it keeps the contract
// of the standalone dsh-config profile extension of the same name.
//
// Fixed loopback entry for the desktop profile's own web server. Tailscale
// Serve proxies the phone and the browser to this port so requests share the
// desktop process's session writer instead of starting a second `dsh web`.
//
// When remote slimming is enabled (default), `/api/remote.mux` WebSocket streams
// (`session/follow`, `session/observeEvent`) and history paging endpoints
// (`POST /api/session/page`, `/api/session/events`) keep user and assistant
// message blocks intact while keeping only tool call names and omitting heavy
// tool outputs, `meta` dumps, redundant `assistant/message.data.stream` replay
// buffers, and `request/header.header.tools` schemas. The local Electron desktop
// UI does not traverse this loopback listener and stays 100% untouched.

import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

export const name = 'yima-shared-loopback';
export const inject = ['connection', 'webServer', 'typertGateway'];

const REMOTE_STREAM_MUX_PATH = '/api/remote.mux';
const SLIM_HTTP_PATHS = new Set(['/api/session/page', '/api/session/events']);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_MISSED_HEARTBEATS = 2;
const DEFAULT_STREAM_INBOX_BYTES = 262_144;
const DEFAULT_COMPRESSION_LEVEL = 6;
const COMPRESS_THRESHOLD_BYTES = 512;

export const DEFAULT_SLIM_CONFIG = Object.freeze({
  enabled: true,
  // Initial history budget for session/follow (DSH default: maxMessages=500, minMessages=50, minTurns=2).
  maxMessages: 24,
  minMessages: 12,
  minTurns: 1,
  // Strip tool call arguments so the UI displays only the tool name.
  stripToolArguments: true,
  // Omit tool/result output body & meta (keep error indicator when isError=true).
  omitToolResults: true,
  // Optional short placeholder text inside tool/result content; empty string yields content=[].
  toolResultPlaceholder: '',
  // Keep a short error summary when a tool failed (preserves validateSessionEventData invariant).
  keepToolError: true,
  maxToolErrorChars: 240,
  // Strip redundant data.stream replay chunks on settled assistant/message events.
  dropAssistantStream: true,
  // Remove request/header.data.header.tools schema list (~50 KB each).
  stripRequestHeaderTools: true,
  // Truncate oversized job labels/details.
  maxJobLabelChars: 160,
  // Drop compaction/summary rawOutput while keeping summary.
  dropCompactionRawOutput: true,
  // Slim live assistant-stream tool-call argument deltas (keeps text/reasoning deltas intact).
  slimLiveToolDeltas: true,
});

function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncateText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function resolveSlimConfig(raw) {
  if (raw === false) {
    return Object.freeze({ ...DEFAULT_SLIM_CONFIG, enabled: false });
  }
  const input = raw && typeof raw === 'object' ? raw : {};
  const enabled = input.enabled !== false;
  const maxMessages = positiveInt(input.maxMessages, DEFAULT_SLIM_CONFIG.maxMessages);
  const minMessages = Math.min(positiveInt(input.minMessages, DEFAULT_SLIM_CONFIG.minMessages), maxMessages);
  const minTurns = positiveInt(input.minTurns, DEFAULT_SLIM_CONFIG.minTurns);
  return Object.freeze({
    enabled,
    maxMessages,
    minMessages,
    minTurns,
    stripToolArguments: input.stripToolArguments !== false,
    omitToolResults: input.omitToolResults !== false,
    toolResultPlaceholder: typeof input.toolResultPlaceholder === 'string'
      ? input.toolResultPlaceholder
      : DEFAULT_SLIM_CONFIG.toolResultPlaceholder,
    keepToolError: input.keepToolError !== false,
    maxToolErrorChars: positiveInt(input.maxToolErrorChars, DEFAULT_SLIM_CONFIG.maxToolErrorChars),
    dropAssistantStream: input.dropAssistantStream !== false,
    stripRequestHeaderTools: input.stripRequestHeaderTools !== false,
    maxJobLabelChars: positiveInt(input.maxJobLabelChars, DEFAULT_SLIM_CONFIG.maxJobLabelChars),
    dropCompactionRawOutput: input.dropCompactionRawOutput !== false,
    slimLiveToolDeltas: input.slimLiveToolDeltas !== false,
  });
}

export function rewriteFollowOpenPayload(payload, config = DEFAULT_SLIM_CONFIG) {
  if (!isPlainObject(payload) || !isPlainObject(payload.args)) return payload;
  const req = payload.args.request;
  if (!isPlainObject(req)) return payload;

  const nextMax = typeof req.maxMessages === 'number' && Number.isSafeInteger(req.maxMessages) && req.maxMessages > 0
    ? Math.min(req.maxMessages, config.maxMessages)
    : config.maxMessages;

  let nextTurnWindow = req.turnWindow;
  if (isPlainObject(req.turnWindow)) {
    const rawMinMsg = Number.isSafeInteger(req.turnWindow.minMessages) && req.turnWindow.minMessages > 0
      ? Math.min(req.turnWindow.minMessages, config.minMessages, nextMax)
      : Math.min(config.minMessages, nextMax);
    const rawMinTurns = Number.isSafeInteger(req.turnWindow.minTurns) && req.turnWindow.minTurns > 0
      ? Math.min(req.turnWindow.minTurns, config.minTurns)
      : config.minTurns;
    nextTurnWindow = { minMessages: rawMinMsg, minTurns: rawMinTurns };
  } else if (req.turnWindow === undefined) {
    nextTurnWindow = { minMessages: Math.min(config.minMessages, nextMax), minTurns: config.minTurns };
  }

  return {
    args: {
      ...payload.args,
      request: {
        ...req,
        maxMessages: nextMax,
        turnWindow: nextTurnWindow,
      },
    },
  };
}

function extractFirstText(content) {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string' && block.text.trim()) {
      return block.text.trim();
    }
  }
  return '';
}

function slimAcpToolBlock(block, config) {
  if (!block || typeof block !== 'object' || !block.acpTool || typeof block.acpTool !== 'object') {
    return block;
  }
  const tool = block.acpTool.tool;
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return block;
  let changed = false;
  const nextTool = { ...tool };
  if (config.stripToolArguments && Object.hasOwn(nextTool, 'rawInput') && nextTool.rawInput !== undefined) {
    if (typeof nextTool.rawInput !== 'object' || nextTool.rawInput === null || Object.keys(nextTool.rawInput).length > 0) {
      nextTool.rawInput = {};
      changed = true;
    }
  }
  if (config.omitToolResults) {
    if (Object.hasOwn(nextTool, 'rawOutput') && nextTool.rawOutput !== undefined) {
      if (typeof nextTool.rawOutput !== 'object' || nextTool.rawOutput === null || Object.keys(nextTool.rawOutput).length > 0) {
        nextTool.rawOutput = {};
        changed = true;
      }
    }
    if (Array.isArray(nextTool.content) && nextTool.content.length > 0) {
      nextTool.content = [];
      changed = true;
    }
  }
  if (!changed) return block;
  return {
    ...block,
    acpTool: {
      ...block.acpTool,
      tool: nextTool,
    },
  };
}

export function slimSessionEvent(event, config = DEFAULT_SLIM_CONFIG) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return event;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return event;

  switch (event.type) {
    case 'user/message':
      return event;

    case 'assistant/attempt': {
      if (!config.dropAssistantStream || !Array.isArray(data.stream) || data.stream.length === 0) {
        return event;
      }
      // Keep an empty array (never omit) because dsh-client-ui-trajectory iterates event.data.stream.
      return { ...event, data: { ...data, stream: [] } };
    }

    case 'assistant/message': {
      let changed = false;
      let nextData = data;
      if (config.dropAssistantStream && Array.isArray(data.stream) && data.stream.length > 0) {
        // Keep an empty array (never omit) because dsh-client-ui-trajectory iterates event.data.stream.
        nextData = { ...nextData, stream: [] };
        changed = true;
      }
      if ((config.stripToolArguments || config.omitToolResults)
          && nextData.message && typeof nextData.message === 'object'
          && Array.isArray(nextData.message.content)) {
        let contentChanged = false;
        const nextContent = nextData.message.content.map((block) => {
          if (config.stripToolArguments && block && typeof block === 'object' && block.type === 'tool-call'
              && typeof block.arguments === 'string' && block.arguments !== '{}') {
            contentChanged = true;
            return { ...block, arguments: '{}' };
          }
          const slimAcp = slimAcpToolBlock(block, config);
          if (slimAcp !== block) {
            contentChanged = true;
            return slimAcp;
          }
          return block;
        });
        if (contentChanged) {
          nextData = { ...nextData, message: { ...nextData.message, content: nextContent } };
          changed = true;
        }
      }
      return changed ? { ...event, data: nextData } : event;
    }

    case 'tool/call': {
      if (!config.stripToolArguments || typeof data.arguments !== 'string' || data.arguments === '{}') {
        return event;
      }
      return { ...event, data: { ...data, arguments: '{}' } };
    }

    case 'tool/result': {
      if (!config.omitToolResults) return event;
      const message = data.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return event;

      const isError = message.isError === true || data.error !== undefined;
      let nextContent = [];
      if (isError && config.keepToolError) {
        const firstText = extractFirstText(message.content);
        const summary = firstText
          ? truncateText(firstText, config.maxToolErrorChars)
          : (typeof data.error?.message === 'string'
            ? truncateText(data.error.message, config.maxToolErrorChars)
            : '');
        if (summary) nextContent = [{ type: 'text', text: summary }];
      } else if (config.toolResultPlaceholder) {
        nextContent = [{ type: 'text', text: config.toolResultPlaceholder }];
      }

      const nextMessage = {
        ...message,
        content: nextContent,
        ...(data.error !== undefined ? { isError: true } : {}),
      };
      const { meta: _droppedMeta, ...restData } = data;
      return { ...event, data: { ...restData, message: nextMessage } };
    }

    case 'tool/ptc-dispatch-start':
    case 'tool/ptc-dispatch': {
      let changed = false;
      const nextData = { ...data };
      if (config.stripToolArguments && Object.hasOwn(nextData, 'arguments')) {
        nextData.arguments = {};
        changed = true;
      }
      if (config.omitToolResults) {
        if (Array.isArray(nextData.content) && nextData.content.length > 0) {
          nextData.content = [];
          changed = true;
        }
        if (Object.hasOwn(nextData, 'meta')) {
          delete nextData.meta;
          changed = true;
        }
      }
      return changed ? { ...event, data: nextData } : event;
    }

    case 'request/header': {
      if (!config.stripRequestHeaderTools) return event;
      const header = data.header;
      if (!header || typeof header !== 'object' || Array.isArray(header) || !Object.hasOwn(header, 'tools')) {
        return event;
      }
      // validateSessionEventData rejects an empty tools array; omit the key entirely.
      const { tools: _droppedTools, ...restHeader } = header;
      return { ...event, data: { ...data, header: restHeader } };
    }

    case 'job/registered':
    case 'job/settled': {
      let changed = false;
      const nextData = { ...data };
      if (typeof nextData.label === 'string' && nextData.label.length > config.maxJobLabelChars) {
        nextData.label = truncateText(nextData.label, config.maxJobLabelChars);
        changed = true;
      }
      if (typeof nextData.detail === 'string' && nextData.detail.length > config.maxJobLabelChars) {
        nextData.detail = truncateText(nextData.detail, config.maxJobLabelChars);
        changed = true;
      }
      return changed ? { ...event, data: nextData } : event;
    }

    case 'compaction/summary': {
      if (!config.dropCompactionRawOutput || !Object.hasOwn(data, 'rawOutput')) return event;
      const { rawOutput: _dropped, ...restData } = data;
      return { ...event, data: restData };
    }

    default:
      return event;
  }
}

function slimRecord(record, config) {
  if (!record || typeof record !== 'object' || record.type !== 'event' || !record.event) return record;
  const slimmed = slimSessionEvent(record.event, config);
  return slimmed === record.event ? record : { ...record, event: slimmed };
}

function slimLiveChunk(chunk, config) {
  if (!config.slimLiveToolDeltas || !chunk || typeof chunk !== 'object') return chunk;
  if (chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0) {
    return { ...chunk, argumentsDelta: '' };
  }
  if (chunk.type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
    if (chunk.block.type === 'tool-call' && typeof chunk.block.arguments === 'string'
        && chunk.block.arguments !== '{}') {
      return { ...chunk, block: { ...chunk.block, arguments: '{}' } };
    }
    const slimAcp = slimAcpToolBlock(chunk.block, config);
    if (slimAcp !== chunk.block) {
      return { ...chunk, block: slimAcp };
    }
  }
  return chunk;
}

function slimAssistantStreamRecord(record, config) {
  if (!record || typeof record !== 'object') return record;
  if (record.type === 'tool-call-chunks' && config.slimLiveToolDeltas && Array.isArray(record.args)) {
    const hasNonEmpty = record.args.some((a) => typeof a === 'string' && a.length > 0);
    if (hasNonEmpty) return { ...record, args: record.args.map(() => '') };
  }
  if (record.type === 'chunk' && record.chunk) {
    const nextChunk = slimLiveChunk(record.chunk, config);
    if (nextChunk !== record.chunk) return { ...record, chunk: nextChunk };
  }
  return record;
}

export function slimFollowFrame(frame, config = DEFAULT_SLIM_CONFIG) {
  if (!frame || typeof frame !== 'object') return frame;

  if (frame.type === 'snapshot' && Array.isArray(frame.records)) {
    let changed = false;
    const nextRecords = frame.records.map((rec) => {
      const next = slimRecord(rec, config);
      if (next !== rec) changed = true;
      return next;
    });
    let nextAssistantStream = frame.assistantStream;
    if (config.slimLiveToolDeltas && nextAssistantStream && typeof nextAssistantStream === 'object') {
      if (Array.isArray(nextAssistantStream.chunks) && nextAssistantStream.chunks.length > 0) {
        let chunksChanged = false;
        const nextChunks = nextAssistantStream.chunks.map((c) => {
          const next = slimLiveChunk(c, config);
          if (next !== c) chunksChanged = true;
          return next;
        });
        if (chunksChanged) {
          nextAssistantStream = { ...nextAssistantStream, chunks: nextChunks };
          changed = true;
        }
      }
      const aa = nextAssistantStream.activeAttempt;
      if (aa && typeof aa === 'object' && Array.isArray(aa.stream) && aa.stream.length > 0) {
        let streamChanged = false;
        const nextStream = aa.stream.map((rec) => {
          const next = slimAssistantStreamRecord(rec, config);
          if (next !== rec) streamChanged = true;
          return next;
        });
        if (streamChanged) {
          nextAssistantStream = { ...nextAssistantStream, activeAttempt: { ...aa, stream: nextStream } };
          changed = true;
        }
      }
    }
    if (!changed) return frame;
    return {
      ...frame,
      records: nextRecords,
      ...(frame.assistantStream !== undefined ? { assistantStream: nextAssistantStream } : {}),
    };
  }

  if (frame.type === 'event' && frame.event) {
    return slimRecord(frame, config);
  }

  if (frame.type === 'assistant-stream' && frame.frame && typeof frame.frame === 'object') {
    const inner = frame.frame;
    if (inner.type === 'chunk' && inner.chunk) {
      const nextChunk = slimLiveChunk(inner.chunk, config);
      if (nextChunk !== inner.chunk) {
        return { ...frame, frame: { ...inner, chunk: nextChunk } };
      }
    } else if (inner.type === 'chunks' && Array.isArray(inner.chunks)) {
      let changed = false;
      const nextChunks = inner.chunks.map((c) => {
        const next = slimLiveChunk(c, config);
        if (next !== c) changed = true;
        return next;
      });
      if (changed) {
        return { ...frame, frame: { ...inner, chunks: nextChunks } };
      }
    }
  }

  return frame;
}

export function slimRpcResponseBody(body, config = DEFAULT_SLIM_CONFIG) {
  if (!body || typeof body !== 'object') return { body, changed: false };
  const result = body.result;
  if (!result || typeof result !== 'object' || result.ok !== true || !result.value) {
    return { body, changed: false };
  }
  const page = result.value;
  if (typeof page !== 'object' || !Array.isArray(page.records)) {
    return { body, changed: false };
  }
  let changed = false;
  const nextRecords = page.records.map((rec) => {
    const next = slimRecord(rec, config);
    if (next !== rec) changed = true;
    return next;
  });
  if (!changed) return { body, changed: false };
  return {
    changed: true,
    body: { ...body, result: { ...result, value: { ...page, records: nextRecords } } },
  };
}

export async function loadWsModule() {
  try {
    const mod = await import('ws');
    const WebSocket = mod.WebSocket ?? mod.default;
    const WebSocketServer = mod.WebSocketServer ?? WebSocket?.Server;
    if (WebSocket && WebSocketServer) return { WebSocket, WebSocketServer };
  } catch {
    // Fall through to createRequire resolution.
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const basePaths = [
    // Installed inside <profile>/node_modules/@1agents/dreammate-node/vendor/dsh/
    join(here, '..', '..', '..', '..', '..', 'package.json'),
    // Standalone <profile>/local/ layout
    join(here, '..', 'package.json'),
    join(process.cwd(), 'package.json'),
    ...(process.env.DSH_INSTALL_DIR ? [join(process.env.DSH_INSTALL_DIR, 'package.json')] : []),
    join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json',
  ];

  for (const base of basePaths) {
    try {
      const req = createRequire(base);
      const mod = req('ws');
      const WebSocket = mod.WebSocket ?? mod;
      const WebSocketServer = mod.WebSocketServer ?? mod.Server;
      if (WebSocket && WebSocketServer) return { WebSocket, WebSocketServer };
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

function rejectUpgrade(socket, status) {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Conflict';
  const body = reason.toLowerCase();
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'));
}

class UplinkProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RemoteError';
    this.wireFailure = { code, message, details };
  }
}

class UplinkInbox {
  constructor(maxBytes, endpoint, onViolation) {
    this.maxBytes = maxBytes;
    this.endpoint = endpoint;
    this.onViolation = onViolation;
    this.queue = [];
    this.head = 0;
    this.bytes = 0;
    this.ended = false;
    this.closed = false;
    this.taken = false;
    this.failure = undefined;
    this.wake = undefined;
  }

  push(value, frameBytes) {
    if (this.failure !== undefined || this.closed) return;
    if (this.ended) {
      this.violate(new UplinkProtocolError(
        'gateway/protocol',
        'api gateway: Remote stream uplink item after end',
        { endpoint: this.endpoint },
      ));
      return;
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      this.violate(new UplinkProtocolError(
        'gateway/uplink-overflow',
        `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`,
        { endpoint: this.endpoint },
      ));
      return;
    }
    this.queue.push({ value, bytes: frameBytes });
    this.bytes += frameBytes;
    this.signal();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.signal();
  }

  fail(error) {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.queue.length = 0;
    this.head = 0;
    this.bytes = 0;
    this.signal();
  }

  [Symbol.asyncIterator]() {
    if (this.taken) throw new Error('yima-shared-loopback: uplink inbox already has a consumer');
    this.taken = true;
    return this;
  }

  async next() {
    while (true) {
      if (this.closed) return { value: undefined, done: true };
      if (this.head < this.queue.length) {
        const entry = this.queue[this.head++];
        if (this.head > 64 && this.head * 2 >= this.queue.length) {
          this.queue = this.queue.slice(this.head);
          this.head = 0;
        }
        this.bytes -= entry.bytes;
        return { value: entry.value, done: false };
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.ended) return { value: undefined, done: true };
      await new Promise((resolve) => { this.wake = resolve; });
    }
  }

  return() {
    this.closed = true;
    this.queue.length = 0;
    this.head = 0;
    this.bytes = 0;
    this.signal();
    return Promise.resolve({ value: undefined, done: true });
  }

  violate(error) {
    this.fail(error);
    this.onViolation(error);
  }

  signal() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

function parseClientMessage(text) {
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new Error('api gateway: Remote stream message is not JSON', { cause });
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('api gateway: Remote stream message must be an object');
  }
  const { type, streamId } = decoded;
  if (typeof streamId !== 'string' || streamId.length === 0) {
    throw new Error('api gateway: Remote stream message missing streamId');
  }
  if (type === 'cancel' || type === 'end' || type === 'item') return decoded;
  if (type === 'open' && typeof decoded.endpoint === 'string' && decoded.endpoint.length > 0) {
    return decoded;
  }
  throw new Error('api gateway: invalid Remote stream client message');
}

function rawToText(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function bindPeer(websocket, peer) {
  try {
    return peer.ctx.effect(
      () => () => { websocket.close(1001, 'peer left'); },
      'yima-shared-loopback: Remote stream socket bound to its Peer',
    );
  } catch {
    websocket.close(1001, 'peer left');
    return undefined;
  }
}

class SlimRemoteMuxServer {
  constructor({ WebSocket, WebSocketServer, wireStream, slimConfig, options = {}, logger }) {
    this.WebSocket = WebSocket;
    this.wireStream = wireStream;
    this.slimConfig = slimConfig;
    this.logger = logger;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxMissedHeartbeats = options.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED_HEARTBEATS;
    this.streamInboxBytes = options.streamInboxBytes ?? DEFAULT_STREAM_INBOX_BYTES;
    this.compression = options.compression !== false;
    this.compressionLevel = options.compressionLevel ?? DEFAULT_COMPRESSION_LEVEL;
    this.logStats = options.logStats !== false;

    this.connections = new Set();
    this.missedHeartbeats = new WeakMap();
    this.heartbeatTimer = undefined;

    this.server = new WebSocketServer({
      noServer: true,
      perMessageDeflate: this.compression
        ? { zlibDeflateOptions: { level: this.compressionLevel } }
        : false,
    });
  }

  handleUpgrade(req, socket, head, peer) {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const release = bindPeer(websocket, peer);
      if (release === undefined) return;

      const alive = () => { this.missedHeartbeats.set(websocket, 0); };
      alive();
      this.startHeartbeat();

      const connection = new SlimMuxConnection({
        WebSocket: this.WebSocket,
        socket: websocket,
        peer,
        wireStream: this.wireStream,
        slimConfig: this.slimConfig,
        streamInboxBytes: this.streamInboxBytes,
        compression: this.compression,
        logStats: this.logStats,
        logger: this.logger,
        alive,
      });

      const done = connection.run()
        .catch((error) => {
          this.logger?.warn?.('[yima-shared-loopback] mux connection error:', error);
        })
        .then(async () => { await release(); })
        .catch((error) => {
          this.logger?.warn?.('[yima-shared-loopback] mux peer cleanup error:', error);
        });

      this.connections.add(done);
      void done.then(() => { this.connections.delete(done); });
    });
  }

  async close() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const socket of this.server.clients) {
      socket.terminate();
    }
    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await Promise.all(this.connections);
  }

  startHeartbeat() {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.server.clients) {
        if (socket.readyState !== this.WebSocket.OPEN) continue;
        const missed = this.missedHeartbeats.get(socket) ?? 0;
        if (missed >= this.maxMissedHeartbeats) {
          setImmediate(() => {
            if ((this.missedHeartbeats.get(socket) ?? 0) >= this.maxMissedHeartbeats) {
              socket.terminate();
            }
          });
          continue;
        }
        this.missedHeartbeats.set(socket, missed + 1);
        socket.ping();
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }
}

class SlimMuxConnection {
  constructor(deps) {
    this.WebSocket = deps.WebSocket;
    this.socket = deps.socket;
    this.peer = deps.peer;
    this.wireStream = deps.wireStream;
    this.slimConfig = deps.slimConfig;
    this.streamInboxBytes = deps.streamInboxBytes;
    this.compression = deps.compression;
    this.logStats = deps.logStats;
    this.logger = deps.logger;
    this.alive = deps.alive;
    this.streams = new Map();
    this.writes = Promise.resolve();
  }

  async run() {
    const closed = new Promise((resolve) => {
      this.socket.once('close', () => resolve());
    });
    this.socket.on('pong', this.alive);
    this.socket.on('error', () => {});
    this.socket.on('message', (data, isBinary) => {
      this.alive();
      if (isBinary) {
        this.socket.close(1003, 'Remote stream requires text frames');
        return;
      }
      try {
        this.receive(rawToText(data));
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 120) : 'protocol error';
        this.socket.close(1008, reason);
      }
    });

    await closed;
    const cancelReason = new Error('Remote stream socket closed');
    for (const active of this.streams.values()) {
      active.stop(cancelReason);
    }
    await Promise.allSettled([...this.streams.values()].map((s) => s.done));
  }

  receive(text) {
    const msg = parseClientMessage(text);
    switch (msg.type) {
      case 'open':
        this.openStream(msg);
        return;
      case 'item':
        this.streams.get(msg.streamId)?.inbox.push(msg.value, Buffer.byteLength(text, 'utf8'));
        return;
      case 'end':
        this.streams.get(msg.streamId)?.inbox.end();
        return;
      case 'cancel':
        this.streams.get(msg.streamId)?.stop(new Error('Remote stream cancelled'));
        return;
    }
  }

  openStream(msg) {
    if (this.streams.has(msg.streamId)) {
      throw new Error(`duplicate Remote stream id ${JSON.stringify(msg.streamId)}`);
    }
    const abort = new AbortController();
    const inbox = new UplinkInbox(this.streamInboxBytes, msg.endpoint, (err) => { abort.abort(err); });
    const active = {
      abort,
      inbox,
      stop: (reason) => {
        abort.abort(reason);
        inbox.fail(reason);
      },
      done: Promise.resolve(),
    };
    this.streams.set(msg.streamId, active);
    const done = this.pump(msg.streamId, msg.endpoint, msg.payload, active);
    active.done = done;
    const remove = () => { this.streams.delete(msg.streamId); };
    void done.then(remove, remove);
  }

  async pump(streamId, endpoint, rawPayload, active) {
    const payload = endpoint === 'session/follow'
      ? rewriteFollowOpenPayload(rawPayload, this.slimConfig)
      : rawPayload;

    let outcome;
    try {
      const source = await this.wireStream.open(
        endpoint,
        payload,
        active.inbox,
        this.peer,
        active.abort.signal,
      );
      for await (const rawValue of source) {
        const value = this.transformFrame(endpoint, rawValue);
        await this.send({ type: 'item', streamId, value });
      }
      outcome = { failed: false };
    } catch (error) {
      outcome = { failed: true, error };
    }

    active.inbox.fail(new Error('Remote stream ended'));
    if (active.abort.signal.aborted) {
      const reason = active.abort.signal.reason;
      if (reason instanceof UplinkProtocolError) {
        await this.sendFailure(streamId, reason.wireFailure);
      }
      return;
    }
    if (outcome.failed) {
      await this.sendFailure(streamId, this.wireStream.failure(outcome.error));
      return;
    }
    try {
      await this.send({ type: 'end', streamId });
    } catch (error) {
      await this.sendFailure(streamId, this.wireStream.failure(error));
    }
  }

  transformFrame(endpoint, value) {
    if (endpoint === 'session/follow') {
      const slimmed = slimFollowFrame(value, this.slimConfig);
      if (this.logStats && value && typeof value === 'object' && value.type === 'snapshot') {
        const rawBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
        const slimBytes = Buffer.byteLength(JSON.stringify(slimmed), 'utf8');
        const pct = rawBytes > 0 ? (((rawBytes - slimBytes) / rawBytes) * 100).toFixed(1) : '0.0';
        const count = Array.isArray(value.records) ? value.records.length : 0;
        const msg = `[yima-shared-loopback] session/follow snapshot (${count} records): ${(rawBytes / 1024).toFixed(1)} KB -> ${(slimBytes / 1024).toFixed(1)} KB (${pct}% saved)`;
        if (this.logger?.info) this.logger.info(msg);
        else console.log(msg);
      }
      return slimmed;
    }
    if (endpoint === 'session/observeEvent' && value && typeof value === 'object' && value.type === 'event') {
      const nextEvent = slimSessionEvent(value.event, this.slimConfig);
      return nextEvent === value.event ? value : { ...value, event: nextEvent };
    }
    return value;
  }

  async sendFailure(streamId, failure) {
    if (this.socket.readyState !== this.WebSocket.OPEN) return;
    try {
      await this.send({ type: 'error', streamId, error: failure });
    } catch {
      this.socket.close(1011, 'Remote stream failure could not be delivered');
    }
  }

  send(message) {
    let text;
    try {
      text = JSON.stringify(message);
    } catch (cause) {
      return Promise.reject(new Error('yima-shared-loopback: stream item is not JSON serializable', { cause }));
    }
    const delivery = this.writes.then(() => new Promise((resolve, reject) => {
      if (this.socket.readyState !== this.WebSocket.OPEN) {
        reject(new Error('yima-shared-loopback: Remote stream socket is closed'));
        return;
      }
      let queued = false;
      this.socket.send(text, {
        compress: this.compression && text.length >= COMPRESS_THRESHOLD_BYTES,
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        if (queued) this.alive();
        resolve();
      });
      queued = this.socket.bufferedAmount > 0;
    }));
    this.writes = delivery.catch(() => undefined);
    return delivery;
  }
}

function readPathname(url) {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

function readUpstreamPort(carrier) {
  const addr = carrier?.server?.address?.();
  if (addr && typeof addr === 'object' && Number.isInteger(addr.port) && addr.port > 0) {
    return addr.port;
  }
  if (Number.isInteger(carrier?.port) && carrier.port > 0) return carrier.port;
  return undefined;
}

function proxySlimSessionPage(req, res, { upstreamPort, slimConfig, compressionLevel, logger, logStats }) {
  const headers = { ...req.headers };
  headers['accept-encoding'] = 'identity';
  delete headers['connection'];
  const clientAcceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));

  const upstreamReq = httpRequest({
    hostname: '127.0.0.1',
    port: upstreamPort,
    path: req.url,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    const chunks = [];
    upstreamRes.on('data', (chunk) => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const rawBuf = Buffer.concat(chunks);
      const statusCode = upstreamRes.statusCode ?? 200;
      const outHeaders = { ...upstreamRes.headers };
      delete outHeaders['transfer-encoding'];

      const contentType = String(outHeaders['content-type'] ?? '');
      if (statusCode !== 200 || !contentType.includes('application/json')) {
        outHeaders['content-length'] = String(rawBuf.length);
        res.writeHead(statusCode, outHeaders);
        res.end(rawBuf);
        return;
      }

      try {
        const encoding = String(outHeaders['content-encoding'] ?? '').toLowerCase();
        const plainBuf = encoding === 'gzip' ? gunzipSync(rawBuf) : rawBuf;
        const parsed = JSON.parse(plainBuf.toString('utf8'));
        const { body, changed } = slimRpcResponseBody(parsed, slimConfig);
        const outJsonBuf = changed ? Buffer.from(JSON.stringify(body), 'utf8') : plainBuf;

        if (changed && logStats) {
          const pct = plainBuf.length > 0
            ? (((plainBuf.length - outJsonBuf.length) / plainBuf.length) * 100).toFixed(1)
            : '0.0';
          const msg = `[yima-shared-loopback] ${req.url}: ${(plainBuf.length / 1024).toFixed(1)} KB -> ${(outJsonBuf.length / 1024).toFixed(1)} KB (${pct}% saved)`;
          if (logger?.info) logger.info(msg);
          else console.log(msg);
        }

        let wireBuf = outJsonBuf;
        if (clientAcceptsGzip && outJsonBuf.length >= COMPRESS_THRESHOLD_BYTES) {
          wireBuf = gzipSync(outJsonBuf, { level: compressionLevel });
          outHeaders['content-encoding'] = 'gzip';
        } else {
          delete outHeaders['content-encoding'];
        }
        outHeaders['content-length'] = String(wireBuf.length);
        res.writeHead(statusCode, outHeaders);
        res.end(wireBuf);
      } catch (error) {
        logger?.warn?.('[yima-shared-loopback] failed to slim session page response, passing through:', error);
        outHeaders['content-length'] = String(rawBuf.length);
        res.writeHead(statusCode, outHeaders);
        res.end(rawBuf);
      }
    });
  });

  upstreamReq.on('error', (error) => {
    logger?.warn?.('[yima-shared-loopback] upstream session page proxy error:', error);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad gateway');
    } else {
      res.destroy();
    }
  });

  req.pipe(upstreamReq);
}

export function apply(ctx, config = {}) {
  const host = config.host ?? '127.0.0.1';
  const port = config.port;
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('yima-shared-loopback: host must be a loopback address');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('yima-shared-loopback: a valid port is required');
  }
  const connection = ctx.connection;
  const carrier = ctx.webServer;
  const upstream = carrier?.server;
  if (carrier?.protocol !== 'http:' || typeof upstream?.emit !== 'function' ||
      !Array.isArray(connection?.trustedHosts)) {
    throw new Error('yima-shared-loopback: installed DSH carrier API has changed');
  }

  const slimConfig = resolveSlimConfig(config.slim);
  const heartbeatIntervalMs = Number.isSafeInteger(config.websocketHeartbeatIntervalMs) && config.websocketHeartbeatIntervalMs >= 1000
    ? config.websocketHeartbeatIntervalMs
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const compressionLevel = Number.isSafeInteger(config.compressionLevel) && config.compressionLevel >= 1 && config.compressionLevel <= 9
    ? config.compressionLevel
    : DEFAULT_COMPRESSION_LEVEL;
  const logStats = config.logStats !== false;
  const gateway = ctx.typertGateway;

  return ctx.effect(async () => {
    let mux = undefined;
    if (slimConfig.enabled) {
      if (typeof connection.admitConnection === 'function'
          && typeof gateway?.wireStream?.open === 'function'
          && typeof gateway?.wireStream?.failure === 'function') {
        const wsMod = await loadWsModule();
        if (wsMod) {
          mux = new SlimRemoteMuxServer({
            WebSocket: wsMod.WebSocket,
            WebSocketServer: wsMod.WebSocketServer,
            wireStream: gateway.wireStream,
            slimConfig,
            options: {
              heartbeatIntervalMs,
              compression: config.websocketCompression !== 'none',
              compressionLevel,
              logStats,
            },
            logger: ctx.logger,
          });
        } else {
          ctx.logger?.warn?.('[yima-shared-loopback] ws package unavailable; /api/remote.mux slimming disabled');
        }
      } else {
        ctx.logger?.warn?.('[yima-shared-loopback] typertGateway.wireStream unavailable; /api/remote.mux slimming disabled');
      }
    }

    const authority = `${host}:${port}`;
    const sockets = new Set();
    const peerReleases = new Set();

    const server = createServer((req, res) => {
      if (slimConfig.enabled && req.method === 'POST' && SLIM_HTTP_PATHS.has(readPathname(req.url))) {
        const upstreamPort = readUpstreamPort(carrier);
        if (upstreamPort !== undefined) {
          proxySlimSessionPage(req, res, {
            upstreamPort,
            slimConfig,
            compressionLevel,
            logger: ctx.logger,
            logStats,
          });
          return;
        }
      }
      upstream.emit('request', req, res);
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    server.on('upgrade', (req, socket, head) => {
      if (!mux || readPathname(req.url) !== REMOTE_STREAM_MUX_PATH) {
        upstream.emit('upgrade', req, socket, head);
        return;
      }

      const admission = connection.admitConnection(req);
      if ('rejection' in admission) {
        rejectUpgrade(socket, admission.rejection);
        return;
      }

      const release = () => {
        const done = admission.release().catch((error) => {
          ctx.logger?.warn?.('[yima-shared-loopback] peer release failed:', error);
        });
        peerReleases.add(done);
        void done.then(() => { peerReleases.delete(done); });
      };
      const closed = () => {
        socket.removeListener('error', release);
        release();
      };
      socket.on('error', release);
      socket.once('close', closed);
      if (socket.destroyed) {
        closed();
        return;
      }

      try {
        mux.handleUpgrade(req, socket, head, admission.peer);
      } catch (error) {
        release();
        socket.destroy();
        ctx.logger?.warn?.('[yima-shared-loopback] mux upgrade failed:', error);
      }
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
    server.on('error', (error) => ctx.logger?.warn?.(error));
    const added = !connection.trustedHosts.includes(authority);
    if (added) connection.trustedHosts.push(authority);
    const modeLabel = mux
      ? `slim mux active (maxMessages=${slimConfig.maxMessages}, minTurns=${slimConfig.minTurns}, wsLevel=${compressionLevel}, heartbeat=${heartbeatIntervalMs}ms)`
      : 'transparent passthrough';
    console.log(`dsh web shared: http://${authority}/ (${modeLabel})`);

    return async () => {
      if (added) {
        const index = connection.trustedHosts.indexOf(authority);
        if (index !== -1) connection.trustedHosts.splice(index, 1);
      }
      if (mux) await mux.close();
      await Promise.allSettled([...peerReleases]);
      await new Promise((resolve) => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      });
    };
  }, 'yima-shared-loopback: fixed loopback entry');
}
