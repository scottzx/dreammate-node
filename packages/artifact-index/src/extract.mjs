import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../python/extract.py', import.meta.url));
export const PARSER_VERSION = 'artifact-local-v1';

async function fileHash(file) {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}

function runPython(python, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024 * 1024;
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: {
      ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    } });
    let output = [], size = 0, errors = '', settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Local extraction exceeded timeout (${timeoutMs} ms)`)), timeoutMs);
    child.on('error', fail);
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') fail(error); });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes) return fail(new Error(`Local extraction exceeded output budget (${maxOutputBytes} bytes)`));
      output.push(chunk);
    });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk.toString('utf8')).slice(-16384); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Local extraction failed: ${errors.trim() || `Python exited ${code}`}`));
      try { resolveResult(JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { reject(new Error(`Local extractor returned invalid JSON: ${errors.trim()}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Extract local artifacts without downloading models or contacting any service. */
export async function extractArtifact(file, options = {}) {
  if (typeof file !== 'string' || !file || /^[a-z][a-z0-9+.-]*:\/\//i.test(file)) throw new TypeError('A local file path is required');
  const source = resolve(file);
  const info = await stat(source);
  if (!info.isFile()) throw new TypeError('Artifact source must be a regular file');
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024 * 1024;
  if (info.size > maxFileBytes) throw new Error(`Artifact exceeds file size budget (${maxFileBytes} bytes)`);
  const root = options.cacheDir ?? join(homedir(), '.1agents', 'artifacts', 'extracted');
  if (!isAbsolute(root)) throw new TypeError('cacheDir must be an absolute path');
  const contentHash = await fileHash(source);
  const variant = createHash('sha256').update(JSON.stringify({ version: PARSER_VERSION, visual: options.visual !== false,
    renderDpi: options.renderDpi ?? 100, segmentMs: options.segmentMs ?? 6000, overlapMs: options.overlapMs ?? 1000,
    videoFps: options.videoFps ?? 2, videoMaxDimension: options.videoMaxDimension ?? 720 })).digest('hex').slice(0, 12);
  const cacheDir = join(root, contentHash, variant);
  await mkdir(cacheDir, { recursive: true });
  return runPython(options.python ?? 'python3', { operation: 'extract', file: source, cacheDir, options }, options);
}

/** Report capabilities; this never installs dependencies or loads a model. */
export async function doctor(options = {}) {
  return runPython(options.python ?? 'python3', { operation: 'doctor' }, { timeoutMs: options.timeoutMs ?? 30_000 });
}

export const extractionDoctor = doctor;
