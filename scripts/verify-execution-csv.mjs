import { parseArgs } from 'node:util';
import { DEFAULT_TOKEN_ADDRESS } from './lib/lockup-plan.mjs';
import {
  buildExecutionRows,
  loadJson,
  loadPlan,
  parseExecutionCsv,
  resolveBeneficiaryAddresses,
  verifyExecutionRows,
} from './lib/execution-csv.mjs';

const { values } = parseArgs({
  options: {
    executionCsv: {
      type: 'string',
      default: 'generated/lockup-execution.csv',
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
const { addresses } = resolveBeneficiaryAddresses(plan, beneficiariesConfig, {
  allowMissing: false,
});
const expectedRows = buildExecutionRows(plan, addresses);
const actualRows = parseExecutionCsv(values.executionCsv);
const verification = verifyExecutionRows({
  expectedRows,
  actualRows,
  expectedTotalWei: plan.summary.futureLockedWei,
});

console.log(`Execution CSV verified: ${values.executionCsv}`);
console.log(`Rows: ${verification.rowCount}`);
console.log(`Total wei: ${verification.totalAmountWei}`);
