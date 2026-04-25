import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  getAddress,
} from 'ethers';
import {
  BASE_CHAIN_ID,
  DEFAULT_TOKEN_ADDRESS,
  formatTokenAmount,
} from './lib/lockup-plan.mjs';
import {
  buildExecutionRows,
  loadJson,
  loadPlan,
  parseExecutionCsv,
  resolveBeneficiaryAddresses,
  verifyExecutionRows,
} from './lib/execution-csv.mjs';

dotenv.config();

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
];

const LOCKUP_ABI = [
  'function owner() view returns (address)',
  'function token() view returns (address)',
  'function lockupCount(address account) view returns (uint256)',
  'function lockedAmount(address account) view returns (uint256)',
  'function lockupOf(address account, uint256 index) view returns (uint256 amount, uint256 unlockTime, bool claimed)',
  'function lockBatch(address[] accounts, uint256[] amounts, uint256[] unlockTimes)',
];

const ERC20_INSUFFICIENT_ALLOWANCE_SELECTOR = '0xfb8f41b2';
const PRECHECK_SYNC_TIMEOUT_MS = 120_000;
const PRECHECK_SYNC_INTERVAL_MS = 3_000;

const { values } = parseArgs({
  options: {
    executionCsv: { type: 'string', default: 'generated/lockup-execution.csv' },
    mergedCsv: { type: 'string', default: 'generated/lockup-merged.csv' },
    plan: { type: 'string', default: 'generated/lockup-plan.json' },
    beneficiaries: { type: 'string', default: 'config/beneficiaries.json' },
    outputDir: { type: 'string', default: 'generated' },
    lockupAddress: {
      type: 'string',
      default: process.env.LOCKUP_ADDRESS ?? '',
    },
    tokenAddress: {
      type: 'string',
      default: process.env.TOKEN_ADDRESS ?? DEFAULT_TOKEN_ADDRESS,
    },
    rpcUrl: { type: 'string', default: process.env.BASE_RPC_URL ?? '' },
    privateKey: { type: 'string', default: process.env.PRIVATE_KEY ?? '' },
    impersonate: { type: 'string', default: '' },
    batchSize: {
      type: 'string',
      default: process.env.BATCH_SIZE ?? '50',
    },
    confirmations: {
      type: 'string',
      default: process.env.CONFIRMATIONS ?? '1',
    },
    execute: { type: 'boolean', default: false },
    approveIfNeeded: { type: 'boolean', default: false },
    transferBaselineAfterLockups: { type: 'boolean', default: false },
  },
});

function splitBatches(items, batchSize) {
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

function formatWeiAmount(amountWei) {
  return formatTokenAmount(BigInt(formatUnits(amountWei, 18).split('.')[0] || '0'));
}

function getErrorData(error) {
  if (typeof error?.data === 'string') {
    return error.data;
  }
  if (typeof error?.info?.error?.data === 'string') {
    return error.info.error.data;
  }
  return null;
}

function isInsufficientAllowanceError(error) {
  const data = getErrorData(error);
  return typeof data === 'string' && data.startsWith(ERC20_INSUFFICIENT_ALLOWANCE_SELECTOR);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForAllowanceAtLeast({
  token,
  owner,
  spender,
  minAllowanceWei,
  timeoutMs = PRECHECK_SYNC_TIMEOUT_MS,
  pollIntervalMs = PRECHECK_SYNC_INTERVAL_MS,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const allowanceWei = BigInt(await token.allowance(owner, spender));
    if (allowanceWei >= minAllowanceWei) {
      return allowanceWei;
    }
    await sleep(pollIntervalMs);
  }

  const finalAllowanceWei = BigInt(await token.allowance(owner, spender));
  throw new Error(
    `Allowance did not reach ${minAllowanceWei} within ${timeoutMs}ms. Latest observed allowance=${finalAllowanceWei}.`,
  );
}

async function preflightBatches(lockupContract, batches, options = {}) {
  const {
    signerAddress,
    token,
    ownerAddress,
    spenderAddress,
    maxAttempts = 8,
    retryDelayMs = PRECHECK_SYNC_INTERVAL_MS,
  } = options;

  for (const batch of batches) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await lockupContract.lockBatch.staticCall(
          batch.accounts,
          batch.amounts,
          batch.unlockTimes,
          { from: signerAddress },
        );
        batch.estimatedGas = (
          await lockupContract.lockBatch.estimateGas(
            batch.accounts,
            batch.amounts,
            batch.unlockTimes,
            { from: signerAddress },
          )
        ).toString();
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (
          token &&
          ownerAddress &&
          spenderAddress &&
          isInsufficientAllowanceError(error)
        ) {
          const liveAllowanceWei = BigInt(
            await token.allowance(ownerAddress, spenderAddress),
          );
          if (liveAllowanceWei >= batch.totalAmountWei && attempt < maxAttempts) {
            await sleep(retryDelayMs);
            continue;
          }
        }
        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }
  }
}

function buildLockEntryKey({ account, unlockTimestamp, amountWei }) {
  return `${account.toLowerCase()}:${unlockTimestamp}:${amountWei.toString()}`;
}

async function loadExistingLockEntries(lockupContract, accounts) {
  const entries = [];

  for (const account of accounts) {
    const count = Number(await lockupContract.lockupCount(account));
    for (let index = 0; index < count; index += 1) {
      const [amount, unlockTime, claimed] = await lockupContract.lockupOf(account, index);
      entries.push({
        account,
        index,
        amountWei: BigInt(amount),
        unlockTimestamp: Number(unlockTime),
        unlockAt: new Date(Number(unlockTime) * 1000).toISOString(),
        claimed: Boolean(claimed),
      });
    }
  }

  return entries;
}

const batchSize = Number(values.batchSize);
const confirmations = Number(values.confirmations);
const outputDir = path.resolve(values.outputDir);
const tokenAddress = getAddress(values.tokenAddress);
const plan = loadPlan({
  executionCsvPath: null,
  mergedCsvPath: values.mergedCsv,
  planPath: values.plan,
  tokenAddress,
});
const hasExecutionCsv = existsSync(path.resolve(values.executionCsv));
let aggregatedEntries;
let executionVerification = null;
let missingBeneficiaries = [];
const hasBeneficiariesConfig = existsSync(path.resolve(values.beneficiaries));
let beneficiaryAddresses = null;
let baselineTransferPlans = [];
let baselineTransfers = [];
let baselineTotalWei = 0n;
let baselineBlockedTransfers = [];

if (hasExecutionCsv) {
  aggregatedEntries = parseExecutionCsv(values.executionCsv).map((row) => ({
    account: row.address,
    unlockAt: row.unlockAt,
    unlockTimestamp: row.unlockTimestamp,
    amountWei: BigInt(row.amountWei),
    beneficiaryKeys: row.beneficiaryKeys,
    categories: row.categoryNames,
    sourceLabels: row.sourceLabels,
  }));

  if (plan && hasBeneficiariesConfig) {
    const beneficiariesConfig = loadJson(values.beneficiaries);
    const { addresses, missing } = resolveBeneficiaryAddresses(plan, beneficiariesConfig, {
      allowMissing: true,
    });
    beneficiaryAddresses = addresses;
    missingBeneficiaries = missing;

    if (missing.length === 0) {
      executionVerification = verifyExecutionRows({
        expectedRows: buildExecutionRows(plan, addresses),
        actualRows: parseExecutionCsv(values.executionCsv),
        expectedTotalWei: plan.summary.futureLockedWei,
      });
    }
  }
} else {
  if (!plan) {
    throw new Error(
      `Execution CSV ${values.executionCsv} was not found and no fallback plan could be loaded.`,
    );
  }

  const beneficiariesConfig = loadJson(values.beneficiaries);
  const { addresses } = resolveBeneficiaryAddresses(plan, beneficiariesConfig, {
    allowMissing: false,
  });
  beneficiaryAddresses = addresses;
  aggregatedEntries = buildExecutionRows(plan, addresses).map((row) => ({
    account: row.address,
    unlockAt: row.unlockAt,
    unlockTimestamp: row.unlockTimestamp,
    amountWei: BigInt(row.amountWei),
    beneficiaryKeys: row.beneficiaryKeys,
    categories: row.categoryNames,
    sourceLabels: row.sourceLabels,
  }));
}

if (!Number.isInteger(batchSize) || batchSize <= 0) {
  throw new Error(`Invalid batch size: ${values.batchSize}`);
}

if (!values.rpcUrl) {
  throw new Error('Missing Base RPC URL. Set BASE_RPC_URL or pass --rpcUrl.');
}

if (!values.lockupAddress) {
  throw new Error('Missing lockup contract address. Set LOCKUP_ADDRESS or pass --lockupAddress.');
}

const provider = new JsonRpcProvider(values.rpcUrl);
const network = await provider.getNetwork();
if (Number(network.chainId) !== BASE_CHAIN_ID) {
  throw new Error(`Expected chainId ${BASE_CHAIN_ID}, received ${network.chainId}`);
}

const lockupAddress = getAddress(values.lockupAddress);

let signer;
if (values.impersonate) {
  const impersonatedAddress = getAddress(values.impersonate);
  await provider.send('anvil_impersonateAccount', [impersonatedAddress]);
  await provider.send('anvil_setBalance', [impersonatedAddress, '0x3635C9ADC5DEA00000']);
  signer = await provider.getSigner(impersonatedAddress);
} else {
  if (!values.privateKey) {
    throw new Error(
      'Missing admin private key. Set PRIVATE_KEY or pass --privateKey, or use --impersonate on Anvil.',
    );
  }

  signer = new Wallet(values.privateKey, provider);
}

const signerAddress = getAddress(await signer.getAddress());
const lockup = new Contract(lockupAddress, LOCKUP_ABI, signer);
const token = new Contract(tokenAddress, ERC20_ABI, signer);

if (
  values.transferBaselineAfterLockups &&
  plan &&
  beneficiaryAddresses &&
  missingBeneficiaries.length === 0
) {
  baselineTransferPlans = await Promise.all(
    plan.baselineCirculating.byCategory
      .filter((row) => BigInt(row.amountWei) > 0n)
      .map(async (row) => {
        const address = beneficiaryAddresses.get(row.categoryKey);
        const expectedAmountWei = BigInt(row.amountWei);
        const currentBalanceWei = BigInt(await token.balanceOf(address));

        let action = 'send_full';
        let transferAmountWei = expectedAmountWei;
        if (currentBalanceWei === 0n) {
          action = 'send_full';
        } else if (currentBalanceWei === expectedAmountWei) {
          action = 'skip_already_funded_exact';
          transferAmountWei = 0n;
        } else if (currentBalanceWei > expectedAmountWei) {
          action = 'skip_balance_exceeds_expected';
          transferAmountWei = 0n;
        } else {
          action = 'blocked_partial_balance';
          transferAmountWei = 0n;
        }

        return {
          beneficiaryKey: row.categoryKey,
          categoryName: row.categoryName,
          address,
          amountTokens: row.amountTokens,
          expectedAmountWei,
          currentBalanceWei,
          action,
          transferAmountWei,
        };
      }),
  );

  baselineTransfers = baselineTransferPlans
    .filter((row) => row.action === 'send_full')
    .sort(
      (left, right) =>
        left.address.localeCompare(right.address) ||
        left.beneficiaryKey.localeCompare(right.beneficiaryKey),
    );
  baselineBlockedTransfers = baselineTransferPlans.filter(
    (row) => row.action === 'blocked_partial_balance',
  );
  baselineTotalWei = baselineTransfers.reduce(
    (sum, row) => sum + row.transferAmountWei,
    0n,
  );
}

const nowBlock = await provider.getBlock('latest');
if (!nowBlock) {
  throw new Error('Unable to fetch latest block on Base');
}

const nowTimestamp = Number(nowBlock.timestamp);
const involvedAccounts = [...new Set(aggregatedEntries.map((entry) => entry.account))].sort();
const existingLockEntries = await loadExistingLockEntries(lockup, involvedAccounts);
const desiredEntryCounts = new Map();
for (const entry of aggregatedEntries) {
  const key = buildLockEntryKey(entry);
  desiredEntryCounts.set(key, (desiredEntryCounts.get(key) ?? 0) + 1);
}

const existingEntriesByKey = new Map();
for (const entry of existingLockEntries) {
  const key = buildLockEntryKey(entry);
  const rows = existingEntriesByKey.get(key) ?? [];
  rows.push(entry);
  existingEntriesByKey.set(key, rows);
}

const unexpectedExistingEntries = [];
for (const [key, rows] of existingEntriesByKey.entries()) {
  const desiredCount = desiredEntryCounts.get(key) ?? 0;
  if (rows.length > desiredCount) {
    unexpectedExistingEntries.push(...rows.slice(desiredCount));
  }
}

if (unexpectedExistingEntries.length > 0) {
  throw new Error(
    `Unexpected existing lockup entries found: ${unexpectedExistingEntries
      .map(
        (entry) =>
          `${entry.account}@${entry.unlockAt}:${entry.amountWei.toString()}:claimed=${entry.claimed}:index=${entry.index}`,
      )
      .join(' | ')}`,
  );
}

const existingEntryUsage = new Map();
const alreadyPresentEntries = [];
const pendingEntries = [];

for (const entry of aggregatedEntries) {
  const key = buildLockEntryKey(entry);
  const matchedExisting = existingEntriesByKey.get(key)?.length ?? 0;
  const usedCount = existingEntryUsage.get(key) ?? 0;
  if (usedCount < matchedExisting) {
    existingEntryUsage.set(key, usedCount + 1);
    alreadyPresentEntries.push(entry);
  } else {
    pendingEntries.push(entry);
  }
}

const eligibleEntries = pendingEntries.filter(
  (entry) => entry.unlockTimestamp > nowTimestamp,
);
const expiredEntries = pendingEntries.filter(
  (entry) => entry.unlockTimestamp <= nowTimestamp,
);

const lockupOwner = getAddress(await lockup.owner());
const lockupToken = getAddress(await lockup.token());
if (lockupToken !== tokenAddress) {
  throw new Error(
    `Lockup token mismatch: contract points to ${lockupToken}, expected ${tokenAddress}`,
  );
}

if (lockupOwner !== signerAddress) {
  throw new Error(
    `Signer ${signerAddress} is not the lockup owner ${lockupOwner}. Use the owner key.`,
  );
}

const totalAmountWei = eligibleEntries.reduce(
  (sum, entry) => sum + entry.amountWei,
  0n,
);
const totalRequiredWei =
  totalAmountWei +
  (values.transferBaselineAfterLockups ? baselineTotalWei : 0n);
const balanceWei = await token.balanceOf(signerAddress);
const allowanceWei = await token.allowance(signerAddress, lockupAddress);

if (values.transferBaselineAfterLockups && missingBeneficiaries.length > 0) {
  throw new Error(
    `Cannot transfer baseline amounts. Missing beneficiary addresses for: ${missingBeneficiaries.join(', ')}`,
  );
}

if (values.transferBaselineAfterLockups && !hasBeneficiariesConfig) {
  throw new Error(
    `Cannot transfer baseline amounts without beneficiaries config: ${values.beneficiaries}`,
  );
}

if (values.transferBaselineAfterLockups && !plan) {
  throw new Error('Cannot transfer baseline amounts without a validated plan.');
}

if (values.transferBaselineAfterLockups && baselineBlockedTransfers.length > 0) {
  throw new Error(
    `Cannot transfer baseline amounts because some beneficiary balances are partially funded: ${baselineBlockedTransfers
      .map(
        (row) =>
          `${row.beneficiaryKey}(${row.address}) current=${row.currentBalanceWei} expected=${row.expectedAmountWei}`,
      )
      .join(' | ')}`,
  );
}

if (balanceWei < totalRequiredWei) {
  throw new Error(
    `Insufficient token balance. Need ${totalRequiredWei}, have ${balanceWei}.`,
  );
}

const batches = splitBatches(eligibleEntries, batchSize).map((entries, index) => ({
  batchIndex: index,
  entryCount: entries.length,
  totalAmountWei: entries.reduce((sum, entry) => sum + entry.amountWei, 0n),
  accounts: entries.map((entry) => entry.account),
  amounts: entries.map((entry) => entry.amountWei.toString()),
  unlockTimes: entries.map((entry) => entry.unlockTimestamp),
  unlockAtRange: [entries[0]?.unlockAt ?? null, entries.at(-1)?.unlockAt ?? null],
  entries,
}));

let preflightStatus = 'ready';
if (allowanceWei >= totalAmountWei) {
  await preflightBatches(lockup, batches, {
    signerAddress,
    token,
    ownerAddress: signerAddress,
    spenderAddress: lockupAddress,
  });
} else if (!values.execute) {
  preflightStatus = 'skipped_missing_allowance';
} else if (values.approveIfNeeded) {
  preflightStatus = 'deferred_until_after_approve';
} else {
  preflightStatus = 'blocked_missing_allowance';
}

await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, 'lockup-batches.preview.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      lockupAddress,
      tokenAddress,
      signer: signerAddress,
      latestBlockTimestamp: nowTimestamp,
      existingEntryCount: existingLockEntries.length,
      alreadyPresentEntryCount: alreadyPresentEntries.length,
      pendingEntryCount: pendingEntries.length,
      expiredEntryCount: expiredEntries.length,
      eligibleEntryCount: eligibleEntries.length,
      totalAmountWei: totalAmountWei.toString(),
      preflightStatus,
      batches: batches.map((batch) => ({
        batchIndex: batch.batchIndex,
        entryCount: batch.entryCount,
        totalAmountWei: batch.totalAmountWei.toString(),
        accounts: batch.accounts,
        amounts: batch.amounts,
        unlockTimes: batch.unlockTimes,
        unlockAtRange: batch.unlockAtRange,
        estimatedGas: batch.estimatedGas,
        entries: batch.entries.map((entry) => ({
          account: entry.account,
          unlockAt: entry.unlockAt,
          unlockTimestamp: entry.unlockTimestamp,
          amountWei: entry.amountWei.toString(),
          categories: entry.categories,
          sourceLabels: entry.sourceLabels,
        })),
      })),
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(outputDir, 'baseline-transfers.preview.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      signer: signerAddress,
      transferBaselineAfterLockups: values.transferBaselineAfterLockups,
      entryCount: baselineTransferPlans.length,
      sendEntryCount: baselineTransfers.length,
      blockedEntryCount: baselineBlockedTransfers.length,
      totalAmountWei: baselineTotalWei.toString(),
      transfers: baselineTransferPlans.map((entry) => ({
        beneficiaryKey: entry.beneficiaryKey,
        categoryName: entry.categoryName,
        address: entry.address,
        expectedAmountWei: entry.expectedAmountWei.toString(),
        currentBalanceWei: entry.currentBalanceWei.toString(),
        transferAmountWei: entry.transferAmountWei.toString(),
        amountTokens: entry.amountTokens,
        action: entry.action,
      })),
    },
    null,
    2,
  )}\n`,
);

console.log(`Signer: ${signerAddress}`);
console.log(`Lockup owner: ${lockupOwner}`);
console.log(`Token balance: ${formatWeiAmount(balanceWei)} ILY`);
console.log(`Allowance: ${formatWeiAmount(allowanceWei)} ILY`);
console.log(`Existing lockup entries already on-chain: ${alreadyPresentEntries.length}`);
console.log(`Eligible entries: ${eligibleEntries.length}`);
console.log(`Expired entries skipped: ${expiredEntries.length}`);
console.log(`Total amount to lock: ${formatWeiAmount(totalAmountWei)} ILY`);
if (baselineTransfers.length > 0) {
  console.log(
    `Immediate transfers to send: ${baselineTransfers.length} entries / ${formatWeiAmount(
      baselineTotalWei,
    )} ILY`,
  );
}
const skippedBaselineTransfers = baselineTransferPlans.filter(
  (row) => row.action !== 'send_full',
);
if (skippedBaselineTransfers.length > 0) {
  console.log(
    `Immediate transfers skipped/blocked: ${skippedBaselineTransfers
      .map((row) => `${row.beneficiaryKey}:${row.action}`)
      .join(', ')}`,
  );
}
console.log(`Batches: ${batches.length} (batch size ${batchSize})`);
if (hasExecutionCsv) {
  console.log(`Execution CSV: ${path.resolve(values.executionCsv)}`);
}
if (executionVerification) {
  console.log(
    `Execution CSV verified against plan: ${executionVerification.rowCount} rows`,
  );
}
if (preflightStatus === 'skipped_missing_allowance') {
  console.log(
    'Preflight lockBatch simulation skipped because allowance is below the required amount in dry-run mode.',
  );
}
if (values.transferBaselineAfterLockups) {
  console.log('Immediate transfers will run after all lockBatch transactions complete.');
}

if (!values.execute) {
  console.log(
    'Dry-run complete. Re-run with --execute to broadcast approval and lockBatch transactions.',
  );
  process.exit(0);
}

if (allowanceWei < totalAmountWei) {
  if (!values.approveIfNeeded) {
    throw new Error(
      `Allowance ${allowanceWei} is below required amount ${totalAmountWei}. Re-run with --approve-if-needed.`,
    );
  }

  const approveTx = await token.approve(lockupAddress, totalAmountWei);
  console.log(`Approve tx: ${approveTx.hash}`);
  await approveTx.wait(confirmations);
  const syncedAllowanceWei = await waitForAllowanceAtLeast({
    token,
    owner: signerAddress,
    spender: lockupAddress,
    minAllowanceWei: totalAmountWei,
  });
  console.log(`Allowance after approve: ${formatWeiAmount(syncedAllowanceWei)} ILY`);
  await preflightBatches(lockup, batches, {
    signerAddress,
    token,
    ownerAddress: signerAddress,
    spenderAddress: lockupAddress,
  });
  preflightStatus = 'ready_after_approve';
}

const receipts = [];
for (const batch of batches) {
  const tx = await lockup.lockBatch(
    batch.accounts,
    batch.amounts,
    batch.unlockTimes,
    batch.estimatedGas
      ? { gasLimit: (BigInt(batch.estimatedGas) * 120n) / 100n }
      : {},
  );
  console.log(
    `lockBatch batch=${batch.batchIndex} entries=${batch.entryCount} tx=${tx.hash}`,
  );
  const receipt = await tx.wait(confirmations);
  receipts.push({
    batchIndex: batch.batchIndex,
    txHash: tx.hash,
    gasUsed: receipt?.gasUsed?.toString() ?? null,
  });
}

const baselineReceipts = [];
if (values.transferBaselineAfterLockups) {
  for (const transfer of baselineTransfers) {
    const tx = await token.transfer(transfer.address, transfer.transferAmountWei);
    console.log(
      `baseline transfer beneficiary=${transfer.beneficiaryKey} amount=${transfer.amountTokens} tx=${tx.hash}`,
    );
    const receipt = await tx.wait(confirmations);
    baselineReceipts.push({
      beneficiaryKey: transfer.beneficiaryKey,
      categoryName: transfer.categoryName,
      address: transfer.address,
      amountWei: transfer.transferAmountWei.toString(),
      amountTokens: transfer.amountTokens,
      txHash: tx.hash,
      gasUsed: receipt?.gasUsed?.toString() ?? null,
    });
  }

  await writeFile(
    path.join(outputDir, 'baseline-transfers.applied.json'),
    `${JSON.stringify(
      {
        appliedAt: new Date().toISOString(),
        signer: signerAddress,
        totalAmountWei: baselineTotalWei.toString(),
        skipped: skippedBaselineTransfers.map((row) => ({
          beneficiaryKey: row.beneficiaryKey,
          categoryName: row.categoryName,
          address: row.address,
          expectedAmountWei: row.expectedAmountWei.toString(),
          currentBalanceWei: row.currentBalanceWei.toString(),
          action: row.action,
        })),
        receipts: baselineReceipts,
      },
      null,
      2,
    )}\n`,
  );
}

await writeFile(
  path.join(outputDir, 'lockup-batches.applied.json'),
  `${JSON.stringify(
    {
      appliedAt: new Date().toISOString(),
      lockupAddress,
      signer: signerAddress,
      totalAmountWei: totalAmountWei.toString(),
      receipts,
    },
    null,
    2,
  )}\n`,
);

console.log('Lockup execution complete.');
