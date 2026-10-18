import type { ExtractedArtifact, IndexOptions } from './index.js';

export const PARSER_VERSION: 'artifact-local-v1';
export type OfflineIsolation = 'os-sandbox' | 'os-network-namespace' | 'application-only';
export interface ExtractionOptions extends IndexOptions {
  /** Absolute directory for derived pages and clips. Model files are not stored here. */
  cacheDir?: string;
  python?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxFileBytes?: number;
  maxPages?: number;
  maxUnits?: number;
  maxCells?: number;
  maxTextChars?: number;
  maxArchiveBytes?: number;
  maxVideoSeconds?: number;
  rowsPerUnit?: number;
  chunkChars?: number;
  chunkOverlap?: number;
}
export interface ExtractionResult extends ExtractedArtifact {
  offline_isolation: OfflineIsolation;
  duration_ms?: number;
  sampling?: {segment_ms: number; overlap_ms: number; fps: number; max_dimension: number};
}
export interface ExtractionDoctorResult {
  python: string;
  parser_version: string;
  modules: Record<'pypdf' | 'pptx' | 'openpyxl' | 'xlrd' | 'PIL', boolean>;
  commands: Record<'pdftoppm' | 'pdftotext' | 'soffice' | 'libreoffice' | 'ffmpeg' | 'ffprobe', string | null>;
  offline_isolation: OfflineIsolation;
  capabilities: Record<'pdf_text' | 'pdf_visual' | 'pptx_text' | 'presentation_visual' | 'xlsx' | 'xls' | 'video', boolean>;
}
/** Local paths only. Never downloads parsers/models or fetches remote source URLs. */
export function extractArtifact(file: string, options?: ExtractionOptions): Promise<ExtractionResult>;
export function doctor(options?: {python?: string; timeoutMs?: number}): Promise<ExtractionDoctorResult>;
export const extractionDoctor: typeof doctor;
