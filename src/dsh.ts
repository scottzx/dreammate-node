/** Package-root Cordis entry. DSH loads this module; the plugin body stays unloaded until apply. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'dreammate-node';
export const inject = ['tools'];

interface EmbeddedPlugin {
  apply: (ctx: unknown, input?: Record<string, unknown>) => Promise<void>;
}

function isPackageRoot(dir: string): boolean {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
    return manifest.name === '@1agents/dreammate-node';
  } catch {
    return false;
  }
}

/** Resolve vendor/dsh from either src/ (tsx) or dist/src/ (published entry). */
export function pluginEntry(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 6; i += 1) {
    if (isPackageRoot(dir)) {
      const entry = join(dir, 'vendor/dsh/index.js');
      if (!existsSync(entry)) {
        throw new Error('Embedded DSH plugin is missing. Run npm run build before activating @1agents/dreammate-node in DSH.');
      }
      return pathToFileURL(entry).href;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find the @1agents/dreammate-node package root');
}

export async function apply(ctx: unknown, input: Record<string, unknown> = {}): Promise<void> {
  const plugin = await import(pluginEntry()) as EmbeddedPlugin;
  await plugin.apply(ctx, input);
}
