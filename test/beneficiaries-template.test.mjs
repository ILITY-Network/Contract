import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLockupPlan } from '../scripts/lib/lockup-merge.mjs';

test('beneficiaries example keys match the generated category keys', () => {
  const plan = buildLockupPlan();
  const template = JSON.parse(
    fs.readFileSync(new URL('../config/beneficiaries.example.json', import.meta.url)),
  );

  assert.deepEqual(
    Object.keys(template).sort(),
    plan.categories.map((category) => category.key).sort(),
  );
});
