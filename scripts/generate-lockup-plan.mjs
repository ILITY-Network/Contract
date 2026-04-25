import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BASELINE_SNAPSHOT_AT,
  DEFAULT_TOKEN_ADDRESS,
  FIRST_FUTURE_UNLOCK_AT,
  TGE_BASELINE_AT,
} from './lib/lockup-plan.mjs';
import { formatTokenAmount } from './lib/lockup-plan.mjs';
import {
  buildExecutionCsv,
  buildExecutionPreviewCsv,
  buildExecutionPreviewRows,
  buildExecutionRows,
  loadJson,
  resolveBeneficiaryAddresses,
} from './lib/execution-csv.mjs';
import {
  buildLockEntriesCsv,
  buildLockupPlan,
  buildMergedScheduleCsv,
  buildNormalizedScheduleCsv,
} from './lib/lockup-merge.mjs';

const { values } = parseArgs({
  options: {
    primaryCsv: { type: 'string', default: 'lockup.csv' },
    referenceCsv: { type: 'string', default: 'lockup2.csv' },
    beneficiaries: { type: 'string', default: 'config/beneficiaries.json' },
    outDir: { type: 'string', default: 'generated' },
    baselineSnapshotAt: { type: 'string', default: BASELINE_SNAPSHOT_AT },
    tgeBaselineAt: { type: 'string', default: TGE_BASELINE_AT },
    firstFutureUnlockAt: {
      type: 'string',
      default: FIRST_FUTURE_UNLOCK_AT,
    },
    tokenAddress: { type: 'string', default: DEFAULT_TOKEN_ADDRESS },
  },
});

const plan = buildLockupPlan({
  primaryCsvPath: values.primaryCsv,
  referenceCsvPath: values.referenceCsv,
  tgeBaselineAt: values.tgeBaselineAt,
  firstFutureUnlockAt: values.firstFutureUnlockAt,
  baselineSnapshotAt: values.baselineSnapshotAt,
  tokenAddress: values.tokenAddress,
});

const outDir = path.resolve(values.outDir);
await mkdir(outDir, { recursive: true });

await writeFile(
  path.join(outDir, 'lockup-plan.json'),
  `${JSON.stringify(plan, null, 2)}\n`,
);
await writeFile(
  path.join(outDir, 'lockup-normalized.csv'),
  buildNormalizedScheduleCsv(plan),
);
await writeFile(path.join(outDir, 'lockup-merged.csv'), buildMergedScheduleCsv(plan));
await writeFile(path.join(outDir, 'lockup-locks.csv'), buildLockEntriesCsv(plan));
const previewRows = buildExecutionPreviewRows(plan);
await writeFile(
  path.join(outDir, 'lockup-execution-preview.csv'),
  buildExecutionPreviewCsv(previewRows),
);

const beneficiariesConfig = loadJson(values.beneficiaries);
const { addresses, missing } = resolveBeneficiaryAddresses(plan, beneficiariesConfig, {
  allowMissing: true,
});
if (missing.length === 0) {
  await writeFile(
    path.join(outDir, 'lockup-execution.csv'),
    buildExecutionCsv(buildExecutionRows(plan, addresses)),
  );
}

console.log(`Plan written to ${path.join(outDir, 'lockup-plan.json')}`);
console.log(
  `Baseline circulating: ${formatTokenAmount(BigInt(plan.summary.baselineCirculatingTokens))} ${plan.token.symbol}`,
);
console.log(
  `Future locked: ${formatTokenAmount(BigInt(plan.summary.futureLockedTokens))} ${plan.token.symbol}`,
);
console.log(`Future lock entries: ${plan.summary.futureLockEntryCount}`);
console.log(`First future unlock: ${plan.summary.firstFutureUnlockAt}`);
console.log(`Last future unlock: ${plan.summary.lastFutureUnlockAt}`);
console.log(`Execution preview rows: ${previewRows.length}`);
if (missing.length === 0) {
  console.log(`Execution CSV written to ${path.join(outDir, 'lockup-execution.csv')}`);
} else {
  console.log(`Execution CSV skipped. Missing beneficiary addresses: ${missing.join(', ')}`);
}
