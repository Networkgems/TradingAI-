import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { ResearchReport, ResearchReportKind } from '@trading-app/shared';

// TRA-227 — file-backed store for QuantTrader research reports surfaced in
// the Stocks News tab. Reports are global (not per-user) — the routine
// produces market-wide pre/post-market reviews that all dashboards share.

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultStoreFile(): string {
  const root = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
  return join(root, 'research-reports.json');
}

let storeFileOverride: string | null = null;
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

const KINDS: readonly ResearchReportKind[] = ['premarket', 'postmarket', 'weekly_review'];
const MAX_REPORTS = 100;

interface StoreFile {
  version: 1;
  reports: ResearchReport[];
}

let cache: ResearchReport[] | null = null;

async function ensureLoaded(): Promise<ResearchReport[]> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = [];
    return cache;
  }
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    cache = Array.isArray(parsed.reports) ? parsed.reports : [];
  } catch (err) {
    console.error('[research-store] failed to read store, starting empty:', err instanceof Error ? err.message : String(err));
    cache = [];
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: StoreFile = { version: 1, reports: cache };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

/** Return all reports newest-first. */
export async function listResearchReports(): Promise<ResearchReport[]> {
  const all = await ensureLoaded();
  return [...all].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function getResearchReport(id: string): Promise<ResearchReport | undefined> {
  const all = await ensureLoaded();
  return all.find(r => r.id === id);
}

export interface ResearchReportInput {
  id?: string;
  kind: ResearchReportKind;
  title: string;
  bodyMarkdown: string;
  publishedAt?: string;
  tickers?: string[];
}

export class ResearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchValidationError';
  }
}

function isIsoDate(s: string): boolean {
  if (typeof s !== 'string') return false;
  const t = Date.parse(s);
  return !Number.isNaN(t);
}

function validateInput(input: unknown): ResearchReportInput {
  if (!input || typeof input !== 'object') {
    throw new ResearchValidationError('Body must be a JSON object');
  }
  const o = input as Record<string, unknown>;
  if (typeof o['kind'] !== 'string' || !KINDS.includes(o['kind'] as ResearchReportKind)) {
    throw new ResearchValidationError(`kind must be one of ${KINDS.join(', ')}`);
  }
  if (typeof o['title'] !== 'string' || o['title'].trim().length === 0) {
    throw new ResearchValidationError('title is required');
  }
  if (typeof o['bodyMarkdown'] !== 'string' || o['bodyMarkdown'].trim().length === 0) {
    throw new ResearchValidationError('bodyMarkdown is required');
  }
  if (o['publishedAt'] !== undefined && !isIsoDate(String(o['publishedAt']))) {
    throw new ResearchValidationError('publishedAt must be an ISO date string');
  }
  if (o['tickers'] !== undefined) {
    if (!Array.isArray(o['tickers']) || !o['tickers'].every(t => typeof t === 'string')) {
      throw new ResearchValidationError('tickers must be an array of strings');
    }
  }
  if (o['id'] !== undefined && typeof o['id'] !== 'string') {
    throw new ResearchValidationError('id must be a string');
  }
  return {
    id: o['id'] as string | undefined,
    kind: o['kind'] as ResearchReportKind,
    title: (o['title'] as string).trim(),
    bodyMarkdown: o['bodyMarkdown'] as string,
    publishedAt: o['publishedAt'] as string | undefined,
    tickers: o['tickers'] as string[] | undefined,
  };
}

/**
 * Append (or upsert by id) a research report. Validates the payload, fills in
 * id/publishedAt defaults, persists, and returns the saved record. Caps the
 * store at MAX_REPORTS by dropping the oldest entries.
 */
export async function saveResearchReport(input: unknown): Promise<ResearchReport> {
  const v = validateInput(input);
  const all = await ensureLoaded();
  const report: ResearchReport = {
    id: v.id ?? randomUUID(),
    kind: v.kind,
    title: v.title,
    bodyMarkdown: v.bodyMarkdown,
    publishedAt: v.publishedAt ?? new Date().toISOString(),
    source: 'QuantTrader',
    ...(v.tickers ? { tickers: v.tickers } : {}),
  };
  const existingIdx = all.findIndex(r => r.id === report.id);
  if (existingIdx >= 0) {
    all[existingIdx] = report;
  } else {
    all.push(report);
  }
  // Keep newest MAX_REPORTS by publishedAt.
  all.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (all.length > MAX_REPORTS) all.length = MAX_REPORTS;
  cache = all;
  await persist();
  return report;
}

/** Test-only helper: reset in-memory cache and (optionally) override the on-disk path. */
export function __resetResearchStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
