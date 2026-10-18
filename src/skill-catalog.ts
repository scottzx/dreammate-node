import { withRequestTimeout } from './request-timeout.js';
import type { SkillSummary } from './skill-sources.js';

export interface SkillCatalogScan {
  node: string;
  url: string;
  status: 'ok' | 'http_error' | 'timeout' | 'unreachable' | 'invalid_response' | 'unsupported';
  checked_at: string;
  http_status?: number;
  error?: string;
  catalog_truncated?: boolean;
  diagnostics_count?: number;
}

interface Page { skills?: unknown; has_more?: unknown; next_offset?: unknown; diagnostics?: unknown }

function summaries(data: Page, node: string): (SkillSummary & { node: string })[] {
  if (!data || !Array.isArray(data.skills) || data.skills.length > 200) throw new SyntaxError('Invalid skill catalog');
  return data.skills.map(raw => {
    const skill = raw as Record<string, unknown> | null;
    if (!skill || typeof skill.id !== 'string' || !skill.id || skill.id.length > 256
      || typeof skill.source_id !== 'string' || !/^skills-[A-Za-z0-9_-]{1,64}$/.test(skill.source_id)
      || typeof skill.name !== 'string' || !skill.name || skill.name.length > 128
      || typeof skill.description !== 'string' || !skill.description || skill.description.length > 4096
      || typeof skill.revision !== 'string' || !/^[a-f0-9]{64}$/.test(skill.revision)
      || (skill.scope !== undefined && !['user', 'system', 'project'].includes(String(skill.scope)))
      || (skill.compatibility !== undefined && (typeof skill.compatibility !== 'string' || skill.compatibility.length > 1024))) {
      throw new SyntaxError('Invalid skill summary');
    }
    return { id: skill.id, source_id: skill.source_id, name: skill.name, description: skill.description,
      revision: skill.revision, node,
      ...(skill.scope !== undefined ? { scope: skill.scope as SkillSummary['scope'] } : {}),
      ...(typeof skill.compatibility === 'string' ? { compatibility: skill.compatibility } : {}) };
  });
}

/** A bounded traversal; slow later pages never erase validated earlier pages. */
export async function scanSkillCatalog(url: string, node: string,
  { pageTimeoutMs = 10_000, totalTimeoutMs = 30_000 } = {}) {
  const scan: SkillCatalogScan = { node, url, status: 'ok', checked_at: new Date().toISOString() };
  const skills: (SkillSummary & { node: string })[] = [];
  const deadline = performance.now() + totalTimeoutMs;
  let offset = 0;
  try {
    for (let page = 0; page < 5; page++) {
      let response: { status: number; data?: Page } | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new DOMException('Skill catalog total deadline exceeded', 'TimeoutError');
        try {
          response = await withRequestTimeout(async signal => {
            const res = await fetch(`${url}/skills?limit=200&offset=${offset}`, { signal, redirect: 'error' });
            scan.http_status = res.status;
            if (!res.ok) { await res.body?.cancel(); return { status: res.status }; }
            return { status: res.status, data: await res.json() as Page };
          }, Math.min(pageTimeoutMs, remaining));
          if (![502, 503, 504].includes(response.status) || attempt === 1) break;
        } catch (error) {
          if (!(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) || attempt === 1) throw error;
        }
        // Only replay a read of this same page, never a mutation or a full scan.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(100, deadline - performance.now()))));
      }
      if (!response) throw new DOMException('Skill catalog page timed out', 'TimeoutError');
      if (!response.data) {
        scan.status = response.status === 404 && skills.length === 0 ? 'unsupported' : 'http_error';
        return { scan, skills };
      }
      const data = response.data;
      const rows = summaries(data, node);
      // Validate an entire page before making any of it visible.
      skills.push(...rows);
      if (Array.isArray(data.diagnostics) && data.diagnostics.length) scan.diagnostics_count = data.diagnostics.length;
      if (!data.has_more) return { scan, skills };
      if (typeof data.next_offset !== 'number' || !Number.isSafeInteger(data.next_offset) || data.next_offset <= offset) {
        throw new SyntaxError('Invalid skill catalog cursor');
      }
      offset = data.next_offset;
    }
    scan.catalog_truncated = true;
  } catch (error) {
    scan.status = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout'
      : error instanceof SyntaxError ? 'invalid_response' : 'unreachable';
    scan.error = error instanceof Error ? error.message : String(error);
  }
  return { scan, skills };
}
