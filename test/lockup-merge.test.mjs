import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLockupPlan } from '../scripts/lib/lockup-merge.mjs';

test('lockup merge marks only Sales as outdated in lockup2', () => {
  const plan = buildLockupPlan();
  const outdatedRows = plan.mergedScheduleRows.filter(
    (row) => row.referenceStatus === 'outdated_reference',
  );

  assert.ok(outdatedRows.length > 0);
  assert.ok(outdatedRows.every((row) => row.categoryKey === 'sales'));
});

test('non-sales categories match lockup2 within 1 token tolerance', () => {
  const plan = buildLockupPlan();
  const nonSalesRows = plan.mergedScheduleRows.filter(
    (row) => row.categoryKey !== 'sales',
  );

  for (const row of nonSalesRows) {
    assert.ok(Math.abs(Number(row.referenceDiffTokens)) <= 1);
  }
});

test('merged schedule contains one row per category per month', () => {
  const plan = buildLockupPlan();
  assert.equal(
    plan.summary.mergedRowCount,
    plan.summary.scheduleRowCount * plan.summary.categoryCount,
  );
});
