import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { callDreammateTool } from '../src/mcp.js';
import { serveSkillService } from '@1agents/skill-manager';

test('a standalone provider discovers shared directories and the gateway forwards its catalog', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-auto-gateway-'));
  const directory = path.join(home, '.agents/skills/auto-scene');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: auto-scene\ndescription: Prepare lighting for a visual scene\n---\nRead the scene workflow.\n');
  const registry = new ServiceRegistry({ storagePath: false });
  const agent = createAgent({ registry, mcpSources: { storagePath: false } });
  await new Promise<void>(resolve => agent.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  const absent = await fetch(`${base}/skills`);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json() as { code: string }).code, 'SKILL_PROVIDER_UNAVAILABLE');
  assert.equal(registry.list().length, 0, 'starting Node must not discover or launch a skill provider');
  const provider = await serveSkillService({ port: 0, register: false,
    managerOptions: { storagePath: false, autoDiscover: true, discovery: { home, env: {}, projects: false } } });
  registry.register(provider.descriptor);
  t.after(async () => {
    await provider.close();
    await agent.mcpSources.stop();
    await new Promise<void>(resolve => { agent.server.close(() => resolve()); agent.server.closeAllConnections(); });
    await fs.rm(home, { recursive: true, force: true });
  });
  let skills: { name: string }[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    skills = (await (await fetch(`${base}/skills`)).json() as { skills: { name: string }[] }).skills;
    if (skills.some(skill => skill.name === 'auto-scene')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(skills.some(skill => skill.name === 'auto-scene'));
  assert.equal(agent.registry.list().length, 1);
  const found = await callDreammateTool('dreammate_search_skills', { query: 'lighting', node: 'localhost' }, { agentUrl: base, embeddingUrl: '' });
  assert.equal(found.isError, undefined);
  assert.ok((found.structuredContent!.results as { name: string }[]).some(skill => skill.name === 'auto-scene'));
  const discovered = await fetch(`${base}/skills/sources/discover`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projects: false }) });
  assert.equal(discovered.status, 200);
  assert.equal((await discovered.json() as { project_status: string }).project_status, 'skipped');
  const invalid = await fetch(`${base}/skills/sources/discover`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionCommand: 'untrusted-command' }) });
  assert.equal(invalid.status, 400, 'network callers cannot configure a discovery subprocess');
});
