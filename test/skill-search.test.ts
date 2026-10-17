import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { searchSkills, type DiscoveredSkill } from '../src/tool-search.js';

const visual: DiscoveredSkill = {
  id: 'skills-tesla:visual', source_id: 'skills-tesla', node: 'mac', name: 'threejs-visual-iteration',
  description: 'Improve an existing Three.js scene with lighting, materials and screenshot review.', revision: 'a'.repeat(64),
};
const cad: DiscoveredSkill = {
  id: 'skills-cad:extract', source_id: 'skills-cad', node: 'pc', name: 'cad-to-threejs',
  description: 'Extract architectural geometry from DXF and rebuild CAD drawings in Three.js.', revision: 'b'.repeat(64),
};

test('skill search ranks independent summaries, preserves node/revision, and filters sources', async () => {
  const result = await searchSkills([cad, visual, { ...visual, node: 'second-mac' }], { query: 'threejs-visual-iteration' }, { embeddingProviders: [] });
  const cards = result.results as Record<string, unknown>[];
  assert.deepEqual(new Set(cards.slice(0, 2).map(card => card.node)), new Set(['mac', 'second-mac']));
  assert.ok(cards.slice(0, 2).every(card => card.id === visual.id));
  assert.equal(cards[0]!.revision, visual.revision);
  assert.equal(cards[0]!.method, undefined);
  assert.equal(cards[0]!.service_id, undefined);
  const scoped = await searchSkills([cad, visual], { query: 'Three.js', source_id: 'skills-cad' }, { embeddingProviders: [] });
  assert.deepEqual((scoped.results as DiscoveredSkill[]).map(card => card.id), [cad.id]);
});

test('skill search shares semantic ranking for cross-language tasks and falls back when model fails', async () => {
  let unavailable = false;
  const documentBatches: string[][] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const data = JSON.parse(Buffer.concat(chunks).toString()) as { texts: string[]; input_type: string };
      if (unavailable) { res.writeHead(503); res.end(); return; }
      if (data.input_type === 'document') documentBatches.push(data.texts);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'skill-fixture-v1', embeddings: data.texts.map(text =>
        data.input_type === 'query' || text.includes('threejs-visual-iteration') ? [1, 0] : [0, 1]) }));
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/embed`;
  try {
    const result = await searchSkills([cad, visual], { query: '改善场景的灯光效果' }, { embeddingUrl: url });
    assert.equal((result.search as Record<string, unknown>).mode, 'hybrid');
    assert.equal((result.results as DiscoveredSkill[])[0]!.id, visual.id);
    assert.ok(documentBatches.flat().every(text => text.startsWith('Skill: ')));
    // Metadata vectors are reusable, while a fresh query still checks provider availability.
    unavailable = true;
    const fallback = await searchSkills([cad, visual], { query: 'DXF' }, { embeddingUrl: url });
    assert.equal((fallback.search as Record<string, unknown>).mode, 'lexical');
    assert.equal((fallback.search as Record<string, unknown>).semantic_status, 'unavailable');
    assert.equal((fallback.results as DiscoveredSkill[])[0]!.id, cad.id);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

test('skill search budgets complete responses and advances pages over oversized summaries', async () => {
  const skills = Array.from({ length: 6 }, (_, index) => ({ ...visual,
    id: `skills-tesla:${index}`, name: `visual-${index}`, description: `lighting ${'detail '.repeat(130)}`,
  }));
  const result = await searchSkills(skills, { query: 'lighting', limit: 2, max_chars: 1000 }, { embeddingProviders: [] });
  assert.ok(JSON.stringify(result, null, 2).length <= 1000);
  assert.ok((result.next_offset as number) > 0);
  await assert.rejects(searchSkills(skills, { query: ' ' }), /query/);
  await assert.rejects(searchSkills(skills, { query: 'lighting', limit: 21 }), /limit/);
});
