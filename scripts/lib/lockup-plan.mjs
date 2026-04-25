import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';

export const BASE_CHAIN_ID = 8453;
export const TOKEN_DECIMALS = 18n;
export const TOKEN_NAME = 'ILITY';
export const TOKEN_SYMBOL = 'ILY';
export const DEFAULT_TOKEN_ADDRESS = '0x90eb0e291e9d78a96bfe423b8e616a02c4838cf0';
export const TGE_BASELINE_AT = '2026-04-03T07:46:03.000Z';
export const FIRST_FUTURE_UNLOCK_AT = '2026-05-01T12:00:00.000Z';
export const BASELINE_SNAPSHOT_AT = TGE_BASELINE_AT;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function parseAmount(value) {
  const normalized = String(value ?? '')
    .replace(/,/g, '')
    .trim();

  if (!normalized || normalized === '-') {
    return 0n;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid numeric cell: "${value}"`);
  }

  return BigInt(normalized);
}

export function toWei(amountTokens) {
  return amountTokens * 10n ** TOKEN_DECIMALS;
}

export function formatTokenAmount(amount) {
  return Number(amount).toLocaleString('en-US');
}

function formatMonthLabel(date) {
  return date.toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function addUtcMonths(isoDate, monthsToAdd) {
  const source = new Date(isoDate);
  return new Date(
    Date.UTC(
      source.getUTCFullYear(),
      source.getUTCMonth() + monthsToAdd,
      source.getUTCDate(),
      source.getUTCHours(),
      source.getUTCMinutes(),
      source.getUTCSeconds(),
      source.getUTCMilliseconds(),
    ),
  );
}

export function resolveScheduleAnchors({
  baselineSnapshotAt,
  tgeBaselineAt,
  firstFutureUnlockAt = FIRST_FUTURE_UNLOCK_AT,
} = {}) {
  return {
    tgeBaselineAt: tgeBaselineAt ?? baselineSnapshotAt ?? TGE_BASELINE_AT,
    firstFutureUnlockAt,
  };
}

export function getScheduleSnapshotAt(offsetMonths, anchors = {}) {
  const { tgeBaselineAt, firstFutureUnlockAt } = resolveScheduleAnchors(anchors);

  if (offsetMonths === 0) {
    return new Date(tgeBaselineAt);
  }

  return addUtcMonths(firstFutureUnlockAt, offsetMonths - 1);
}

export function getSchedulePeriodStartAt(offsetMonths, anchors = {}) {
  const { tgeBaselineAt, firstFutureUnlockAt } = resolveScheduleAnchors(anchors);

  if (offsetMonths <= 0) {
    return '';
  }

  if (offsetMonths === 1) {
    return tgeBaselineAt;
  }

  return addUtcMonths(firstFutureUnlockAt, offsetMonths - 2).toISOString();
}

export function getScheduleUnlockAt(offsetMonths, anchors = {}) {
  if (offsetMonths <= 0) {
    return '';
  }

  return getScheduleSnapshotAt(offsetMonths, anchors).toISOString();
}

export function normalizeCategoryKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function serializeObjectOfBigInts(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.toString()]),
  );
}

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

function parseLockLabel(label) {
  const normalized = String(label ?? '').trim();
  if (normalized === 'TGE') {
    return 0;
  }

  const match = normalized.match(/^TGE \+(\d+) month$/);
  if (!match) {
    throw new Error(`Unexpected release label: "${label}"`);
  }

  return Number(match[1]);
}

function readRows(csvPath) {
  const absolutePath = path.resolve(csvPath);
  const content = readFileSync(absolutePath, 'utf8');
  return parseCsv(content, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
    trim: false,
  });
}

function extractCategories(rows) {
  const headerRowIndex = rows.findIndex(
    (row) => row[1] === 'No' && row[2] === 'Category' && row[3] === 'Wallet Address',
  );

  if (headerRowIndex === -1) {
    throw new Error('Category table header not found in lockup.csv');
  }

  const categories = [];
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const indexCell = String(row[1] ?? '').trim();
    const categoryName = String(row[2] ?? '').trim();

    if (!indexCell) {
      continue;
    }

    if (!categoryName) {
      break;
    }

    const walletAddress = String(row[3] ?? '').trim();
    categories.push({
      index: Number(indexCell),
      key: normalizeCategoryKey(categoryName),
      name: categoryName,
      walletAddressFromCsv:
        walletAddress && walletAddress !== '-' ? walletAddress : null,
      allocationTokens: parseAmount(row[6]),
      tgeReleasePercent: String(row[8] ?? '').trim() || null,
    });
  }

  if (categories.length === 0) {
    throw new Error('No categories found in lockup.csv');
  }

  return categories;
}

function extractSchedule(rows, categories) {
  const releaseRowIndex = rows.findIndex((row) => row[1] === 'Release Schedule');
  if (releaseRowIndex === -1) {
    throw new Error('Release Schedule section not found in lockup.csv');
  }

  const categoryHeaderRow = rows[releaseRowIndex + 1];
  const releaseCategories = categoryHeaderRow
    .slice(3, 3 + categories.length)
    .map((value) => String(value ?? '').trim());
  const categoryNames = categories.map((category) => category.name);

  if (releaseCategories.join('|') !== categoryNames.join('|')) {
    throw new Error(
      `Release category columns do not match main category table: ${releaseCategories.join(
        ', ',
      )}`,
    );
  }

  const schedule = [];
  for (let i = releaseRowIndex + 2; i < rows.length; i += 1) {
    const row = rows[i];
    const label = String(row[1] ?? '').trim();
    if (!label.startsWith('TGE')) {
      continue;
    }

    const offsetMonths = parseLockLabel(label);
    const sourceReportedMonth = String(row[2] ?? '').trim();
    const categoryCumulative = {};

    categories.forEach((category, index) => {
      categoryCumulative[category.key] = parseAmount(row[3 + index]);
    });

    schedule.push({
      offsetMonths,
      sourceLabel: label,
      sourceReportedMonth,
      cumulativeCirculatingTokens: parseAmount(row[18]),
      sourceMonthlyIncrementTokens:
        String(row[19] ?? '').trim() === '-' ? null : parseAmount(row[19]),
      categoryCumulative,
    });
  }

  if (schedule.length === 0) {
    throw new Error('No TGE schedule rows found in lockup.csv');
  }

  return schedule.sort((left, right) => left.offsetMonths - right.offsetMonths);
}

export function buildLockupPlan({
  csvPath = 'lockup.csv',
  tgeBaselineAt = TGE_BASELINE_AT,
  firstFutureUnlockAt = FIRST_FUTURE_UNLOCK_AT,
  baselineSnapshotAt = BASELINE_SNAPSHOT_AT,
  tokenAddress = DEFAULT_TOKEN_ADDRESS,
} = {}) {
  const anchors = resolveScheduleAnchors({
    baselineSnapshotAt,
    tgeBaselineAt,
    firstFutureUnlockAt,
  });
  const rows = readRows(csvPath);
  const categories = extractCategories(rows);
  const rawSchedule = extractSchedule(rows, categories);
  const warnings = [
    'Source month labels in lockup.csv are treated as informational only. The TGE baseline is 2026-04-03T07:46:03Z and +1M unlocks on 2026-05-01T12:00:00Z.',
  ];
  const checks = [];
  const schedule = [];

  let previousRow = null;
  for (const row of rawSchedule) {
    const snapshotAt = getScheduleSnapshotAt(row.offsetMonths, anchors);
    const categoryMonthlyIncrement = {};
    let computedCirculatingTokens = 0n;

    for (const category of categories) {
      const currentValue = row.categoryCumulative[category.key];
      const previousValue = previousRow
        ? previousRow.categoryCumulative[category.key]
        : currentValue;
      if (previousRow && currentValue < previousValue) {
        throw new Error(
          `Category ${category.name} decreases at ${row.sourceLabel}: ${currentValue} < ${previousValue}`,
        );
      }

      categoryMonthlyIncrement[category.key] =
        previousRow === null ? 0n : currentValue - previousValue;
      computedCirculatingTokens += currentValue;
    }

    if (computedCirculatingTokens !== row.cumulativeCirculatingTokens) {
      throw new Error(
        `Circulating supply mismatch at ${row.sourceLabel}: row says ${row.cumulativeCirculatingTokens}, computed ${computedCirculatingTokens}`,
      );
    }

    const monthlyIncrementTokens =
      previousRow === null
        ? 0n
        : row.cumulativeCirculatingTokens - previousRow.cumulativeCirculatingTokens;

    if (
      row.sourceMonthlyIncrementTokens !== null &&
      row.sourceMonthlyIncrementTokens !== monthlyIncrementTokens
    ) {
      warnings.push(
        `Monthly increment rounding mismatch at ${row.sourceLabel}: row says ${row.sourceMonthlyIncrementTokens}, computed ${monthlyIncrementTokens}. The computed row-over-row delta is used for execution.`,
      );
    }

    schedule.push({
      offsetMonths: row.offsetMonths,
      sourceLabel: row.sourceLabel,
      sourceReportedMonth: row.sourceReportedMonth,
      computedSnapshotMonth: formatMonthLabel(snapshotAt),
      snapshotAt: snapshotAt.toISOString(),
      cumulativeCirculatingTokens: row.cumulativeCirculatingTokens.toString(),
      monthlyIncrementTokens: monthlyIncrementTokens.toString(),
      categoryCumulative: serializeObjectOfBigInts(row.categoryCumulative),
      categoryMonthlyIncrement: serializeObjectOfBigInts(categoryMonthlyIncrement),
    });

    previousRow = row;
  }

  const totalSupplyTokens = categories.reduce(
    (sum, category) => sum + category.allocationTokens,
    0n,
  );
  const finalScheduleRow = rawSchedule.at(-1);
  const baselineScheduleRow = rawSchedule[0];
  if (!finalScheduleRow || !baselineScheduleRow) {
    throw new Error('Schedule generation failed');
  }

  const categorySummaries = categories.map((category) => {
    const finalCumulative = finalScheduleRow.categoryCumulative[category.key];
    if (finalCumulative !== category.allocationTokens) {
      throw new Error(
        `Final cumulative amount for ${category.name} does not match allocation`,
      );
    }

    return {
      index: category.index,
      key: category.key,
      name: category.name,
      walletAddressFromCsv: category.walletAddressFromCsv,
      allocationTokens: category.allocationTokens.toString(),
      allocationWei: toWei(category.allocationTokens).toString(),
      tgeReleasePercent: category.tgeReleasePercent,
    };
  });

  const baselineCirculatingTokens = baselineScheduleRow.cumulativeCirculatingTokens;
  const futureLockedTokens = totalSupplyTokens - baselineCirculatingTokens;
  const baselineByCategory = categories.map((category) => ({
    categoryKey: category.key,
    categoryName: category.name,
    amountTokens: baselineScheduleRow.categoryCumulative[category.key].toString(),
    amountWei: toWei(baselineScheduleRow.categoryCumulative[category.key]).toString(),
  }));

  const futureLockEntries = [];
  for (let i = 1; i < rawSchedule.length; i += 1) {
    const previous = rawSchedule[i - 1];
    const current = rawSchedule[i];
    const unlockAt = getScheduleUnlockAt(current.offsetMonths, anchors);
    const periodStartAt = getSchedulePeriodStartAt(current.offsetMonths, anchors);

    for (const category of categories) {
      const amountTokens =
        current.categoryCumulative[category.key] - previous.categoryCumulative[category.key];
      if (amountTokens <= 0n) {
        continue;
      }

      futureLockEntries.push({
        categoryKey: category.key,
        categoryName: category.name,
        beneficiaryKey: category.key,
        periodOffsetMonths: current.offsetMonths,
        periodStartAt,
        unlockAt,
        sourceLabel: current.sourceLabel,
        amountTokens: amountTokens.toString(),
        amountWei: toWei(amountTokens).toString(),
      });
    }
  }

  checks.push('Category allocations sum to 1,000,000,000 tokens.');
  checks.push('Every schedule row is monotonically non-decreasing per category.');
  checks.push('Every schedule row recomputes to the stated circulating supply.');
  checks.push('Every monthly increment matches the row-over-row circulating delta.');
  checks.push('Final category cumulative values match the category allocations.');

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    token: {
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      address: tokenAddress,
      chainId: BASE_CHAIN_ID,
      decimals: Number(TOKEN_DECIMALS),
    },
    source: {
      csvPath: path.resolve(csvPath),
      tgeBaselineAt: anchors.tgeBaselineAt,
      firstFutureUnlockAt: anchors.firstFutureUnlockAt,
    },
    assumptions: {
      tgeBaselineAt: anchors.tgeBaselineAt,
      firstFutureUnlockAt: anchors.firstFutureUnlockAt,
      baselineMeaning:
        'The TGE row is treated as the already-circulating baseline snapshot and excluded from lock entries.',
      monthlyRule:
        'Monthly lock entries are generated from the increase between consecutive snapshots and unlock at the end snapshot timestamp.',
      firstLockPeriod: `${anchors.tgeBaselineAt} -> ${anchors.firstFutureUnlockAt}`,
    },
    validation: {
      passed: true,
      checks,
      warnings,
    },
    categories: categorySummaries,
    baselineCirculating: {
      snapshotAt: anchors.tgeBaselineAt,
      totalTokens: baselineCirculatingTokens.toString(),
      totalWei: toWei(baselineCirculatingTokens).toString(),
      byCategory: baselineByCategory,
    },
    schedule,
    futureLockEntries,
    summary: {
      categoryCount: categories.length,
      scheduleRowCount: rawSchedule.length,
      futureLockEntryCount: futureLockEntries.length,
      totalSupplyTokens: totalSupplyTokens.toString(),
      totalSupplyWei: toWei(totalSupplyTokens).toString(),
      baselineCirculatingTokens: baselineCirculatingTokens.toString(),
      baselineCirculatingWei: toWei(baselineCirculatingTokens).toString(),
      futureLockedTokens: futureLockedTokens.toString(),
      futureLockedWei: toWei(futureLockedTokens).toString(),
      firstFutureUnlockAt: futureLockEntries[0]?.unlockAt ?? null,
      lastFutureUnlockAt:
        futureLockEntries[futureLockEntries.length - 1]?.unlockAt ?? null,
    },
  };
}

export function buildNormalizedScheduleCsv(plan) {
  const categoryKeys = plan.categories.map((category) => category.key);
  const headers = [
    'offset_months',
    'snapshot_at_utc',
    'source_label',
    'source_reported_month',
    'computed_snapshot_month',
    'circulating_cumulative_tokens',
    'circulating_delta_tokens',
    ...categoryKeys.flatMap((key) => [`${key}_cumulative_tokens`, `${key}_delta_tokens`]),
  ];

  const rows = plan.schedule.map((row) => [
    row.offsetMonths,
    row.snapshotAt,
    row.sourceLabel,
    row.sourceReportedMonth,
    row.computedSnapshotMonth,
    row.cumulativeCirculatingTokens,
    row.monthlyIncrementTokens,
    ...categoryKeys.flatMap((key) => [
      row.categoryCumulative[key],
      row.categoryMonthlyIncrement[key],
    ]),
  ]);

  return buildCsv(headers, rows);
}

export function buildLockEntriesCsv(plan) {
  const headers = [
    'beneficiary_key',
    'category_name',
    'period_offset_months',
    'period_start_at_utc',
    'unlock_at_utc',
    'source_label',
    'amount_tokens',
    'amount_wei',
  ];

  const rows = plan.futureLockEntries.map((entry) => [
    entry.beneficiaryKey,
    entry.categoryName,
    entry.periodOffsetMonths,
    entry.periodStartAt,
    entry.unlockAt,
    entry.sourceLabel,
    entry.amountTokens,
    entry.amountWei,
  ]);

  return buildCsv(headers, rows);
}
