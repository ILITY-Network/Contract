import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAddress } from 'ethers';
import { buildLockupPlan } from '../scripts/lib/lockup-merge.mjs';
import {
  buildExecutionCsv,
  buildExecutionPreviewRows,
  buildExecutionRows,
  parseExecutionCsv,
  verifyExecutionRows,
} from '../scripts/lib/execution-csv.mjs';

const BENEFICIARIES = {
  sales: '0x0000000000000000000000000000000000000011',
  dev_fund: '0x0000000000000000000000000000000000000012',
  team_and_advisor: '0x0000000000000000000000000000000000000013',
  marketing: '0x0000000000000000000000000000000000000014',
  reward: '0x0000000000000000000000000000000000000015',
  community: '0x0000000000000000000000000000000000000016',
  operation: '0x0000000000000000000000000000000000000017',
};

test('execution preview rows are aggregated by beneficiary key and unlock time', () => {
  const plan = buildLockupPlan();
  const previewRows = buildExecutionPreviewRows(plan);
  const devFundFirstUnlock = previewRows.find(
    (row) =>
      row.beneficiaryKey === 'dev_fund' &&
      row.unlockAt === '2026-05-01T12:00:00.000Z',
  );

  assert.equal(previewRows.length, 339);
  assert.ok(devFundFirstUnlock);
  assert.equal(devFundFirstUnlock.amountTokens, '1666667');
});

test('execution csv round-trips and verifies against expected rows', async () => {
  const plan = buildLockupPlan();
  const beneficiaryAddresses = new Map(
    Object.entries(BENEFICIARIES).map(([key, value]) => [key, getAddress(value)]),
  );
  const expectedRows = buildExecutionRows(plan, beneficiaryAddresses);
  const csv = buildExecutionCsv(expectedRows);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ility-execution-csv-'));
  const executionCsvPath = path.join(tempDir, 'lockup-execution.csv');
  await writeFile(executionCsvPath, csv);

  const parsedRows = parseExecutionCsv(executionCsvPath);
  const verification = verifyExecutionRows({
    expectedRows,
    actualRows: parsedRows,
    expectedTotalWei: plan.summary.futureLockedWei,
  });

  assert.equal(verification.rowCount, expectedRows.length);
  assert.equal(verification.totalAmountWei, plan.summary.futureLockedWei);
  assert.match(await readFile(executionCsvPath, 'utf8'), /^address,unlock_at_utc,/);
});
