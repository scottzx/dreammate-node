import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { SkillDescriptor } from '@1agents/dreammate-network';

export interface SkillDescriptorWithSource extends SkillDescriptor {
  source_dir?: string;
}

/**
 * 解析 SKILL.md 中的 YAML Frontmatter 和正文 SOP。
 */
export function parseSkillMarkdown(raw: string): { data: Record<string, string>; sop: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, sop: raw.trim() };
  }
  const yamlBlock = match[1] ?? '';
  const sop = (match[2] ?? '').trim();
  const data: Record<string, string> = {};
  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      let val = trimmed.slice(colonIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      data[key] = val;
    }
  }
  return { data, sop };
}

const SKILL_MD_CANDIDATES = [
  'SKILL.remote.md',
  'skill.remote.md',
  'SKILL.md',
  'skill.md',
];

function findSkillMarkdownFile(dir: string): string | undefined {
  for (const candidate of SKILL_MD_CANDIDATES) {
    const filePath = path.join(dir, candidate);
    if (fs.existsSync(filePath)) {
      try {
        if (fs.statSync(filePath).isFile()) {
          return filePath;
        }
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

/**
 * 约定式从目录扫描并解析技能包（支持单一技能目录或存放多个技能的根目录）。
 * 优先读取伴生的 SKILL.remote.md，回退至 SKILL.md。
 */
export function loadSkillsFromDir(skillsDir: string): Record<string, SkillDescriptorWithSource> {
  const resolvedDir = path.resolve(process.cwd(), skillsDir);
  if (!fs.existsSync(resolvedDir)) {
    return {};
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedDir);
  } catch {
    return {};
  }
  if (!stat.isDirectory()) {
    return {};
  }

  const result: Record<string, SkillDescriptorWithSource> = {};

  // 1. 先检查 skillsDir 本身是否就是一个独立的技能目录（即其下直接包含 SKILL.md）
  const directMd = findSkillMarkdownFile(resolvedDir);
  if (directMd) {
    const raw = fs.readFileSync(directMd, 'utf8');
    const { data, sop } = parseSkillMarkdown(raw);
    const skillName = data.name || path.basename(resolvedDir);
    result[skillName] = {
      name: skillName,
      description: data.description || '',
      sop,
      source_dir: resolvedDir,
    };
    return result;
  }

  // 2. 遍历其下的子目录（如 skills/transcribe）
  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(resolvedDir, entry.name);
    const skillMd = findSkillMarkdownFile(subDir);
    if (skillMd) {
      const raw = fs.readFileSync(skillMd, 'utf8');
      const { data, sop } = parseSkillMarkdown(raw);
      const skillName = data.name || entry.name;
      result[skillName] = {
        name: skillName,
        description: data.description || '',
        sop,
        source_dir: subDir,
      };
    }
  }

  return result;
}

/**
 * 将指定技能打包为 tar.gz 流。
 * 若技能在磁盘上有实际源码目录，则完整打包该目录（保留 scripts/、references/ 等所有资产）；
 * 若无源码目录但有 SOP 文本，则动态构建包含标准 SKILL.md 的临时技能包并打包。
 */
export function archiveSkill(options: {
  skill: SkillDescriptor & { source_dir?: string };
  skillName: string;
}): { stream: Readable; cleanup: () => void } {
  const { skill, skillName } = options;

  if (skill.source_dir && fs.existsSync(skill.source_dir)) {
    const parentDir = path.dirname(skill.source_dir);
    const folderName = path.basename(skill.source_dir);
    const tar = spawn('tar', ['-czf', '-', '-C', parentDir, folderName]);
    return {
      stream: tar.stdout,
      cleanup: () => {
        tar.kill();
      },
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-skill-'));
  const folder = path.join(tmpDir, skillName);
  fs.mkdirSync(folder, { recursive: true });

  const frontmatter = [
    '---',
    `name: ${skill.name || skillName}`,
    ...(skill.description ? [`description: ${JSON.stringify(skill.description)}`] : []),
    '---',
    '',
    skill.sop || '',
  ].join('\n');

  fs.writeFileSync(path.join(folder, 'SKILL.md'), frontmatter, 'utf8');

  const tar = spawn('tar', ['-czf', '-', '-C', tmpDir, skillName]);
  const cleanup = () => {
    tar.kill();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  tar.on('close', () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  return {
    stream: tar.stdout,
    cleanup,
  };
}

/**
 * 列出 tar.gz 归档包中的文件路径列表。
 */
export async function listSkillArchive(tarGzBuffer: Buffer): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const tar = spawn('tar', ['-ztf', '-']);
    let output = '';
    let errOutput = '';
    tar.stdout.on('data', (d) => {
      output += d.toString();
    });
    tar.stderr.on('data', (d) => {
      errOutput += d.toString();
    });
    tar.on('close', (code) => {
      if (code === 0) {
        const lines = output
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        resolve(lines);
      } else {
        reject(new Error(`tar listing failed (code ${code}): ${errOutput}`));
      }
    });
    tar.on('error', reject);
    tar.stdin.end(tarGzBuffer);
  });
}

/**
 * 将 tar.gz 归档包解压并安装到目标目录。
 */
export async function installSkillPackage(
  tarGzBuffer: Buffer,
  targetDir: string,
  skillName: string,
): Promise<string> {
  const resolvedTarget = targetDir.startsWith('~')
    ? path.join(os.homedir(), targetDir.slice(1))
    : path.resolve(process.cwd(), targetDir);

  fs.mkdirSync(resolvedTarget, { recursive: true });

  return new Promise<string>((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', '-', '-C', resolvedTarget]);
    let errOutput = '';
    tar.stderr.on('data', (d) => {
      errOutput += d.toString();
    });
    tar.on('close', (code) => {
      if (code === 0) {
        resolve(path.join(resolvedTarget, skillName));
      } else {
        reject(new Error(`tar extraction failed (code ${code}): ${errOutput}`));
      }
    });
    tar.on('error', reject);
    tar.stdin.end(tarGzBuffer);
  });
}
