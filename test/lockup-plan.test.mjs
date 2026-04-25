import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLockupPlan } from '../scripts/lib/lockup-merge.mjs';

test('lockup plan matches the expected tokenomics totals', () => {
  const plan = buildLockupPlan();

  assert.equal(plan.categories.length, 7);
  assert.equal(plan.summary.totalSupplyTokens, '1000000000');
  assert.equal(plan.summary.baselineCirculatingTokens, '210000000');
  assert.equal(plan.summary.futureLockedTokens, '790000000');
  assert.equal(plan.summary.firstFutureUnlockAt, '2026-05-01T12:00:00.000Z');
  assert.equal(plan.summary.lastFutureUnlockAt, '2033-04-01T12:00:00.000Z');
});

test('first monthly increase is 12,500,000 tokens', () => {
  const plan = buildLockupPlan();
  const firstMonth = plan.schedule.find((row) => row.offsetMonths === 1);
  assert.ok(firstMonth);
  assert.equal(firstMonth.monthlyIncrementTokens, '12500000');
});

test('final category totals match allocations', () => {
  const plan = buildLockupPlan();
  const categories = Object.fromEntries(
    plan.categories.map((category) => [category.key, category.allocationTokens]),
  );
  const finalRow = plan.schedule.at(-1);

  assert.ok(finalRow);
  for (const [key, allocation] of Object.entries(categories)) {
    assert.equal(finalRow.categoryCumulative[key], allocation);
  }
});
