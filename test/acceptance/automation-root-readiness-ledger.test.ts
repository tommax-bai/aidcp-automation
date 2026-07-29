// aidcp:test-owner=derived
/**
 * Mechanical anchor for the automation readiness ledger (task 0.3b).
 *
 * The Cloud monolith ledger is AST-derived and therefore self-extinguishing:
 * an entry only exists while a real source anchor still resolves, so resolving
 * the dependency removes it and the acceptance test fails until the JSON is
 * refreshed. This package's ledger has no such property — it is a hand-written
 * constant plus a JSON projection nothing read. It drifted exactly the way an
 * unanchored ledger drifts: the JSON stayed at a stale 20-entry snapshot that
 * still listed eight 4b mirror dependencies which the sync-read mirrors had
 * already closed, while the constant had moved on to 12.
 *
 * These assertions are the minimum anchor, and the honest statement of what
 * they buy is narrow: **they anchor self-consistency, not agreement with
 * reality.** The constant and the JSON must be the same ledger, and the summary
 * must be computed from it rather than typed in, so changing either side alone
 * is red — that is the single-sided drift these tests catch, and it is the
 * drift that actually happened.
 *
 * What they cannot catch, stated plainly so nobody relies on it: adding an
 * invented blocker to both sides at once is green, and deleting a real blocker
 * from both sides at once is also green. Nothing here reads production source,
 * because in this package the ledger is a hand-written constant. The Cloud
 * monolith's copy gets self-extinguishing behaviour from AST derivation; this
 * one does not, and an entry here stays true only for as long as a human keeps
 * it true.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  AUTOMATION_ROOT_READINESS_BLOCKERS,
  type AutomationRootBlockerCategory,
} from '../../src/automation-composition-root.js';
import {
  deriveIndependentRootBlockers,
  type DerivedBlocker,
} from './helpers/composition-root-4a-census.js';

interface BlockerLedger {
  schemaVersion: number;
  change: string;
  claimBlocked: boolean;
  claim: string;
  summary: { total: number; byCategory: Record<string, number> };
  blockers: DerivedBlocker[];
}

const CATEGORIES: readonly AutomationRootBlockerCategory[] = [
  '4b-mirror',
  'operator-command',
  'content-owner',
  'composition-root',
];

async function loadLedger(): Promise<BlockerLedger> {
  const path = new URL(
    '../../boundaries/composition-root-independent-blockers.json',
    import.meta.url,
  );
  return JSON.parse(await readFile(path, 'utf8')) as BlockerLedger;
}

test('automation readiness ledger JSON is exactly the readiness constant', async () => {
  const [ledger, derived] = await Promise.all([loadLedger(), deriveIndependentRootBlockers()]);
  assert.deepEqual(
    derived,
    ledger.blockers,
    'boundaries/composition-root-independent-blockers.json must be refreshed whenever'
    + ' AUTOMATION_ROOT_READINESS_BLOCKERS gains, loses or rewires an entry'
    + ' (npx tsx test/acceptance/helpers/composition-root-4a-census.ts --refresh-ledger)',
  );
  assert.equal(
    ledger.blockers.length,
    AUTOMATION_ROOT_READINESS_BLOCKERS.length,
    'the JSON must not carry entries the constant no longer declares',
  );
  assert.deepEqual(
    ledger.blockers.map((blocker) => blocker.id),
    AUTOMATION_ROOT_READINESS_BLOCKERS.map((blocker) => blocker.id),
    'ledger order and identity must follow the constant',
  );
});

test('automation readiness ledger summary is computed, not asserted by hand', async () => {
  const ledger = await loadLedger();
  assert.equal(ledger.summary.total, ledger.blockers.length);
  assert.equal(
    ledger.claimBlocked,
    ledger.blockers.length > 0,
    'claimBlocked must be derived from whether the ledger is empty',
  );
  assert.match(ledger.claim, /independently bootable/);
  for (const category of CATEGORIES) {
    assert.equal(
      ledger.summary.byCategory[category],
      ledger.blockers.filter((blocker) => blocker.category === category).length,
      `${category} summary count`,
    );
  }
  assert.deepEqual(
    Object.keys(ledger.summary.byCategory).sort(),
    [...CATEGORIES].sort(),
    'summary must enumerate every category, including the ones currently at zero',
  );
});

test('automation readiness ledger entries are unique and fully attributed', async () => {
  const ids = AUTOMATION_ROOT_READINESS_BLOCKERS.map((blocker) => blocker.id);
  assert.equal(new Set(ids).size, ids.length, 'blocker ids must be unique');
  for (const blocker of AUTOMATION_ROOT_READINESS_BLOCKERS) {
    assert.ok(blocker.id.length > 0, 'blocker id');
    assert.ok(CATEGORIES.includes(blocker.category), `${blocker.id} category`);
    assert.ok(
      ['api', 'automation', 'content', 'shared-kernel'].includes(blocker.owner),
      `${blocker.id} owner`,
    );
  }
});

test('4b mirror dependencies stay closed for the automation root', async () => {
  const ledger = await loadLedger();
  assert.deepEqual(
    ledger.blockers.filter((blocker) => blocker.category === '4b-mirror'),
    [],
    'the eight 4b mirror streams are served here by the sync-read mirrors; re-adding one'
    + ' means a mirror regressed and must be adjudicated, not silently re-listed',
  );
});
