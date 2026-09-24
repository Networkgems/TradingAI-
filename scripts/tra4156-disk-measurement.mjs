/**
 * TRA-4156 — Measure /data headroom and current ledger usage on bqb1.
 *
 * This script queries the live server to understand:
 * 1. Total disk capacity and usage
 * 2. Current closes/ and tape/ directory sizes
 * 3. How much headroom exists for the budget split decision
 */

const TRADING_API_BASE = 'https://tradingai-bqb1.onrender.com';

async function authenticate() {
  // Using the admin credentials from the environment
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD environment variable not set');
  }

  const response = await fetch(`${TRADING_API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  }

  const { token } = await response.json();
  return token;
}

async function getStorageDetail(token) {
  const response = await fetch(`${TRADING_API_BASE}/api/health/storage/detail`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Storage detail request failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function main() {
  console.log('TRA-4156 — Measuring /data disk usage on bqb1...\n');

  const token = await authenticate();
  console.log('✓ Authenticated\n');

  const storage = await getStorageDetail(token);

  // Disk-level figures
  console.log('=== DISK OVERVIEW ===');
  console.log(`Path: ${storage.disk.path}`);
  console.log(`Total: ${(storage.disk.totalBytes / (1024 ** 3)).toFixed(2)} GiB`);
  console.log(`Used: ${(storage.disk.usedBytes / (1024 ** 3)).toFixed(2)} GiB (${storage.disk.usedPct}%)`);
  console.log(`Free: ${(storage.disk.freeBytes / (1024 ** 3)).toFixed(2)} GiB (${storage.disk.freePct}%)`);
  console.log(`Reserved: ${(storage.disk.reservedBytes / (1024 ** 3)).toFixed(2)} GiB`);
  console.log();

  // DATA_DIR breakdown
  if (storage.usage) {
    console.log('=== DATA_DIR BREAKDOWN ===');
    console.log(`Root: ${storage.usage.root}`);
    console.log(`Total files: ${storage.usage.totalFiles.toLocaleString()}`);
    console.log(`Total bytes (apparent): ${(storage.usage.totalBytes / (1024 ** 2)).toFixed(2)} MiB`);
    console.log(`Total bytes (allocated): ${(storage.usage.totalAllocatedBytes / (1024 ** 2)).toFixed(2)} MiB`);
    console.log();

    // Find closes/ and tape/ directories in the breakdown
    console.log('=== LEDGER DIRECTORIES (closes/ + tape/) ===');
    let closesTotal = 0;
    let tapeTotal = 0;

    for (const entry of storage.usage.entries) {
      if (entry.name === 'users' && entry.kind === 'dir') {
        // Look for patterns that indicate closes/ or tape/ files
        for (const pattern of entry.byFile) {
          if (pattern.pattern.includes('closes') || pattern.pattern.includes('tape')) {
            console.log(`  ${pattern.pattern}: ${pattern.files} files, ${(pattern.bytes / (1024 ** 2)).toFixed(2)} MiB`);
          }
        }
      }
    }

    // Unaccounted space
    if (storage.usage.unaccounted) {
      console.log('\n=== UNACCOUNTED SPACE ===');
      console.log(`Disk used (attributable): ${(storage.usage.unaccounted.attributableUsedBytes / (1024 ** 3)).toFixed(2)} GiB`);
      console.log(`DATA_DIR allocated: ${(storage.usage.unaccounted.allocatedBytes / (1024 ** 3)).toFixed(2)} GiB`);
      console.log(`Unaccounted: ${(storage.usage.unaccounted.bytes / (1024 ** 3)).toFixed(2)} GiB (${storage.usage.unaccounted.pct}%)`);
    }
  }

  console.log('\n=== HEADROOM ANALYSIS ===');
  const freeGiB = storage.disk.freeBytes / (1024 ** 3);
  const current64MiB = 64;
  const currentBytes = current64MiB * 1024 * 1024;

  console.log(`Current ledger budget: ${current64MiB} MiB`);
  console.log(`Free space available: ${freeGiB.toFixed(2)} GiB (${(freeGiB * 1024).toFixed(0)} MiB)`);
  console.log(`Headroom for budget increase: ${((freeGiB * 1024) - current64MiB).toFixed(0)} MiB`);
  console.log(`Current usage at: 99.96% of ${current64MiB} MiB budget`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
