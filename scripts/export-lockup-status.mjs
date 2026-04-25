import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { Contract, JsonRpcProvider, formatUnits, getAddress } from 'ethers';
import {
  DEFAULT_TOKEN_ADDRESS,
  formatTokenAmount,
} from './lib/lockup-plan.mjs';
import {
  buildExecutionRows,
  loadJson,
  loadPlan,
  resolveBeneficiaryAddresses,
} from './lib/execution-csv.mjs';

dotenv.config();

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
];

const LOCKUP_ABI = [
  'function owner() view returns (address)',
  'function token() view returns (address)',
  'function lockupCount(address account) view returns (uint256)',
  'function lockedAmount(address account) view returns (uint256)',
  'function claimableAmount(address account) view returns (uint256)',
  'function lockupOf(address account, uint256 index) view returns (uint256 amount, uint256 unlockTime, bool claimed)',
];

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
  },
});

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[,"\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(headers, rows) {
  return [headers, ...rows]
    .map((row) => row.map((cell) => escapeCsv(cell)).join(','))
    .join('\n')
    .concat('\n');
}

function formatWeiAmount(amountWei) {
  return formatTokenAmount(BigInt(formatUnits(amountWei, 18).split('.')[0] || '0'));
}

function buildEntryKey({ address, unlockTimestamp, amountWei }) {
  return `${address.toLowerCase()}:${unlockTimestamp}:${amountWei.toString()}`;
}

if (!values.rpcUrl) {
  throw new Error('Missing Base RPC URL. Set BASE_RPC_URL or pass --rpcUrl.');
}

if (!values.lockupAddress) {
  throw new Error('Missing lockup contract address. Set LOCKUP_ADDRESS or pass --lockupAddress.');
}

const provider = new JsonRpcProvider(values.rpcUrl);
const lockupAddress = getAddress(values.lockupAddress);
const tokenAddress = getAddress(values.tokenAddress);
const plan = loadPlan({
  executionCsvPath: null,
  mergedCsvPath: values.mergedCsv,
  planPath: values.plan,
  tokenAddress,
});

if (!plan) {
  throw new Error('A validated plan is required to export and reconcile on-chain lockup status.');
}

const beneficiariesConfig = loadJson(values.beneficiaries);
const { addresses } = resolveBeneficiaryAddresses(plan, beneficiariesConfig, {
  allowMissing: false,
});
const expectedRows = buildExecutionRows(plan, addresses);
const categoryByKey = new Map(plan.categories.map((category) => [category.key, category]));
const categoryByAddress = new Map(
  [...addresses.entries()].map(([categoryKey, address]) => [address.toLowerCase(), categoryKey]),
);
const expectedByKey = new Map();

for (const row of expectedRows) {
  const key = buildEntryKey({
    address: row.address,
    unlockTimestamp: row.unlockTimestamp,
    amountWei: BigInt(row.amountWei),
  });
  const items = expectedByKey.get(key) ?? [];
  items.push(row);
  expectedByKey.set(key, items);
}

const lockup = new Contract(lockupAddress, LOCKUP_ABI, provider);
const token = new Contract(tokenAddress, ERC20_ABI, provider);
const latestBlock = await provider.getBlock('latest');

if (!latestBlock) {
  throw new Error('Unable to fetch latest block from RPC.');
}

const blockTimestamp = Number(latestBlock.timestamp);
const lockupOwner = getAddress(await lockup.owner());
const lockupToken = getAddress(await lockup.token());

if (lockupToken !== tokenAddress) {
  throw new Error(
    `Lockup token mismatch: contract points to ${lockupToken}, expected ${tokenAddress}`,
  );
}

const detailedRows = [];
const actualByKey = new Map();
const expectedUsage = new Map();
const summaryRows = [];

for (const [beneficiaryKey, address] of [...addresses.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const category = categoryByKey.get(beneficiaryKey);
  const count = Number(await lockup.lockupCount(address));
  const lockedAmountWei = BigInt(await lockup.lockedAmount(address));
  const claimableAmountWei = BigInt(await lockup.claimableAmount(address));
  const walletBalanceWei = BigInt(await token.balanceOf(address));
  const baselineAmountWei = BigInt(
    plan.baselineCirculating.byCategory.find((row) => row.categoryKey === beneficiaryKey)?.amountWei ?? 0n,
  );
  const expectedForAddress = expectedRows.filter((row) => row.address === address);
  let onchainTotalWei = 0n;
  let claimedTotalWei = 0n;
  let lockedEntryCount = 0;
  let claimableEntryCount = 0;
  let claimedEntryCount = 0;

  for (let index = 0; index < count; index += 1) {
    const [amount, unlockTime, claimed] = await lockup.lockupOf(address, index);
    const amountWei = BigInt(amount);
    const unlockTimestamp = Number(unlockTime);
    const unlockAt = new Date(unlockTimestamp * 1000).toISOString();
    const claimedFlag = Boolean(claimed);
    const isClaimable = !claimedFlag && unlockTimestamp <= blockTimestamp;
    const isLocked = !claimedFlag && unlockTimestamp > blockTimestamp;
    const key = buildEntryKey({ address, unlockTimestamp, amountWei });
    const seen = actualByKey.get(key) ?? [];
    seen.push({ address, unlockTimestamp, amountWei, index, claimed: claimedFlag });
    actualByKey.set(key, seen);

    const expectedCount = expectedByKey.get(key)?.length ?? 0;
    const usedCount = expectedUsage.get(key) ?? 0;
    const reconciliationStatus = usedCount < expectedCount ? 'matched_expected' : 'unexpected';
    if (usedCount < expectedCount) {
      expectedUsage.set(key, usedCount + 1);
    }

    onchainTotalWei += amountWei;
    if (claimedFlag) {
      claimedEntryCount += 1;
      claimedTotalWei += amountWei;
    } else if (isClaimable) {
      claimableEntryCount += 1;
    } else {
      lockedEntryCount += 1;
    }

    detailedRows.push({
      beneficiaryKey,
      categoryName: category?.name ?? beneficiaryKey,
      address,
      index,
      unlockAt,
      unlockTimestamp,
      amountWei,
      amountTokens: formatWeiAmount(amountWei),
      claimed: claimedFlag,
      statusNow: claimedFlag ? 'claimed' : isClaimable ? 'claimable' : 'locked',
      reconciliationStatus,
    });
  }

  summaryRows.push({
    beneficiaryKey,
    categoryName: category?.name ?? beneficiaryKey,
    address,
    lockupCount: count,
    expectedLockupCount: expectedForAddress.length,
    lockedEntryCount,
    claimableEntryCount,
    claimedEntryCount,
    lockedAmountWei,
    claimableAmountWei,
    claimedAmountWei: claimedTotalWei,
    onchainTotalWei,
    expectedTotalWei: expectedForAddress.reduce((sum, row) => sum + BigInt(row.amountWei), 0n),
    walletBalanceWei,
    baselineExpectedWei: baselineAmountWei,
    lockupCountMatchesExpected: count === expectedForAddress.length,
    onchainTotalMatchesExpected:
      onchainTotalWei === expectedForAddress.reduce((sum, row) => sum + BigInt(row.amountWei), 0n),
    baselineMatchesWallet: walletBalanceWei === baselineAmountWei,
  });
}

const reconciliationRows = [];
for (const row of expectedRows) {
  const key = buildEntryKey({
    address: row.address,
    unlockTimestamp: row.unlockTimestamp,
    amountWei: BigInt(row.amountWei),
  });
  const actualCount = actualByKey.get(key)?.length ?? 0;
  const usedCount = reconciliationRows.filter(
    (entry) =>
      entry.address === row.address &&
      entry.unlockTimestamp === row.unlockTimestamp &&
      entry.amountWei === row.amountWei,
  ).length;
  const status = usedCount < actualCount ? 'matched_onchain' : 'missing_onchain';

  reconciliationRows.push({
    address: row.address,
    beneficiaryKeys: row.beneficiaryKeys.join('|'),
    categoryNames: row.categoryNames.join('|'),
    unlockAt: row.unlockAt,
    unlockTimestamp: row.unlockTimestamp,
    amountTokens: row.amountTokens,
    amountWei: row.amountWei,
    status,
  });
}

for (const [key, items] of actualByKey.entries()) {
  const expectedCount = expectedByKey.get(key)?.length ?? 0;
  if (items.length <= expectedCount) {
    continue;
  }

  for (let index = expectedCount; index < items.length; index += 1) {
    const item = items[index];
    const address = getAddress(item.address);
    const beneficiaryKey = categoryByAddress.get(address.toLowerCase()) ?? 'unknown';
    const category = categoryByKey.get(beneficiaryKey);
    reconciliationRows.push({
      address,
      beneficiaryKeys: beneficiaryKey,
      categoryNames: category?.name ?? beneficiaryKey,
      unlockAt: new Date(item.unlockTimestamp * 1000).toISOString(),
      unlockTimestamp: item.unlockTimestamp,
      amountTokens: formatWeiAmount(item.amountWei),
      amountWei: item.amountWei.toString(),
      status: 'unexpected_onchain',
    });
  }
}

reconciliationRows.sort((left, right) => {
  if (left.unlockTimestamp !== right.unlockTimestamp) {
    return left.unlockTimestamp - right.unlockTimestamp;
  }
  if (left.address !== right.address) {
    return left.address.localeCompare(right.address);
  }
  return left.amountWei.localeCompare(right.amountWei);
});

const outputDir = path.resolve(values.outputDir);
await mkdir(outputDir, { recursive: true });

const detailCsv = buildCsv(
  [
    'beneficiary_key',
    'category_name',
    'address',
    'lockup_index',
    'unlock_at_utc',
    'unlock_timestamp',
    'amount_tokens',
    'amount_wei',
    'claimed',
    'status_now',
    'reconciliation_status',
  ],
  detailedRows
    .sort((left, right) => {
      if (left.address !== right.address) {
        return left.address.localeCompare(right.address);
      }
      return left.index - right.index;
    })
    .map((row) => [
      row.beneficiaryKey,
      row.categoryName,
      row.address,
      row.index,
      row.unlockAt,
      row.unlockTimestamp,
      row.amountTokens,
      row.amountWei.toString(),
      row.claimed ? 'true' : 'false',
      row.statusNow,
      row.reconciliationStatus,
    ]),
);

const summaryCsv = buildCsv(
  [
    'beneficiary_key',
    'category_name',
    'address',
    'lockup_count',
    'expected_lockup_count',
    'locked_entry_count',
    'claimable_entry_count',
    'claimed_entry_count',
    'locked_amount_tokens',
    'locked_amount_wei',
    'claimable_amount_tokens',
    'claimable_amount_wei',
    'claimed_amount_tokens',
    'claimed_amount_wei',
    'onchain_total_tokens',
    'onchain_total_wei',
    'expected_total_tokens',
    'expected_total_wei',
    'wallet_balance_tokens',
    'wallet_balance_wei',
    'baseline_expected_tokens',
    'baseline_expected_wei',
    'lockup_count_matches_expected',
    'onchain_total_matches_expected',
    'baseline_matches_wallet',
  ],
  summaryRows.map((row) => [
    row.beneficiaryKey,
    row.categoryName,
    row.address,
    row.lockupCount,
    row.expectedLockupCount,
    row.lockedEntryCount,
    row.claimableEntryCount,
    row.claimedEntryCount,
    formatWeiAmount(row.lockedAmountWei),
    row.lockedAmountWei.toString(),
    formatWeiAmount(row.claimableAmountWei),
    row.claimableAmountWei.toString(),
    formatWeiAmount(row.claimedAmountWei),
    row.claimedAmountWei.toString(),
    formatWeiAmount(row.onchainTotalWei),
    row.onchainTotalWei.toString(),
    formatWeiAmount(row.expectedTotalWei),
    row.expectedTotalWei.toString(),
    formatWeiAmount(row.walletBalanceWei),
    row.walletBalanceWei.toString(),
    formatWeiAmount(row.baselineExpectedWei),
    row.baselineExpectedWei.toString(),
    row.lockupCountMatchesExpected ? 'true' : 'false',
    row.onchainTotalMatchesExpected ? 'true' : 'false',
    row.baselineMatchesWallet ? 'true' : 'false',
  ]),
);

const reconciliationCsv = buildCsv(
  [
    'address',
    'beneficiary_keys',
    'category_names',
    'unlock_at_utc',
    'unlock_timestamp',
    'amount_tokens',
    'amount_wei',
    'status',
  ],
  reconciliationRows.map((row) => [
    row.address,
    row.beneficiaryKeys,
    row.categoryNames,
    row.unlockAt,
    row.unlockTimestamp,
    row.amountTokens,
    row.amountWei,
    row.status,
  ]),
);

await writeFile(path.join(outputDir, 'onchain-lockup-entries.csv'), detailCsv);
await writeFile(path.join(outputDir, 'onchain-lockup-summary.csv'), summaryCsv);
await writeFile(path.join(outputDir, 'onchain-lockup-reconciliation.csv'), reconciliationCsv);
await writeFile(
  path.join(outputDir, 'onchain-lockup-status.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      rpcUrl: values.rpcUrl,
      lockupAddress,
      tokenAddress,
      lockupOwner,
      latestBlockNumber: latestBlock.number,
      latestBlockTimestamp: blockTimestamp,
      expectedRowCount: expectedRows.length,
      onchainRowCount: detailedRows.length,
      matchedRowCount: reconciliationRows.filter((row) => row.status === 'matched_onchain').length,
      missingRowCount: reconciliationRows.filter((row) => row.status === 'missing_onchain').length,
      unexpectedRowCount: reconciliationRows.filter((row) => row.status === 'unexpected_onchain').length,
      outputs: {
        detailCsv: path.join(outputDir, 'onchain-lockup-entries.csv'),
        summaryCsv: path.join(outputDir, 'onchain-lockup-summary.csv'),
        reconciliationCsv: path.join(outputDir, 'onchain-lockup-reconciliation.csv'),
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`Lockup owner: ${lockupOwner}`);
console.log(`Latest block: ${latestBlock.number} @ ${new Date(blockTimestamp * 1000).toISOString()}`);
console.log(`On-chain lockup rows: ${detailedRows.length}`);
console.log(
  `Reconciliation: matched=${reconciliationRows.filter((row) => row.status === 'matched_onchain').length}, missing=${reconciliationRows.filter((row) => row.status === 'missing_onchain').length}, unexpected=${reconciliationRows.filter((row) => row.status === 'unexpected_onchain').length}`,
);
console.log(`Wrote ${path.join(outputDir, 'onchain-lockup-entries.csv')}`);
console.log(`Wrote ${path.join(outputDir, 'onchain-lockup-summary.csv')}`);
console.log(`Wrote ${path.join(outputDir, 'onchain-lockup-reconciliation.csv')}`);
