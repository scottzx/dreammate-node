import { createServer } from 'node:http';

export async function endpoint(t, handler = (_req, res) => res.end('{}')) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  t.after(close);
  return { url, close };
}
export async function unused(t) { const fixture = await endpoint(t); await fixture.close(); return fixture.url; }
export const health = url => fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });

export function context() {
  const disposers = [];
  const tools = new Map();
  return {
    definitions: tools,
    tools: { register(tool) {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    } },
    async effect(body) { const dispose = await body(); disposers.push(dispose); },
    async dispose() { for (const dispose of disposers.reverse()) await dispose(); },
  };
}
