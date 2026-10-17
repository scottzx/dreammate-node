#!/usr/bin/env node
/**
 * DreamMate Network 本机 node agent。
 *
 *   dreammate-node                前台跑
 *   dreammate-node install        装成开机自启的常驻服务
 *   dreammate-node status         看服务与端口状态
 *   dreammate-node uninstall      卸载
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORTS } from '@1agents/dreammate-network';

const NODE_AGENT_PORT = DEFAULT_PORTS['node-agent'];

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'run';
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const USAGE = `dreammate-node — DreamMate Network 本机 node agent

  dreammate-node [--host 0.0.0.0] [--port ${NODE_AGENT_PORT}]   前台跑
  dreammate-node cli <nodes|search|search-skills|read-skill|services|inspect|invoke|manage|tools>  一次性调用（cli --help）
  dreammate-node mcp [--agent http://127.0.0.1:${NODE_AGENT_PORT}] [--mcp-config PATH|none]
                                                           MCP Stdio；私有配置默认 ~/.1agents/mcp-client.json
  dreammate-node mcp add --config JSON | --file PATH|-        添加本地/远程 MCP，自动发现工具
  dreammate-node mcp list|remove ID|refresh ID                管理本机自定义 MCP 数据源
  dreammate-node mcp share ID --scope local|network           单独修改共享范围（默认 network）
  dreammate-node install [--host ...] [--port ...]          装成常驻服务（开机自启）
  dreammate-node status                                     服务与端口状态
  dreammate-node uninstall                                  卸载
  dreammate-node embedding install|status|config|uninstall   管理按需本地向量模型（macOS）
  dreammate-node skills install [--profile auto|ish|terminal]  安装/更新对应环境的 skill
  dreammate-node skills add --name NAME --project PATH|--dir PATH  登记本机 Skill 来源
  dreammate-node skills list|remove ID|refresh [ID]          管理来源与检索索引（skills --help）

  GET  /manifest    本机聚合视图：节点身份 + 当前调用方可见的服务
  GET  /health
  GET  /services    各服务的存活与可达性
  POST /services    服务报备（仅接受 localhost）
  DELETE /services/:id
  POST /services/:id/invoke  调用指定服务的方法/能力

端口 ${NODE_AGENT_PORT} 是协议固定的：外部节点靠探这一个端口，就能知道这台机器上有什么。
install 在 macOS 上装 launchd LaunchAgent、Linux 上装 systemd user unit，都不需要 sudo。`;

const sourceCommand = command === 'mcp' && ['add', 'list', 'remove', 'refresh', 'share'].includes(argv[1] ?? '');
if (!['cli', 'skills', 'embedding'].includes(command) && !sourceCommand && (argv.includes('--help') || argv.includes('-h') || command === 'help')) {
  console.log(USAGE);
  process.exit(0);
}

const port = Number(flag('port') ?? NODE_AGENT_PORT);
const host = flag('host') ?? '0.0.0.0';
// 装进服务的必须是编译产物；用 tsx 跑源码时这里会是 .ts，installService 会拦住。
const entry = fileURLToPath(import.meta.url);

try {
  switch (command) {
    case 'embedding': {
      const managerUrl = new URL(entry.endsWith('.ts') ? '../scripts/local-embeddings/manage.mjs' : '../../scripts/local-embeddings/manage.mjs', import.meta.url);
      const { main } = await import(managerUrl.href);
      const code = await main(argv.slice(1));
      if (typeof code === 'number') process.exitCode = code;
      break;
    }

    case 'skills': {
      if (argv[1] !== 'install') {
        const { runSkillSourceCli } = await import('../src/skill-source-cli.js');
        process.exitCode = await runSkillSourceCli(argv.slice(1));
        break;
      }
      // npm postinstall must also work in an unbuilt source checkout.
      const installerUrl = new URL(entry.endsWith('.ts') ? '../scripts/install-skills.mjs' : '../../scripts/install-skills.mjs', import.meta.url);
      const { runInstaller } = await import(installerUrl.href);
      process.exitCode = runInstaller(argv.slice(2));
      break;
    }

    case 'cli': {
      const { runCliProcess } = await import('../src/cli-process.js');
      await runCliProcess(argv.slice(1));
      break;
    }

    case 'mcp': {
      if (sourceCommand) {
        const { runMcpSourceCli } = await import('../src/mcp-source-cli.js');
        process.exitCode = await runMcpSourceCli(argv.slice(1));
        break;
      }
      if (argv[1] && !argv[1].startsWith('-')) {
        throw new Error('MCP 子命令必须是 add、list、remove、refresh 或 share；不带子命令启动 Stdio 网关');
      }
      const { runMcpServer } = await import('../src/mcp.js');
      const { values } = parseArgs({ args: argv.slice(1), strict: true, options: {
        agent: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, 'mcp-config': { type: 'string' },
      } });
      const agentUrl = values.agent ?? `http://127.0.0.1:${values.port ?? port}`;
      await runMcpServer({ agentUrl, mcpConfig: values['mcp-config'] });
      break;
    }

    case 'install': {
      const { installService } = await import('../src/service.js');
      const result = await installService({ host, port, script: entry }, entry);
      console.log(`✅ 已安装为常驻服务（${result.platform}）`);
      console.log(`   ${result.file}`);
      console.log(`   http://${host}:${port}/manifest`);
      for (const note of result.notes) console.log(`   ⚠️  ${note}`);
      break;
    }

    case 'uninstall': {
      const { uninstallService } = await import('../src/service.js');
      const result = await uninstallService();
      console.log(result.removed ? `✅ 已卸载（${result.platform}）\n   ${result.file}` : `未安装（${result.platform}）`);
      break;
    }

    case 'status': {
      const { serviceStatus } = await import('../src/service.js');
      const s = await serviceStatus(port);
      console.log(`平台       ${s.platform}`);
      console.log(`已安装     ${s.installed ? '是' : '否'}  ${s.installed ? s.file : ''}`);
      console.log(`服务管理器 ${s.managerSays}`);
      // 管理器说 running 不代表端口通——这正是 Node 在线 ≠ Service 在线的同一回事。
      console.log(`HTTP /health :${s.port}  ${s.responding ? '成功' : '失败'}`);
      if (s.installed && !s.responding) {
        console.log(`\n服务已安装但端口无应答，看日志：~/.1agents/logs/dreammate-node.err.log`);
        process.exitCode = 1;
      }
      break;
    }

    case 'run': {
      const { serveAgent } = await import('../src/server.js');
      const { nodeIdentity } = await import('../src/identity.js');
      const { server, registry, mcpSources, rebuilt } = await serveAgent({ port, host });
      let stopping = false;
      const shutdown = (): void => {
        if (stopping) return;
        stopping = true;
        registry.stop();
        const deadline = setTimeout(() => process.exit(1), 5000);
        deadline.unref();
        void mcpSources.stop().finally(() => {
          server.close(() => { clearTimeout(deadline); });
          server.closeIdleConnections();
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      const identity = await nodeIdentity();
      console.log(`dreammate-node — ${identity.name} (${identity.node_id})  [${identity.source}]`);
      console.log(`  http://${host}:${port}/manifest`);
      console.log(
        `  服务报备仅接受 localhost；已注册 ${registry.list().length} 个服务` +
          (rebuilt > 0 ? `（其中 ${rebuilt} 个是扫约定端口捡回来的）` : ''),
      );
      break;
    }

    default:
      console.error(`未知命令：${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
} catch (error: unknown) {
  console.error(`dreammate-node: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
