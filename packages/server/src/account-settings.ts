import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SETTINGS_FILE = join(DATA_DIR, 'account-settings.json');

let cached: AccountSettings | null = null;

export async function loadSettings(): Promise<AccountSettings> {
  if (cached) return cached;
  if (!existsSync(SETTINGS_FILE)) {
    cached = { ...DEFAULT_ACCOUNT_SETTINGS };
    return cached;
  }
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf-8');
    cached = { ...DEFAULT_ACCOUNT_SETTINGS, ...JSON.parse(raw) } as AccountSettings;
    return cached;
  } catch {
    cached = { ...DEFAULT_ACCOUNT_SETTINGS };
    return cached;
  }
}

export function getSettings(): AccountSettings {
  return cached ?? { ...DEFAULT_ACCOUNT_SETTINGS };
}

export async function saveSettings(settings: AccountSettings): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  cached = { ...settings };
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}
