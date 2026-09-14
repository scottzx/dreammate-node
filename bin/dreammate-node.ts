#!/usr/bin/env node
/**
 * 本机 node agent。
 *
 *   dreammate-node                    监听 0.0.0.0:36908
 *   dreammate-node --host 127.0.0.1   只对本机可见
 *   dreammate-node --port 40000       换端口（探测方就找不到了，仅调试用）
 */
import { nodeIdentity } from '../src/identity.js';
import { NODE_AGENT_PORT, serveAgent } from '../src/server.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`dreammate-node — DreamMate Network 本机 node agent

  dreammate-node [--host 0.0.0.0] [--port ${NODE_AGENT_PORT}]

  GET  /manifest    本机聚合视图：节点身份 + 所有已报备的服务
  GET  /health
  GET  /services    各服务的存活与可达性
  POST /services    服务报备（仅接受 localhost）
  DELETE /services/:id

端口 ${NODE_AGENT_PORT} 是协议固定的：外部节点靠探这一个端口找到这台机器上的一切。`);
  process.exit(0);
}

const port = Number(flag('port') ?? NODE_AGENT_PORT);
const host = flag('host') ?? '0.0.0.0';

const { registry } = await serveAgent({ port, host });
const identity = await nodeIdentity();
console.log(`dreammate-node — ${identity.name} (${identity.node_id})  [${identity.source}]`);
console.log(`  http://${host}:${port}/manifest`);
console.log(`  服务报备仅接受 localhost；已注册 ${registry.list().length} 个服务`);
