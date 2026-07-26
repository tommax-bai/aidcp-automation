// aidcp:test-owner=derived
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import type { OwnershipEntry } from './helpers/boundary-scan.js';
import { classifyEdge } from './helpers/boundary-scan.js';
import { census } from './helpers/boundary-record.js';

test('composition roots may import each other while business layers cannot import composition', () => {
  assert.equal(classifyEdge('composition', 'composition'), 'allowed');
  assert.equal(classifyEdge('composition', 'automation'), 'allowed');
  for (const layer of ['kernel', 'api', 'content', 'automation'] as const) {
    assert.equal(
      classifyEdge(layer, 'composition'),
      'forbidden',
      `${layer} must not reverse-import a composition root`,
    );
  }
});

test('derived census fails closed when a mutation introduces a forbidden import', () => {
  const entries: OwnershipEntry[] = [
    { path: 'src/business.ts', layer: 'automation', note: 'mutation source' },
    { path: 'src/root.ts', layer: 'composition', note: 'mutation target' },
  ];
  assert.throws(
    () => census(entries, {
      listFiles: () => entries.map((entry) => entry.path),
      scan: () => ({
        edges: [{ from: 'src/business.ts', to: 'src/root.ts' }],
        unresolved: [],
      }),
    }),
    /forbidden import edges \(1\).*business\.ts.*root\.ts/s,
  );
});

test('boundary census executable exits zero only for the real forbidden-free graph', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/acceptance/helpers/boundary-record.ts',
      'census',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /forbidden=0/);
});

test('boundary census execution exits nonzero for a forbidden-edge mutation', () => {
  const script = `
    import { census } from './test/acceptance/helpers/boundary-record.ts';
    const entries = [
      { path: 'src/business.ts', layer: 'automation', note: 'mutation source' },
      { path: 'src/root.ts', layer: 'composition', note: 'mutation target' },
    ];
    census(entries, {
      listFiles: () => entries.map((entry) => entry.path),
      scan: () => ({
        edges: [{ from: 'src/business.ts', to: 'src/root.ts' }],
        unresolved: [],
      }),
    });
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden import edges \(1\)/);
});
