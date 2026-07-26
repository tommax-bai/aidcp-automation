import { writeFileSync } from 'node:fs';

import {
  type AdjudicatedFiles,
  type OwnershipEntry,
  type OwnershipRules,
  classifyEdge,
  expandOwnership,
  listSourceFiles,
  readJson,
  repoPath,
  scanImports,
} from './boundary-scan.js';

const OWNERSHIP_PATH = 'boundaries/module-ownership.json';

function deriveOwnership(): OwnershipEntry[] {
  const files = listSourceFiles();
  const rules = readJson<OwnershipRules>('boundaries/ownership-rules.json');
  const adjudicated = readJson<AdjudicatedFiles>('boundaries/adjudicated-files.json');
  return expandOwnership(rules, files, adjudicated.files);
}

function census(entries: readonly OwnershipEntry[]): void {
  const files = listSourceFiles();
  const sourceSet = new Set(files);
  const entrySet = new Set(entries.map((entry) => entry.path));
  const missing = files.filter((file) => !entrySet.has(file));
  const stale = entries.map((entry) => entry.path).filter((file) => !sourceSet.has(file));
  if (missing.length > 0 || stale.length > 0 || entrySet.size !== entries.length) {
    throw new Error(
      `derived ownership mismatch missing=${missing.length} stale=${stale.length}`
      + ` duplicates=${entries.length - entrySet.size}`,
    );
  }

  const layerByFile = new Map(entries.map((entry) => [entry.path, entry.layer]));
  const imports = scanImports(files);
  if (imports.unresolved.length > 0) {
    throw new Error(
      `unresolved relative imports (${imports.unresolved.length}): `
      + imports.unresolved.map((item) => `${item.file}:${item.specifier}`).join(', '),
    );
  }
  const byVerdict = { allowed: 0, exemptable: 0, forbidden: 0 };
  for (const edge of imports.edges) {
    const from = layerByFile.get(edge.from);
    const to = layerByFile.get(edge.to);
    if (!from || !to) throw new Error(`unowned import edge: ${edge.from} -> ${edge.to}`);
    byVerdict[classifyEdge(from, to)] += 1;
  }
  console.log(
    `derived boundary census source=${files.length} ownership=${entries.length}`
    + ` imports=${imports.edges.length} unresolved=0`
    + ` allowed=${byVerdict.allowed} exemptable=${byVerdict.exemptable}`
    + ` forbidden=${byVerdict.forbidden}`,
  );
}

function run(argv: readonly string[]): void {
  if (argv.length !== 1 || !['refresh', 'census'].includes(argv[0]!)) {
    throw new Error('usage: boundary-record.ts <refresh|census>');
  }
  if (argv[0] === 'refresh') {
    const entries = deriveOwnership();
    writeFileSync(repoPath(OWNERSHIP_PATH), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    console.log(`written: ${OWNERSHIP_PATH}`);
    census(entries);
    return;
  }
  census(readJson<OwnershipEntry[]>(OWNERSHIP_PATH));
}

try {
  run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
