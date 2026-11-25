// Host Typert RPC for reading and saving configuration of the three rows
// bundled inside @1agents/dreammate-node (`dreammate-node`,
// `yima-tailnet-trust`, `yima-shared-loopback`) via DSH's ConfigEditor.

const PACKAGE = '@1agents/dreammate-node';
const SERVICE = 'dreammateRowConfig';

export const ALLOWED_ROW_IDS = Object.freeze([
  'dreammate-node',
  'yima-tailnet-trust',
  'yima-shared-loopback',
]);

const ALLOWED_ROW_SET = new Set(ALLOWED_ROW_IDS);
const VALID_SERVICE_MODES = new Set(['auto', 'external', 'managed']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateTailnetAuthority(authority) {
  let parsed;
  try { parsed = new URL(`https://${authority}`); } catch { /* handled below */ }
  if (typeof authority !== 'string' || !parsed || parsed.host !== authority ||
      !/^[a-z0-9.-]+$/.test(parsed.hostname) ||
      !parsed.hostname.endsWith('.ts.net') || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('authority 必须是精确的 Tailscale DNS host:port（例如 host.tailxxxx.ts.net:3080）');
  }
}

export function validateRowConfig(rowId, raw) {
  if (!ALLOWED_ROW_SET.has(rowId)) {
    throw new Error(`unsupported rowId: ${String(rowId)}`);
  }
  if (!isPlainObject(raw)) {
    throw new Error('config must be an object');
  }

  if (rowId === 'dreammate-node') {
    const mode = raw.serviceMode ?? 'auto';
    if (!VALID_SERVICE_MODES.has(mode)) {
      throw new Error('serviceMode 必须是 auto、external 或 managed');
    }
    const url = raw.serviceUrl ?? 'http://127.0.0.1:36908';
    let parsed;
    try { parsed = new URL(url); } catch { /* handled below */ }
    if (typeof url !== 'string' || !parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error('serviceUrl 必须是有效的 http:// 或 https:// 地址');
    }
    return {
      ...raw,
      serviceMode: mode,
      serviceUrl: url.trim(),
    };
  }

  if (rowId === 'yima-tailnet-trust') {
    const authority = typeof raw.authority === 'string' ? raw.authority.trim() : '';
    validateTailnetAuthority(authority);
    return { authority };
  }

  // yima-shared-loopback
  const host = typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('host 必须是回环地址（127.0.0.1 或 ::1）');
  }
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port 必须是 1–65535 之间的整数');
  }

  const next = { host, port };

  if (raw.websocketHeartbeatIntervalMs !== undefined && raw.websocketHeartbeatIntervalMs !== '') {
    const hb = Number(raw.websocketHeartbeatIntervalMs);
    if (!Number.isSafeInteger(hb) || hb < 1000 || hb > 600_000) {
      throw new Error('websocketHeartbeatIntervalMs 必须是 1000–600000 之间的整数');
    }
    next.websocketHeartbeatIntervalMs = hb;
  }

  if (raw.compressionLevel !== undefined && raw.compressionLevel !== '') {
    const level = Number(raw.compressionLevel);
    if (!Number.isInteger(level) || level < 1 || level > 9) {
      throw new Error('compressionLevel 必须是 1–9 之间的整数');
    }
    next.compressionLevel = level;
  }

  if (typeof raw.logStats === 'boolean') {
    next.logStats = raw.logStats;
  }

  if (raw.slim === false) {
    next.slim = false;
  } else if (isPlainObject(raw.slim)) {
    const slim = {};
    if (typeof raw.slim.enabled === 'boolean') slim.enabled = raw.slim.enabled;
    if (raw.slim.maxMessages !== undefined && raw.slim.maxMessages !== '') {
      const v = Number(raw.slim.maxMessages);
      if (!Number.isSafeInteger(v) || v < 1 || v > 500) {
        throw new Error('slim.maxMessages 必须是 1–500 之间的整数');
      }
      slim.maxMessages = v;
    }
    if (raw.slim.minMessages !== undefined && raw.slim.minMessages !== '') {
      const v = Number(raw.slim.minMessages);
      if (!Number.isSafeInteger(v) || v < 1 || v > 500) {
        throw new Error('slim.minMessages 必须是 1–500 之间的整数');
      }
      slim.minMessages = v;
    }
    if (slim.maxMessages !== undefined && slim.minMessages !== undefined && slim.minMessages > slim.maxMessages) {
      slim.minMessages = slim.maxMessages;
    }
    if (raw.slim.minTurns !== undefined && raw.slim.minTurns !== '') {
      const v = Number(raw.slim.minTurns);
      if (!Number.isSafeInteger(v) || v < 1 || v > 50) {
        throw new Error('slim.minTurns 必须是 1–50 之间的整数');
      }
      slim.minTurns = v;
    }
    for (const key of [
      'stripToolArguments',
      'omitToolResults',
      'keepToolError',
      'dropAssistantStream',
      'stripRequestHeaderTools',
      'dropCompactionRawOutput',
      'slimLiveToolDeltas',
    ]) {
      if (typeof raw.slim[key] === 'boolean') slim[key] = raw.slim[key];
    }
    if (Object.keys(slim).length > 0) next.slim = slim;
  }

  return next;
}

function findEntryRecord(configEditor, rowId) {
  if (!configEditor || typeof configEditor.configuration !== 'function') return undefined;
  const list = configEditor.configuration();
  return list.find((item) => item?.entry?.options?.id === rowId);
}

export function readRowConfig(configEditor, rowId) {
  if (!ALLOWED_ROW_SET.has(rowId)) {
    return { ok: false, error: { code: 'INVALID_ROW', message: `不支持的组件：${String(rowId)}` } };
  }
  if (!configEditor) {
    return {
      ok: true,
      rowId,
      writable: false,
      active: false,
      reason: 'unavailable',
      effective: {},
      inherited: {},
      override: {},
    };
  }
  const found = findEntryRecord(configEditor, rowId);
  if (!found) {
    return {
      ok: true,
      rowId,
      writable: false,
      active: false,
      reason: 'inactive',
      effective: {},
      inherited: {},
      override: {},
    };
  }
  const entry = found.entry;
  // FiberState.ACTIVE === 2 in Cordis
  const active = entry.fiber !== undefined && entry.fiber.state === 2 && !entry.disabled;
  const effective = structuredClone(entry.options?.config ?? {});
  return {
    ok: true,
    rowId,
    writable: active,
    active,
    reason: active ? undefined : 'inactive',
    effective,
    inherited: found.inherited ?? {},
    override: found.override ?? {},
  };
}

export async function saveRowConfig(configEditor, rowId, rawConfig) {
  if (!ALLOWED_ROW_SET.has(rowId)) {
    return { ok: false, error: { code: 'INVALID_ROW', message: `不支持的组件：${String(rowId)}` } };
  }
  if (!configEditor || typeof configEditor.edit !== 'function') {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '当前环境未挂载配置编辑器' } };
  }
  let validated;
  try {
    validated = validateRowConfig(rowId, rawConfig);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: error instanceof Error ? error.message : String(error) },
    };
  }
  const found = findEntryRecord(configEditor, rowId);
  if (!found || !found.entry) {
    return {
      ok: false,
      error: { code: 'INACTIVE', message: '组件未启用，请先打开该组件的开关后再保存配置' },
    };
  }
  try {
    await configEditor.edit(found.entry, () => validated);
    return readRowConfig(configEditor, rowId);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'SAVE_FAILED', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

const codec = (label, parse) => ({
  mode: 'strict',
  typeSymbol: `${PACKAGE}#${label}`,
  create: () => ({ parse }),
});

const objectOf = (value) => (!value || typeof value !== 'object' || Array.isArray(value) ? {} : value);
const resultOf = (value) => {
  if (value && typeof value === 'object' && (value.ok === true || value.ok === false)) return value;
  throw new Error('dreammateRowConfig: invalid RPC result');
};

const contribution = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#rowConfigRead`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'input', wire: 'input', source: 'json', codec: codec('ReadInput', objectOf) },
      ],
      result: codec('ReadResult', resultOf),
    },
    {
      id: `${PACKAGE}#rowConfigSave`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'input', wire: 'input', source: 'json', codec: codec('SaveInput', objectOf) },
      ],
      result: codec('SaveResult', resultOf),
    },
  ],
};

export function registerRowConfigRpc(ctx) {
  if (typeof ctx?.inject !== 'function' || typeof ctx?.reflect?.provide !== 'function') return;
  ctx.inject(['typert'], (typertCtx) => {
    const service = {
      async read(input) {
        return readRowConfig(typertCtx.get?.('configEditor'), input?.rowId);
      },
      async save(input) {
        return saveRowConfig(typertCtx.get?.('configEditor'), input?.rowId, input?.config);
      },
    };
    service.typertRemote = Object.freeze({ service, serviceKey: SERVICE, namespace: SERVICE });
    typertCtx.effect(() => typertCtx.reflect.provide(SERVICE, service));
    typertCtx.effect(() => typertCtx.typert.register({
      ...contribution,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: contribution.descriptors,
    }));
  });
}
