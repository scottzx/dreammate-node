// Browser-side DSH plugin for @1agents/dreammate-node: registers per-row
// configuration panels (`plugins.row.config`) for all three bundled rows:
//   - dreammate-node
//   - yima-tailnet-trust
//   - yima-shared-loopback
// Loaded by DSH via exports["./client"].default (Node consumers still get
// dist/src/client.js via exports["./client"].node / .import).

const STYLE = `
.dm-cfg { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
.dm-cfg * { box-sizing: border-box; }
.dm-cfg-group { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dm-cfg-group h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dm-cfg-field { display: flex; flex-direction: column; gap: 6px; }
.dm-cfg-field label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dm-cfg-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dm-cfg-input, .dm-cfg-select { height: 34px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28)); border-radius: 8px; background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; width: 100%; }
.dm-cfg-input:disabled, .dm-cfg-select:disabled { opacity: 0.6; cursor: not-allowed; }
.dm-cfg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.dm-cfg-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }
.dm-cfg-toggle-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dm-cfg-toggle-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dm-cfg-toggle input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; flex: none; accent-color: var(--dsw-alias-state-business-primary, #3b82f6); }
.dm-cfg-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dm-cfg-btn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28)); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.dm-cfg-btn-primary { background: var(--dsw-alias-state-business-primary, #2563eb); border-color: transparent; color: #fff; }
.dm-cfg-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.dm-cfg-banner { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 18px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08)); color: var(--dsw-alias-label-secondary); }
.dm-cfg-banner-err { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dm-cfg-banner-ok { color: var(--dsw-alias-state-success-primary, #16a34a); }
`;

window.__ModuleLoader__.load({
  id: '@1agents/dreammate-node',
  dependencies: ['react'],
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;

    const PACKAGE = '@1agents/dreammate-node';
    const SERVICE = 'dreammateRowConfig';
    const NS = 'dreammate-row-config';

    const codec = (label, parse) => ({
      mode: 'strict',
      typeSymbol: `${PACKAGE}#${label}`,
      create: () => ({ parse }),
    });
    const objectOf = (v) => (!v || typeof v !== 'object' || Array.isArray(v) ? {} : v);
    const resultOf = (v) => {
      if (v && typeof v === 'object' && (v.ok === true || v.ok === false)) return v;
      throw new Error('dreammateRowConfig: invalid result');
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
          parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('ReadInput', objectOf) }],
          result: codec('ReadResult', resultOf),
        },
        {
          id: `${PACKAGE}#rowConfigSave`,
          service: SERVICE,
          namespace: SERVICE,
          method: 'save',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('SaveInput', objectOf) }],
          result: codec('SaveResult', resultOf),
        },
      ],
    };

    const zh = {
      'summary.dreammate-node': 'DreamMate 节点网关与跨设备服务发现连接配置。',
      'summary.yima-tailnet-trust': '信任唯一精确的 Tailscale MagicDNS 域名端口，放行手机/远程访问。',
      'summary.yima-shared-loopback': '桌面共享回环入口与 /api/remote.mux 低带宽远程省流配置。',
      loading: '正在读取当前配置…',
      inactiveHint: '该组件当前未启用。请先返回组件列表打开它的开关，然后再回来编辑并保存配置。',
      unavailableHint: '当前环境不支持在线修改配置，请直接编辑 profile 下的 cordis.patch.yml。',
      save: '保存并热重载',
      saving: '保存中…',
      reload: '重新读取',
      saved: '已保存到 cordis.patch.yml 并完成热重载。',
      'node.mode': '服务模式（serviceMode）',
      'node.modeHint': 'auto 自动复用已有网关或在缺失时托管启动；external 只连外部网关；managed 由插件托管进程。',
      'node.url': '网关地址（serviceUrl）',
      'node.urlHint': '本机或目标 DreamMate 节点 HTTP 地址，默认 http://127.0.0.1:36908。',
      'trust.authority': 'Tailscale 访问地址（authority）',
      'trust.authorityHint': '必须填写精确的小写 *.ts.net 域名与端口，例如 scott-mac.tailfb4720.ts.net:3080（不要带 https://）。',
      'loopback.basic': '回环监听',
      'loopback.host': '回环地址（host）',
      'loopback.port': '端口（port）',
      'loopback.portHint': '供 Tailscale Serve 转发的目标端口（如 3466），仅允许 127.0.0.1 或 ::1。',
      'loopback.slimSection': '远程省流（/api/remote.mux 与历史翻页）',
      'loopback.slimEnabled': '开启远程省流',
      'loopback.slimEnabledHint': '仅对走此端口的远程/手机端生效，Mac 桌面端保持 100% 原样。',
      'loopback.stripArgs': '工具调用仅保留工具名',
      'loopback.stripArgsHint': '清空超长工具调用参数原文，大幅缩小包体。',
      'loopback.omitResults': '忽略工具输出结果与 meta',
      'loopback.omitResultsHint': '保留用户消息块和助理消息块；工具报错时仍保留简短错误摘要。',
      'loopback.maxMessages': '首屏最多消息数',
      'loopback.minMessages': '窗口最少消息数',
      'loopback.minTurns': '首屏最少轮数',
      'loopback.transportSection': 'WebSocket 传输调优',
      'loopback.heartbeat': '心跳间隔（ms）',
      'loopback.heartbeatHint': '默认 15000ms（30 秒超时），防止 3 Mbps 弱网下大帧触发断线重连。',
      'loopback.level': 'Deflate 压缩级别（1–9）',
      'loopback.levelHint': '默认 6，比 DSH 原生 level 1 再省约 25%–40% 流量。',
    };

    const en = {
      'summary.dreammate-node': 'DreamMate Node gateway and cross-device service discovery connection settings.',
      'summary.yima-tailnet-trust': 'Trust one exact Tailscale MagicDNS host:port authority for remote access.',
      'summary.yima-shared-loopback': 'Shared desktop loopback entry and low-bandwidth /api/remote.mux slimming.',
      loading: 'Loading configuration…',
      inactiveHint: 'This component is currently disabled. Enable its switch in the component list first, then return here to edit and save.',
      unavailableHint: 'Live configuration editing is unavailable in this environment. Edit cordis.patch.yml directly.',
      save: 'Save & reload',
      saving: 'Saving…',
      reload: 'Reload',
      saved: 'Saved to cordis.patch.yml and hot-reloaded.',
      'node.mode': 'Service mode (serviceMode)',
      'node.modeHint': 'auto reuses an existing gateway or starts one; external connects only; managed spawns a child.',
      'node.url': 'Gateway URL (serviceUrl)',
      'node.urlHint': 'Local or target DreamMate Node HTTP URL (default http://127.0.0.1:36908).',
      'trust.authority': 'Tailscale authority',
      'trust.authorityHint': 'Exact lowercase *.ts.net host:port (e.g. host.tailxxxx.ts.net:3080, without https://).',
      'loopback.basic': 'Loopback listener',
      'loopback.host': 'Loopback host',
      'loopback.port': 'Port',
      'loopback.portHint': 'Loopback port proxied by Tailscale Serve (e.g. 3466); only 127.0.0.1 or ::1 is allowed.',
      'loopback.slimSection': 'Remote slimming (/api/remote.mux & history pages)',
      'loopback.slimEnabled': 'Enable remote slimming',
      'loopback.slimEnabledHint': 'Applies only to remote traffic via this port; local desktop UI stays 100% untouched.',
      'loopback.stripArgs': 'Keep tool name only (strip arguments)',
      'loopback.stripArgsHint': 'Clears bulky tool call arguments while keeping tool names visible.',
      'loopback.omitResults': 'Omit tool result outputs & meta',
      'loopback.omitResultsHint': 'Keeps user and assistant messages intact; preserves short error summaries on failures.',
      'loopback.maxMessages': 'Max initial messages',
      'loopback.minMessages': 'Min window messages',
      'loopback.minTurns': 'Min initial turns',
      'loopback.transportSection': 'WebSocket transport tuning',
      'loopback.heartbeat': 'Heartbeat interval (ms)',
      'loopback.heartbeatHint': 'Default 15000ms (30s timeout) to prevent disconnect loops on slow relay links.',
      'loopback.level': 'Deflate level (1–9)',
      'loopback.levelHint': 'Default 6 for stronger compression than DSH default level 1.',
    };

    function useRowConfig(api, rowId, toDraft) {
      const [status, setStatus] = useState('loading');
      const [meta, setMeta] = useState({ writable: false, active: false, reason: undefined });
      const [draft, setDraft] = useState(() => toDraft({}));
      const [saving, setSaving] = useState(false);
      const [feedback, setFeedback] = useState(null);

      const load = useCallback(async () => {
        setStatus('loading');
        setFeedback(null);
        try {
          const res = await api.read({ rowId });
          if (!res.ok) {
            setStatus('error');
            setFeedback({ kind: 'error', text: res.error?.message || '读取失败' });
            return;
          }
          setMeta({ writable: res.writable === true, active: res.active === true, reason: res.reason });
          setDraft(toDraft(res.effective || {}));
          setStatus('ready');
        } catch (err) {
          setStatus('error');
          setFeedback({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
        }
      }, [api, rowId, toDraft]);

      useEffect(() => { void load(); }, [load]);

      const save = useCallback(async (payload) => {
        setSaving(true);
        setFeedback(null);
        try {
          const res = await api.save({ rowId, config: payload });
          if (!res.ok) {
            setFeedback({ kind: 'error', text: res.error?.message || '保存失败' });
            return false;
          }
          setMeta({ writable: res.writable === true, active: res.active === true, reason: res.reason });
          setDraft(toDraft(res.effective || {}));
          setFeedback({ kind: 'ok', text: null });
          return true;
        } catch (err) {
          setFeedback({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
          return false;
        } finally {
          setSaving(false);
        }
      }, [api, rowId, toDraft]);

      return { status, meta, draft, setDraft, saving, feedback, load, save };
    }

    function FormShell({ t, status, meta, saving, feedback, onSave, onReload, children }) {
      return h('div', { className: 'dm-cfg' },
        h('style', null, STYLE),
        status === 'loading' ? h('p', { className: 'dm-cfg-banner' }, t('loading')) : null,
        status === 'ready' && !meta.writable
          ? h('p', { className: 'dm-cfg-banner' }, meta.reason === 'inactive' ? t('inactiveHint') : t('unavailableHint'))
          : null,
        children,
        feedback?.kind === 'error' ? h('p', { className: 'dm-cfg-banner dm-cfg-banner-err', role: 'alert' }, feedback.text) : null,
        feedback?.kind === 'ok' ? h('p', { className: 'dm-cfg-banner dm-cfg-banner-ok', role: 'status' }, t('saved')) : null,
        h('div', { className: 'dm-cfg-actions' },
          h('button', {
            type: 'button',
            className: 'dm-cfg-btn dm-cfg-btn-primary',
            disabled: saving || status !== 'ready' || !meta.writable,
            onClick: onSave,
          }, saving ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'dm-cfg-btn',
            disabled: saving,
            onClick: onReload,
          }, t('reload')),
        ),
      );
    }

    const nodeDraftOf = (cfg) => ({
      serviceMode: cfg.serviceMode || 'auto',
      serviceUrl: cfg.serviceUrl || 'http://127.0.0.1:36908',
    });

    function DreamMateNodePanel(props) {
      const { t, view, api } = props;
      if (view === 'summary') return t('summary.dreammate-node');
      const { status, meta, draft, setDraft, saving, feedback, load, save } = useRowConfig(api, 'dreammate-node', nodeDraftOf);
      const disabled = saving || status !== 'ready' || !meta.writable;
      return h(FormShell, {
        t, status, meta, saving, feedback,
        onSave: () => { void save({ serviceMode: draft.serviceMode, serviceUrl: draft.serviceUrl }); },
        onReload: () => { void load(); },
      },
        h('div', { className: 'dm-cfg-group' },
          h('div', { className: 'dm-cfg-field' },
            h('label', null, t('node.mode')),
            h('select', {
              className: 'dm-cfg-select',
              value: draft.serviceMode,
              disabled,
              onChange: (e) => setDraft((d) => ({ ...d, serviceMode: e.target.value })),
            },
              h('option', { value: 'auto' }, 'auto'),
              h('option', { value: 'external' }, 'external'),
              h('option', { value: 'managed' }, 'managed'),
            ),
            h('p', { className: 'dm-cfg-hint' }, t('node.modeHint')),
          ),
          h('div', { className: 'dm-cfg-field' },
            h('label', null, t('node.url')),
            h('input', {
              className: 'dm-cfg-input',
              type: 'text',
              value: draft.serviceUrl,
              disabled,
              onChange: (e) => setDraft((d) => ({ ...d, serviceUrl: e.target.value })),
            }),
            h('p', { className: 'dm-cfg-hint' }, t('node.urlHint')),
          ),
        ),
      );
    }

    const trustDraftOf = (cfg) => ({
      authority: typeof cfg.authority === 'string' ? cfg.authority : '',
    });

    function TailnetTrustPanel(props) {
      const { t, view, api } = props;
      if (view === 'summary') return t('summary.yima-tailnet-trust');
      const { status, meta, draft, setDraft, saving, feedback, load, save } = useRowConfig(api, 'yima-tailnet-trust', trustDraftOf);
      const disabled = saving || status !== 'ready' || !meta.writable;
      return h(FormShell, {
        t, status, meta, saving, feedback,
        onSave: () => { void save({ authority: draft.authority }); },
        onReload: () => { void load(); },
      },
        h('div', { className: 'dm-cfg-group' },
          h('div', { className: 'dm-cfg-field' },
            h('label', null, t('trust.authority')),
            h('input', {
              className: 'dm-cfg-input',
              type: 'text',
              placeholder: 'scott-mac.tailfb4720.ts.net:3080',
              value: draft.authority,
              disabled,
              onChange: (e) => setDraft({ authority: e.target.value }),
            }),
            h('p', { className: 'dm-cfg-hint' }, t('trust.authorityHint')),
          ),
        ),
      );
    }

    const loopbackDraftOf = (cfg) => {
      const slimRaw = cfg.slim;
      const slimEnabled = slimRaw === false ? false : (slimRaw?.enabled !== false);
      const slimObj = slimRaw && typeof slimRaw === 'object' ? slimRaw : {};
      return {
        host: cfg.host || '127.0.0.1',
        port: cfg.port ? String(cfg.port) : '3466',
        slimEnabled,
        maxMessages: String(slimObj.maxMessages ?? 24),
        minMessages: String(slimObj.minMessages ?? 12),
        minTurns: String(slimObj.minTurns ?? 1),
        stripToolArguments: slimObj.stripToolArguments !== false,
        omitToolResults: slimObj.omitToolResults !== false,
        heartbeat: String(cfg.websocketHeartbeatIntervalMs ?? 15000),
        compressionLevel: String(cfg.compressionLevel ?? 6),
      };
    };

    function SharedLoopbackPanel(props) {
      const { t, view, api } = props;
      if (view === 'summary') return t('summary.yima-shared-loopback');
      const { status, meta, draft, setDraft, saving, feedback, load, save } = useRowConfig(api, 'yima-shared-loopback', loopbackDraftOf);
      const disabled = saving || status !== 'ready' || !meta.writable;
      const slimDisabled = disabled || !draft.slimEnabled;

      const handleSave = () => {
        const payload = {
          host: draft.host,
          port: Number(draft.port),
          websocketHeartbeatIntervalMs: Number(draft.heartbeat),
          compressionLevel: Number(draft.compressionLevel),
          slim: draft.slimEnabled
            ? {
              enabled: true,
              maxMessages: Number(draft.maxMessages),
              minMessages: Number(draft.minMessages),
              minTurns: Number(draft.minTurns),
              stripToolArguments: draft.stripToolArguments,
              omitToolResults: draft.omitToolResults,
            }
            : false,
        };
        void save(payload);
      };

      return h(FormShell, {
        t, status, meta, saving, feedback,
        onSave: handleSave,
        onReload: () => { void load(); },
      },
        h('div', { className: 'dm-cfg-group' },
          h('h4', null, t('loopback.basic')),
          h('div', { className: 'dm-cfg-grid' },
            h('div', { className: 'dm-cfg-field' },
              h('label', null, t('loopback.host')),
              h('select', {
                className: 'dm-cfg-select',
                value: draft.host,
                disabled,
                onChange: (e) => setDraft((d) => ({ ...d, host: e.target.value })),
              },
                h('option', { value: '127.0.0.1' }, '127.0.0.1'),
                h('option', { value: '::1' }, '::1'),
              ),
            ),
            h('div', { className: 'dm-cfg-field' },
              h('label', null, t('loopback.port')),
              h('input', {
                className: 'dm-cfg-input',
                type: 'number',
                min: 1,
                max: 65535,
                value: draft.port,
                disabled,
                onChange: (e) => setDraft((d) => ({ ...d, port: e.target.value })),
              }),
            ),
          ),
          h('p', { className: 'dm-cfg-hint' }, t('loopback.portHint')),
        ),
        h('div', { className: 'dm-cfg-group' },
          h('h4', null, t('loopback.slimSection')),
          h('label', { className: 'dm-cfg-toggle' },
            h('span', { className: 'dm-cfg-toggle-text' },
              h('span', { className: 'dm-cfg-toggle-title' }, t('loopback.slimEnabled')),
              h('span', { className: 'dm-cfg-hint' }, t('loopback.slimEnabledHint')),
            ),
            h('input', {
              type: 'checkbox',
              checked: draft.slimEnabled,
              disabled,
              onChange: (e) => setDraft((d) => ({ ...d, slimEnabled: e.target.checked })),
            }),
          ),
          h('label', { className: 'dm-cfg-toggle' },
            h('span', { className: 'dm-cfg-toggle-text' },
              h('span', { className: 'dm-cfg-toggle-title' }, t('loopback.stripArgs')),
              h('span', { className: 'dm-cfg-hint' }, t('loopback.stripArgsHint')),
            ),
            h('input', {
              type: 'checkbox',
              checked: draft.stripToolArguments,
              disabled: slimDisabled,
              onChange: (e) => setDraft((d) => ({ ...d, stripToolArguments: e.target.checked })),
            }),
          ),
          h('label', { className: 'dm-cfg-toggle' },
            h('span', { className: 'dm-cfg-toggle-text' },
              h('span', { className: 'dm-cfg-toggle-title' }, t('loopback.omitResults')),
              h('span', { className: 'dm-cfg-hint' }, t('loopback.omitResultsHint')),
            ),
            h('input', {
              type: 'checkbox',
              checked: draft.omitToolResults,
              disabled: slimDisabled,
              onChange: (e) => setDraft((d) => ({ ...d, omitToolResults: e.target.checked })),
            }),
          ),
          h('div', { className: 'dm-cfg-grid' },
            h('div', { className: 'dm-cfg-field' },
              h('label', null, t('loopback.maxMessages')),
              h('input', {
                className: 'dm-cfg-input',
                type: 'number',
                min: 1,
                max: 500,
                value: draft.maxMessages,
                disabled: slimDisabled,
                onChange: (e) => setDraft((d) => ({ ...d, maxMessages: e.target.value })),
              }),
            ),
            h('div', { className: 'dm-cfg-field' },
              h('label', null, t('loopback.minMessages')),
              h('input', {
                className: 'dm-cfg-input',
                type: 'number',
                min: 1,
                max: 500,
                value: draft.minMessages,
                disabled: slimDisabled,
                onChange: (e) => setDraft((d) => ({ ...d, minMessages: e.target.value })),
              }),
            ),
            h('div', { className: 'dm-cfg-field' },
              h('label', null, t('loopback.minTurns')),
              h('input', {
                className: 'dm-cfg-input',
                type: 'number',
                min: 1,
                max: 50,
                value: draft.minTurns,
                disabled: slimDisabled,
                onChange: (e) => setDraft((d) => ({ ...d, minTurns: e.target.value })),
              }),
            ),
          ),
        ),
        h('div', { className: 'dm-cfg-group' },
          h('h4', null, t('loopback.transportSection')),
          h('div', { className: 'dm-cfg-grid' },
            h('div', { className: 'dm-cfg-field' },
              h('label', null, t('loopback.heartbeat')),
              h('input', {
                className: 'dm-cfg-input',
                type: 'number',
                min: 1000,
                max: 600000,
                value: draft.heartbeat,
                disabled: slimDisabled,
                onChange: (e) => setDraft((d) => ({ ...d, heartbeat: e.target.value })),
              }),
              h('p', { className: 'dm-cfg-hint' }, t('loopback.heartbeatHint')),
            ),
            h('div', { className: 'dm-cfg-field' },
              h('label', null, t('loopback.level')),
              h('input', {
                className: 'dm-cfg-input',
                type: 'number',
                min: 1,
                max: 9,
                value: draft.compressionLevel,
                disabled: slimDisabled,
                onChange: (e) => setDraft((d) => ({ ...d, compressionLevel: e.target.value })),
              }),
              h('p', { className: 'dm-cfg-hint' }, t('loopback.levelHint')),
            ),
          ),
        ),
      );
    }

    const inject = ['slots', 'locale', 'remote'];

    async function apply(ctx) {
      const release = await ctx.remote.$mount(contribution);
      ctx.effect(() => release);
      await ctx.plugin({
        name: `${PACKAGE}/row-config-ui`,
        inject: ['slots', 'locale', `remote.${SERVICE}`],
        apply(uiCtx) {
          uiCtx.effect(() => uiCtx.locale.register(NS, { zh, en }));
          const remote = uiCtx.remote[SERVICE];
          const api = {
            read: (input) => remote.read(input),
            save: (input) => remote.save(input),
          };
          const rows = [
            ['dreammate-node', DreamMateNodePanel],
            ['yima-tailnet-trust', TailnetTrustPanel],
            ['yima-shared-loopback', SharedLoopbackPanel],
          ];
          for (const [rowId, Component] of rows) {
            uiCtx.effect(() => uiCtx.slots.inject('plugins.row.config', () => uiCtx.slots.register({
              name: 'plugins.row.config',
              key: `${PACKAGE}#${rowId}`,
              locale: NS,
              inject: () => ({ api }),
            }, Component)));
          }
        },
      });
    }

    return { inject, apply };
  },
});
