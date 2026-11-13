// IPC ownership ensures an abruptly terminated DSH host leaves no orphan daemon.
let server;
let registry;
let access;
let stopping = false;
let shutdownTimeoutMs = 5000;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), shutdownTimeoutMs);
  registry?.stop();
  await access?.close().catch(() => {});
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  clearTimeout(timer);
  process.exit(0);
}
process.once('disconnect', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

process.once('message', async message => {
  if (stopping) return;
  try {
    const { host, port } = message ?? {};
    if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535
      || !Number.isInteger(message.shutdownTimeoutMs) || message.shutdownTimeoutMs < 1) {
      throw new Error('Invalid DreamMate worker configuration');
    }
    shutdownTimeoutMs = message.shutdownTimeoutMs;
    const { createAgent, rediscover, nodeIdentity, startAccessControl } = await import('@1agents/dreammate-node');
    if (stopping) return;
    // 跟 `dreammate-node` 常驻进程一样：公网默认关闭，可信网段免 token。
    // 访问控制面只听回环；端口已被常驻进程占用时沿用那一个写入方。
    ({ server, registry } = createAgent({ enforcePublicAccess: true }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
    const identity = await nodeIdentity();
    await rediscover(registry, identity.ipv4 ? { ipv4: identity.ipv4 } : {}).catch(() => 0);
    if (stopping) return;
    try {
      access = await startAccessControl();
    } catch (error) {
      if (!error || error.code !== 'EADDRINUSE') throw error;
    }
    if (stopping) return;
    registry.start();
    if (process.connected) process.send({ type: 'ready' });
  } catch (error) {
    if (process.connected) {
      process.send({ type: 'error', message: error.message, code: error.code }, () => void shutdown());
    } else void shutdown();
  }
});
if (!process.connected) void shutdown();
