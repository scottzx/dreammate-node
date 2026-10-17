import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));
const revision = 'a'.repeat(64);

async function cli(args: string[], agent = '', mode: 'skills' | 'cli' = 'skills') {
  const home = await mkdtemp(path.join(tmpdir(), 'dreammate-skill-cli-'));
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(process.execPath, ['--import', 'tsx', executable, mode, ...args], {
        env: { ...process.env, HOME: home, DREAMMATE_AGENT_URL: agent, DREAMMATE_NODES_FILE: '', TSX_DISABLE_CACHE: '1' },
        timeout: 10_000,
      }, (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number')) return reject(error);
        resolve({ code: error?.code as number ?? 0, stdout, stderr });
      });
      child.stdin!.end();
    });
    assert.deepEqual(await readdir(home), [], 'one-shot commands must not create local agent state');
    return { ...result, home };
  } finally { await rm(home, { recursive: true, force: true }); }
}

async function gateway(handler: RequestListener, body: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('skills help includes source management and preserves built-in installer help', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /add --name NAME --project PATH/);
  assert.match(help.stdout, /install \[--profile auto\|ish\|terminal\]/);
  const install = await cli(['install', '--help']);
  assert.equal(install.code, 0);
  assert.match(install.stdout, /只复制本包自带 skill/);
});

test('skills add sends project or directory source paths resolved on the calling device', async () => {
  const bodies: Record<string, unknown>[] = [];
  await gateway(async (req, res) => {
    assert.equal(req.url, '/skills/sources');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.end('{"id":"skills-tesla","status":"ready","skill_count":2}');
  }, async url => {
    const project = await cli(['add', '--name', 'tesla', '--project', '.'], url);
    assert.equal(project.code, 0, project.stdout);
    assert.deepEqual(bodies[0], { name: 'tesla', project: process.cwd() });
    const directory = await cli(['add', '--name', 'visual', '--dir', '~/.agents/skills', '--agent', url], 'http://192.0.2.1');
    assert.equal(directory.code, 0, directory.stdout);
    assert.deepEqual(bodies[1], { name: 'visual', dir: path.join(directory.home, '.agents/skills') });
  });
});

test('skills list, remove and refresh use independent source routes', async () => {
  const requests: string[] = [];
  await gateway((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.end(req.method === 'DELETE' ? '{"removed":"skills-tesla"}' : '{"sources":[]}');
  }, async url => {
    for (const args of [['list'], ['remove', 'skills-tesla'], ['refresh', 'skills-tesla'], ['refresh']]) {
      assert.equal((await cli(args, url)).code, 0);
    }
    assert.deepEqual(requests, ['GET /skills/sources', 'DELETE /skills/sources/skills-tesla',
      'POST /skills/sources/skills-tesla/refresh', 'POST /skills/sources/refresh']);
  });
});

test('skills discover requests shared and optional session workspace discovery through the local gateway', async () => {
  const requests: { route: string; body: unknown }[] = [];
  await gateway(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ route: `${req.method} ${req.url}`, body: JSON.parse(body) });
    res.end('{"added":2,"existing":0,"project_status":"skipped","diagnostics":[]}');
  }, async url => {
    assert.equal((await cli(['discover'], url)).code, 0);
    assert.equal((await cli(['discover', '--no-projects'], url)).code, 0);
    assert.deepEqual(requests, [
      { route: 'POST /skills/sources/discover', body: { projects: true } },
      { route: 'POST /skills/sources/discover', body: { projects: false } },
    ]);
  });
});

test('skills rejects malformed commands, paths and remote management before HTTP', async () => {
  let requests = 0;
  await gateway((_req, res) => { requests++; res.end('{}'); }, async url => {
    for (const args of [
      ['unknown'], ['add'], ['add', '--name', 'tesla'], ['add', '--name', 'tesla', '--dir', 'x', '--project', 'y'],
      ['add', '--name', '../tesla', '--project', '.'], ['add', '--name', 'tesla', '--dir', ''],
      ['add', '--name', 'tesla', '--dir', '~someone/skills'], ['list', 'extra'], ['list', '--dir', '.'],
      ['remove'], ['remove', '../source'], ['remove', 'mcp-tesla'], ['refresh', 'skills-tesla', 'extra'],
      ['discover', 'extra'], ['discover', '--dir', '.'], ['list', '--no-projects'],
      ['list', '--timeout-ms', '1.5'], ['list', '--timeout-ms', '3600001'], ['list', '--unknown', 'x'],
      ['list', '--agent', 'https://example.com'], ['list', '--agent', 'http://192.168.1.2:36908'],
      ['list', '--agent', 'http://user:password@127.0.0.1:36908'], ['list', '--agent', `${url}/?query=x`],
    ]) {
      const result = await cli(args, url);
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(JSON.parse(result.stdout).isError, true);
    }
    assert.equal(requests, 0);
  });
});

test('skills handles source errors, invalid JSON, redirects and deadlines without replaying requests', async () => {
  let mode = 'source';
  let redirected = 0;
  await gateway((req, res) => {
    if (req.url === '/redirected') { redirected++; res.end('{}'); }
    else if (mode === 'source') res.end('{"sources":[{"status":"error","error":"unreadable source"}]}');
    else if (mode === 'http') { res.statusCode = 503; res.end('{"error":"unavailable"}'); }
    else if (mode === 'json') res.end('invalid JSON');
    else if (mode === 'diagnostics') res.end('{"skills":[],"diagnostics":[{"source_id":"skills-tesla","error":"missing directory"}]}');
    else if (mode === 'redirect') { res.statusCode = 307; res.setHeader('location', '/redirected'); res.end(); }
    // timeout mode intentionally leaves the response pending.
  }, async url => {
    const failed = await cli(['list'], url);
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).sources[0].status, 'error');
    for (mode of ['http', 'json', 'redirect', 'diagnostics']) assert.equal((await cli(['list'], url)).code, 1, mode);
    assert.equal(redirected, 0);
    mode = 'timeout';
    const timeout = await cli(['list', '--timeout-ms', '50'], url);
    assert.equal(timeout.code, 1);
    assert.match(timeout.stdout, /50 ms/);
  });
});

test('one-shot skill commands reject unsupported flags and invalid read versions before HTTP', async () => {
  let requests = 0;
  await gateway((_req, res) => { requests++; res.end('{}'); }, async url => {
    for (const args of [
      ['search-skills'], ['search-skills', '--query', ' '], ['search-skills', '--query', 'x', '--source', '../source'],
      ['search-skills', '--query', 'x', '--revision', revision], ['search-skills', '--query', 'x', '--resource', 'SKILL.md'],
      ['search-skills', '--query', 'x', '--service', 'tesla'], ['search-skills', '--query', 'x', '--limit', '21'],
      ['read-skill', '--skill', 'skills-tesla:visual'], ['read-skill', '--revision', revision],
      ['read-skill', '--skill', 'skills-tesla:visual', '--revision', 'old-version'],
      ['read-skill', '--skill', 'skills-tesla:visual', '--revision', revision, '--source', 'skills-tesla'],
      ['read-skill', '--skill', 'skills-tesla:visual', '--revision', revision, '--node', 'all'],
      ...['../private', '/etc/passwd', 'C:/private', 'scripts\\run.py', 'a/./b', 'a//b', ''].map(resource =>
        ['read-skill', '--skill', 'skills-tesla:visual', '--revision', revision, '--resource', resource]),
    ]) {
      const result = await cli(args, url, 'cli');
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(JSON.parse(result.stdout).isError, true);
    }
    assert.equal(requests, 0);
  });
});

test('one-shot skill search defaults to network discovery and passes source filters and budgets', async () => {
  const requests: string[] = [];
  const skill = { id: 'skills-tesla:visual', source_id: 'skills-tesla', name: 'threejs-visual-iteration',
    description: 'Improve Three.js visual materials and rendering', revision };
  await gateway((req, res) => {
    requests.push(req.url!);
    if (req.url === '/nodes') res.end(JSON.stringify({ node: 'remote', nodes: [
      { node_id: 'remote-id', name: 'remote', type: 'linux', is_self: true, online: true, network_online: true },
    ] }));
    else if (req.url?.startsWith('/skills?')) res.end(JSON.stringify({ node: 'remote', skills: [skill,
      { ...skill, id: 'skills-other:visual', source_id: 'skills-other' }], diagnostics: [], has_more: false, next_offset: null }));
    else if (req.url === '/services') res.end('{"node":"remote","services":[]}');
    else { res.statusCode = 404; res.end('{}'); }
  }, async url => {
    const result = await cli(['search-skills', '--query', ' visual ', '--source', 'skills-tesla',
      '--limit', '1', '--offset', '0', '--max-chars', '1500'], url, 'cli');
    assert.equal(result.code, 0, result.stdout);
    const data = JSON.parse(result.stdout).structuredContent;
    assert.equal(data.scope, 'all');
    assert.equal(data.limit, 1);
    assert.equal(data.offset, 0);
    assert.equal(data.max_chars, 1500);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].source_id, 'skills-tesla');
    assert.equal(data.results[0].revision, revision);
    assert.ok(JSON.stringify(data, null, 2).length <= 1500);
    assert.ok(requests.includes('/nodes'));
    assert.ok(requests.includes('/skills?limit=200&offset=0'));
    requests.length = 0;
    assert.equal((await cli(['search-skills', '--query', 'visual', '--node', 'localhost'], url, 'cli')).code, 0);
    assert.ok(!requests.includes('/nodes'));
    requests.length = 0;
    assert.equal((await cli(['search-skills', '--query', 'visual', '--node', 'all'], url, 'cli')).code, 0);
    assert.ok(requests.includes('/nodes'));
  });
});

test('one-shot skill reads preserve source JSON and report revision conflicts as business errors', async () => {
  const requests: string[] = [];
  let conflict = false;
  const resultBody = { id: 'skills-tesla:visual', source_id: 'skills-tesla', name: 'visual', revision,
    resource: 'references/stages.md', content: '# Visual workflow\nRead complete instructions.', encoding: 'utf8', resources: [] };
  await gateway((req, res) => {
    requests.push(req.url!);
    if (conflict) { res.statusCode = 409; res.end('{"error":"Skill version changed","code":"SKILL_REVISION_CHANGED"}'); }
    else res.end(JSON.stringify(resultBody));
  }, async url => {
    const args = ['read-skill', '--skill', 'skills-tesla:visual', '--revision', revision.toUpperCase(),
      '--resource', 'references/stages.md', '--node', 'localhost'];
    const read = await cli(args, url, 'cli');
    assert.equal(read.code, 0, read.stdout);
    const data = JSON.parse(read.stdout).structuredContent;
    for (const [key, value] of Object.entries(resultBody)) assert.deepEqual(data[key], value);
    assert.equal(data.node, 'localhost');
    assert.equal(data.origin_gateway, url);
    assert.equal(data.execution.performed, false);
    assert.equal(requests[0], `/skills/skills-tesla%3Avisual?revision=${revision}&resource=references%2Fstages.md`);
    const main = await cli(['read-skill', '--skill', 'skills-tesla:visual', '--revision', revision], url, 'cli');
    assert.equal(main.code, 0, main.stdout);
    assert.equal(requests[1], `/skills/skills-tesla%3Avisual?revision=${revision}`);
    conflict = true;
    const failed = await cli(args, url, 'cli');
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).isError, true);
    assert.equal(JSON.parse(failed.stdout).structuredContent.http_status, 409);
    assert.match(failed.stdout, /SKILL_REVISION_CHANGED/);
    assert.equal(requests.length, 3);
    const tools = JSON.parse((await cli(['tools'], '', 'cli')).stdout).tools as { name: string }[];
    assert.ok(tools.some(tool => tool.name === 'dreammate_search_skills'));
    assert.ok(tools.some(tool => tool.name === 'dreammate_read_skill'));
  });
});
