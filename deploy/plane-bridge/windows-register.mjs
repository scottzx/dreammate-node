// Windows can reach the WSL bridge through localhost forwarding. Registration
// happens inside the Windows gateway, so no remote registration is permitted.
export async function attachPlaneRegistration(registry) {
  let running = false;
  let reportedFailure = false;
  const sync = async () => {
    if (running) return;
    running = true;
    try {
      const response = await fetch('http://127.0.0.1:7792/manifest', { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('bridge unavailable');
      const manifest = await response.json();
      const raw = manifest.services?.find(s => s.id === 'plane-pm');
      if (!raw?.methods?.['plane.project']) throw Error('Plane catalog missing');
      const service = { ...raw, port: 7792, execution: 'http', reachability: 'localhost' };
      const current = registry.get(service.id);
      if (!current || current.port !== service.port || JSON.stringify(current.methods) !== JSON.stringify(service.methods) || JSON.stringify(current.metadata) !== JSON.stringify(service.metadata)) {
        registry.register(service);
        console.log(`Plane registered: ${service.metadata.tool_count} official MCP tools`);
      }
      reportedFailure = false;
    } catch {
      if (!reportedFailure) console.error('Plane bridge unavailable; registration will retry');
      reportedFailure = true;
    } finally { running = false; }
  };
  await sync();
  const timer = setInterval(sync, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
