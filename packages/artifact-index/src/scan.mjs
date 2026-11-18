import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

/**
 * Extensions the local parser can read. The Python extractor publishes the
 * same table through `doctor`, and a test compares both lists so a new
 * format cannot appear in one place only.
 */
export const SUPPORTED_EXTENSIONS = Object.freeze([
  '.pdf', '.pptx', '.pptm', '.ppt', '.xlsx', '.xlsm', '.xls',
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg',
  '.docx', '.docm', '.doc', '.txt', '.md', '.markdown',
]);

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_FILE_LIMIT = 5000;
const DEFAULT_PRUNED_DIRECTORIES = ['node_modules', 'dist', 'build', 'vendor', 'target', '__pycache__', 'coverage', '.next', '.venv', 'site-packages', 'Pods', 'DerivedData'];

function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') { source += '.*'; index++; }
      else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(character)) source += `\\${character}`;
    else source += character;
  }
  return new RegExp(`^${source}$`);
}

function matcher(patterns) {
  const expressions = patterns.filter(Boolean).map(pattern => globToRegExp(pattern));
  return (relativePath, name) => expressions.some(expression => expression.test(relativePath) || expression.test(name));
}

/**
 * A pattern that matches a bare directory name prunes the whole subtree.
 *
 * Excluding `node_modules` file by file still walks hundreds of thousands of
 * entries; pruning the directory removes the subtree in one step.
 */
function pruner(patterns) {
  const expressions = patterns.filter(Boolean).map(pattern => globToRegExp(pattern));
  return (name) => expressions.some(expression => expression.test(name));
}

/**
 * Expand explicit files and directories into a deterministic file list.
 *
 * An explicit file is always kept, so an unsupported format still reports a
 * parse error instead of disappearing. Directory walks only collect formats
 * the local parser supports and report what they skipped.
 */
export async function collectArtifacts(roots, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const fileLimit = Number.isInteger(options.fileLimit) ? options.fileLimit : DEFAULT_FILE_LIMIT;
  const includeHidden = options.includeHidden === true;
  const isExcluded = matcher(options.exclude ?? []);
  // Keywords match any path segment, case-insensitively. This is friendlier
  // than a glob for "skip everything under a code-ecosystem directory".
  const keywords = (options.excludeKeywords ?? []).filter(Boolean).map(k => String(k).toLowerCase());
  const isKeywordExcluded = path => keywords.length > 0 && keywords.some(k => path.toLowerCase().includes(k));
  // Caller rules extend the default pruned set; they never weaken it.
  const pruneDirectory = pruner([...DEFAULT_PRUNED_DIRECTORIES, ...(options.excludeDirectories ?? [])]);
  const files = [];
  const directories = [];
  // A large tree holds hundreds of thousands of unsupported files. Keep a
  // bounded sample per reason and count the rest, so a full-disk scan stays
  // within memory instead of collecting every rejected path.
  const sampleLimit = Number.isInteger(options.skipSampleLimit) ? options.skipSampleLimit : 50;
  const skipped = [];
  const skippedCounts = new Map();
  let skippedTotal = 0;
  let truncated = false;

  const skip = (path, reason) => {
    skippedTotal++;
    skippedCounts.set(reason, (skippedCounts.get(reason) ?? 0) + 1);
    const sameReason = skipped.filter(item => item.reason === reason).length;
    if (sameReason < sampleLimit) skipped.push({ path, reason });
  };

  const walk = async (directory, depth, root) => {
    if (truncated) return;
    if (depth > maxDepth) { skip(directory, 'max_depth'); return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { skip(directory, error.code ?? 'unreadable'); return; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      // Patterns match the path relative to the walk root, so a rule can
      // address a whole subtree and not just a bare file name.
      const relativePath = relative(root, path);
      if (isExcluded(relativePath, entry.name) || isKeywordExcluded(relativePath)) continue;
      if (entry.isSymbolicLink()) { skip(path, 'symlink'); continue; }
      if (entry.isDirectory()) {
        // Pruning a known build/vendor subtree removes it in one step.
        if (pruneDirectory(entry.name)) { skip(path, 'pruned_directory'); continue; }
        directories.push(path);
        await walk(path, depth + 1, root);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SUPPORTED_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
        skip(path, 'unsupported_extension');
        continue;
      }
      if (files.length >= fileLimit) { truncated = true; return; }
      files.push(path);
    }
  };

  for (const root of roots) {
    const path = resolve(root);
    let info;
    try { info = await stat(path); }
    catch {
      // An explicitly named source that cannot be read is still handed to the
      // indexer, which reports the failure and retires its stale snapshot.
      files.push(path);
      continue;
    }
    if (info.isDirectory()) {
      directories.push(path);
      await walk(path, 1, path);
      continue;
    }
    if (info.isFile()) { files.push(path); continue; }
    skip(path, 'not_a_regular_file');
  }

  return {
    files: [...new Set(files)], directories, skipped, truncated,
    skipped_counts: Object.fromEntries(skippedCounts), skipped_total: skippedTotal,
  };
}
