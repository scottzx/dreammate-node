import { parseArgs } from 'node:util';

const cliCleanups = new Set<() => Promise<void>>();
let cliFinishing = false;

/** Own private subprocesses even if the command deadline fires during initialization. */
export function registerCliCleanup(cleanup: () => Promise<void>): () => void {
  if (cliFinishing) { void cleanup().catch(() => {}); return () => {}; }
  cliCleanups.add(cleanup);
  return () => { cliCleanups.delete(cleanup); };
}

export function cliIsFinishing(): boolean { return cliFinishing; }

export const CLI_OPTIONS = {
  agent: { type: 'string' }, node: { type: 'string' },
  'mcp-config': { type: 'string' },
  'nodes-file': { type: 'string' }, live: { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  file: { type: 'string' }, 'default-node': { type: 'string' },
  service: { type: 'string' }, method: { type: 'string' },
  skill: { type: 'string' }, params: { type: 'string' },
  source: { type: 'string' }, revision: { type: 'string' }, resource: { type: 'string' },
  query: { type: 'string' }, keyword: { type: 'string' }, kind: { type: 'string' }, action: { type: 'string' },
  limit: { type: 'string' }, offset: { type: 'string' }, 'max-chars': { type: 'string' },
  'include-disabled': { type: 'boolean' }, all: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export function cliError(message: string, code = 'CLI_ERROR'): void {
  const data = { error: message, code };
  console.log(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true }));
  console.error(JSON.stringify(data));
}

/** Executable boundary only: library/MCP callers must retain their own process. */
export async function runCliProcess(argv: string[]): Promise<never> {
  let finishing: Promise<never> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number): Promise<never> => finishing ??= (async () => {
    cliFinishing = true;
    clearTimeout(timer);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', terminated);
    await Promise.allSettled([...cliCleanups].map(cleanup => cleanup()));
    cliCleanups.clear();
    // process.exit alone can truncate pipe output. Drain both streams first.
    await Promise.all([process.stdout, process.stderr].map(stream =>
      new Promise<void>(resolve => stream.write('', () => resolve()))));
    process.exit(code);
  })();
  const interrupt = (code: number) => {
    if (cliFinishing) return;
    cliError('命令被中断；调用结果未知，写操作请先核对远端结果，不要自动重试', 'COMMAND_INTERRUPTED');
    void finish(code);
  };
  const interrupted = () => interrupt(130);
  const terminated = () => interrupt(143);
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);

  let timeoutMs: number;
  try {
    const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: CLI_OPTIONS });
    timeoutMs = values['timeout-ms'] === undefined ? (positionals[0] === 'invoke' ? 150_000 : 30_000)
      : Number(values['timeout-ms']);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new Error('--timeout-ms 必须是 1–3600000 之间的整数');
    }
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 'INVALID_ARGUMENT');
    return finish(2);
  }
  // A referenced timer also prevents unref'ed fetch timeout signals from letting
  // an idle runtime exit before it has produced a result.
  timer = setTimeout(() => {
    cliError(`命令超过 ${timeoutMs} ms；调用结果未知，写操作请先核对远端结果，不要自动重试`, 'COMMAND_TIMEOUT');
    void finish(1);
  }, timeoutMs);
  try {
    const { runCli } = await import('./cli.js');
    return finish(await runCli(argv));
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error));
    return finish(1);
  }
}
