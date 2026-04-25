import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_TOKEN_ADDRESS,
  formatTokenAmount,
} from './lib/lockup-plan.mjs';
import {
  buildExecutionCsv,
  buildExecutionPreviewCsv,
  buildExecutionPreviewRows,
  buildExecutionRows,
  loadJson,
  loadPlan,
  resolveBeneficiaryAddresses,
} from './lib/execution-csv.mjs';

const { values } = parseArgs({
  options: {
    executionCsv: {
      type: 'string',
      default: 'generated/lockup-execution.csv',
    },
    previewCsv: {
      type: 'string',
      default: 'generated/lockup-execution-preview.csv',
    },
    mergedCsv: { type: 'string', default: 'generated/lockup-merged.csv' },
    plan: { type: 'string', default: 'generated/lockup-plan.json' },
    beneficiaries: { type: 'string', default: 'config/beneficiaries.json' },
    tokenAddress: {
      type: 'string',
      default: process.env.TOKEN_ADDRESS ?? DEFAULT_TOKEN_ADDRESS,
    },
  },
});

const plan = loadPlan({
  executionCsvPath: null,
  mergedCsvPath: values.mergedCsv,
  planPath: values.plan,
  tokenAddress: values.tokenAddress,
});
if (!plan) {
  throw new Error('Unable to load execution plan from merged CSV or JSON plan.');
}

const beneficiariesConfig = loadJson(values.beneficiaries);
const { addresses, missing } = resolveBeneficiaryAddresses(plan, beneficiariesConfig, {
  allowMissing: true,
});

const previewRows = buildExecutionPreviewRows(plan);
await mkdir(path.dirname(path.resolve(values.previewCsv)), { recursive: true });
await writeFile(path.resolve(values.previewCsv), buildExecutionPreviewCsv(previewRows));

console.log(`Preview written to ${path.resolve(values.previewCsv)}`);
console.log(`Preview rows: ${previewRows.length}`);
console.log(
  `Preview total: ${formatTokenAmount(BigInt(plan.summary.futureLockedTokens))} ILY`,
);

if (missing.length > 0) {
  console.log(
    `Execution CSV not written. Fill beneficiary addresses for: ${missing.join(', ')}`,
  );
  process.exit(0);
}

const executionRows = buildExecutionRows(plan, addresses);
await mkdir(path.dirname(path.resolve(values.executionCsv)), { recursive: true });
await writeFile(path.resolve(values.executionCsv), buildExecutionCsv(executionRows));

console.log(`Execution CSV written to ${path.resolve(values.executionCsv)}`);
console.log(`Execution rows: ${executionRows.length}`);
