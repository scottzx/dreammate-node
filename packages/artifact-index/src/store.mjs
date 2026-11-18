import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_VERSION, hash, stableJSON, normalizeProfile, profileFingerprint, vectorToBlob } from './schema.mjs';

export class ArtifactStore {
  constructor(dbPath) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Artifact index schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
      if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`Unsupported artifact index schema ${version}`);
      if (version === 0) this.initialize();
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch (error) { this.db.close(); throw error; }
  }

  initialize() {
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
        source_node TEXT NOT NULL, source_uri TEXT NOT NULL, canonical_path TEXT NOT NULL,
        kind TEXT NOT NULL, mime TEXT NOT NULL, title TEXT NOT NULL,
        revision TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
        sharing TEXT NOT NULL, parser_version TEXT NOT NULL, indexed_at TEXT NOT NULL,
        warnings_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', last_error TEXT,
        UNIQUE(source_node, canonical_path)
      );
      CREATE TABLE units (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, locator_json TEXT NOT NULL, text TEXT NOT NULL, ordinal INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(resource_id, ordinal)
      );
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, metadata_json TEXT NOT NULL
      );
      CREATE TABLE vectors (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
        content_hash TEXT NOT NULL, modality TEXT NOT NULL, data BLOB NOT NULL,
        UNIQUE(profile_id, content_hash, modality)
      );
      CREATE TABLE representations (
        id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
        modality TEXT NOT NULL, content_hash TEXT NOT NULL,
        text TEXT, path TEXT, vector_id TEXT REFERENCES vectors(id),
        error TEXT, UNIQUE(unit_id, modality, content_hash)
      );
      CREATE INDEX units_resource ON units(resource_id);
      CREATE INDEX representations_unit ON representations(unit_id);
      CREATE INDEX representations_vector ON representations(vector_id);
      CREATE INDEX resources_filter ON resources(kind, sharing);
      PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  }

  resource(id) { return this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id); }
  markFailure(id, error, stale = true) {
    this.db.prepare("UPDATE resources SET status = CASE WHEN ? THEN 'stale' ELSE status END, last_error = ? WHERE id = ?").run(stale ? 1 : 0, error, id);
  }
  cachedVectors(contentHash, modality) {
    return this.db.prepare(`SELECT v.*, p.metadata_json FROM vectors v JOIN profiles p ON p.id = v.profile_id WHERE v.content_hash = ? AND v.modality = ?`).all(contentHash, modality)
      .map(row => ({ ...row, profile: JSON.parse(row.metadata_json) }));
  }

  /** True when a resource still has text representations without a vector. */
  hasPendingVectors(resourceId) {
    // A representation marked as disabled is not pending: the run deliberately
    // produced no vector for it. A failed attempt, however, must be retried.
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM representations rp JOIN units u ON u.id = rp.unit_id WHERE u.resource_id = ? AND rp.modality = 'text' AND rp.vector_id IS NULL AND (rp.error IS NULL OR rp.error <> 'embedding_disabled')`).get(resourceId);
    return row.n > 0;
  }

  /**
   * Another ready resource holding the same bytes and parser version. A copy
   * of an already parsed document can adopt its units instead of being parsed
   * again; the copy keeps its own path, sharing and title.
   */
  twin(revision, parserVersion, excludePath) {
    return this.db.prepare(`SELECT * FROM resources WHERE revision = ? AND parser_version = ? AND status = 'ready'
      AND canonical_path <> ? ORDER BY indexed_at, id LIMIT 1`).get(revision, parserVersion, excludePath);
  }

  /** Stored units plus their representations, for adopting a parsed twin. */
  unitsWithRepresentations(resourceId) {
    const units = this.db.prepare('SELECT * FROM units WHERE resource_id = ? ORDER BY ordinal').all(resourceId);
    const strings = this.db.prepare(`SELECT rp.* FROM representations rp JOIN units u ON u.id = rp.unit_id
      WHERE u.resource_id = ? ORDER BY rp.modality, rp.content_hash`).all(resourceId);
    const byUnit = new Map();
    for (const row of strings) {
      if (!byUnit.has(row.unit_id)) byUnit.set(row.unit_id, []);
      byUnit.get(row.unit_id).push(row);
    }
    return units.map(unit => ({ ...unit, representations: byUnit.get(unit.id) ?? [] }));
  }

  /**
   * True when a resource carries usable page renders, slide images or clips.
   * A run that deliberately skipped visuals records the representation with
   * `embedding_disabled`, which must not count as coverage for a copy.
   */
  hasVisualRepresentations(resourceId) {
    return this.db.prepare(`SELECT 1 AS found FROM representations rp JOIN units u ON u.id = rp.unit_id
      WHERE u.resource_id = ? AND rp.modality <> 'text'
        AND (rp.error IS NULL OR rp.error <> 'embedding_disabled') LIMIT 1`).get(resourceId) !== undefined;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  putVector(profileValue, contentHash, modality, vector) {
    const profile = normalizeProfile(profileValue);
    const fingerprint = profileFingerprint(profile);
    const existing = this.db.prepare('SELECT fingerprint FROM profiles WHERE id = ?').get(profile.id);
    if (existing && existing.fingerprint !== fingerprint) throw new Error(`Embedding profile ID collision: ${profile.id}`);
    const data = vectorToBlob(vector, profile.dimensions);
    this.db.prepare('INSERT OR IGNORE INTO profiles VALUES (?, ?, ?)').run(profile.id, fingerprint, stableJSON(profile));
    const id = `vector:${hash(`${profile.id}\0${contentHash}\0${modality}`)}`;
    this.db.prepare('INSERT OR IGNORE INTO vectors VALUES (?, ?, ?, ?, ?)').run(id, profile.id, contentHash, modality, data);
    return id;
  }

  replace(resource, units) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM resources WHERE id = ?').run(resource.id);
      this.db.prepare(`INSERT INTO resources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        resource.id, SCHEMA_VERSION, resource.source_node, resource.source_uri, resource.canonical_path,
        resource.kind, resource.mime, resource.title, resource.revision, resource.size, resource.mtime_ms,
        resource.sharing, resource.parser_version, resource.indexed_at, JSON.stringify(resource.warnings ?? []), 'ready', null,
      );
      const insertUnit = this.db.prepare('INSERT INTO units VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insertRep = this.db.prepare('INSERT INTO representations VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const [ordinal, unit] of units.entries()) {
        insertUnit.run(unit.id, resource.id, unit.kind, stableJSON(unit.locator), unit.text, ordinal, JSON.stringify(unit.metadata ?? {}));
        for (const rep of unit.representations) {
          let vectorId = rep.vector_id ?? null;
          if (rep.vector) vectorId = this.putVector(rep.profile, rep.content_hash, rep.modality, rep.vector);
          insertRep.run(rep.id, unit.id, rep.modality, rep.content_hash, rep.text ?? null, rep.path ?? null, vectorId, rep.error ?? null);
        }
      }
      this.collectUnused();
    });
  }

  collectUnused() {
    this.db.exec('DELETE FROM vectors WHERE id NOT IN (SELECT vector_id FROM representations WHERE vector_id IS NOT NULL); DELETE FROM profiles WHERE id NOT IN (SELECT profile_id FROM vectors);');
  }
  remove(id) {
    return this.transaction(() => {
      const { changes } = this.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
      this.collectUnused();
      return { resource_id: id, removed: changes > 0 };
    });
  }
  close() { this.db.close(); }
}
