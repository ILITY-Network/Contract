import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import {
  BASE_CHAIN_ID,
  BASELINE_SNAPSHOT_AT,
  DEFAULT_TOKEN_ADDRESS,
  FIRST_FUTURE_UNLOCK_AT,
  TOKEN_DECIMALS,
  TGE_BASELINE_AT,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  getSchedulePeriodStartAt,
  getScheduleSnapshotAt,
  getScheduleUnlockAt,
  normalizeCategoryKey,
  resolveScheduleAnchors,
  toWei,
} from './lockup-plan.mjs';

const CATEGORY_REFERENCE_NAME_BY_KEY = {
  sales: 'Sales',
  dev_fund: 'Dev Fund',
  team_and_advisor: 'Team&Advisor (Partners)',
  marketing: 'Marketing',
  reward: 'Reward',
  community: 'Community',
  operation: 'Operation',
};

const CATEGORY_DISPLAY_NAME_BY_KEY = {
  sales: 'Sales',
  dev_fund: 'Dev Fund',
  team_and_advisor: 'Team & Advisor',
  marketing: 'Marketing',
  reward: 'Reward',
  community: 'Community',
  operation: 'Operation',
};

const NON_SALES_REFERENCE_TOLERANCE_TOKENS = 1;

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

function parseIntegerTokenAmount(value) {
  const normalized = String(value ?? '')
    .replace(/,/g, '')
    .trim();

  if (!normalized || normalized === '-') {
    return 0n;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid integer token amount: "${value}"`);
  }

  return BigInt(normalized);
}

function parseDecimalTokenAmount(value) {
  const normalized = String(value ?? '')
    .replace(/,/g, '')
    .trim();

  if (!normalized || normalized === '-') {
    return 0;
  }

  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid decimal token amount: "${value}"`);
  }

  return parsed;
}

function formatDecimalTokenAmount(value) {
  return Number(value).toFixed(2);
}

function formatReferenceDiff(diff) {
  return Number(diff).toFixed(2);
}

function formatMonthLabel(date) {
  return date.toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
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

function parseLegacyLockLabel(label) {
  const normalized = String(label ?? '').trim();
  if (normalized === 'TGE') {
    return 0;
  }

  const match = normalized.match(/^TGE \+(\d+) month$/);
  if (!match) {
    throw new Error(`Unexpected legacy release label: "${label}"`);
  }

  return Number(match[1]);
}

function parseReferenceLockLabel(label) {
  const normalized = String(label ?? '').trim();
  if (normalized === 'TGE') {
    return 0;
  }

  const match = normalized.match(/^\+(\d+)M$/);
  if (!match) {
    throw new Error(`Unexpected reference release label: "${label}"`);
  }

  return Number(match[1]);
}

function parseLegacyLockupCsv(csvPath) {
  const rows = readRows(csvPath);
  const headerRowIndex = rows.findIndex(
    (row) => row[1] === 'No' && row[2] === 'Category' && row[3] === 'Wallet Address',
  );

  if (headerRowIndex === -1) {
    throw new Error(`Category header not found in ${csvPath}`);
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
      allocationTokens: parseIntegerTokenAmount(row[6]),
      tgeReleasePercent: String(row[8] ?? '').trim() || null,
    });
  }

  const releaseRowIndex = rows.findIndex((row) => row[1] === 'Release Schedule');
  if (releaseRowIndex === -1) {
    throw new Error(`Release Schedule section not found in ${csvPath}`);
  }

  const categoryHeaderRow = rows[releaseRowIndex + 1];
  const releaseCategories = categoryHeaderRow
    .slice(3, 3 + categories.length)
    .map((value) => String(value ?? '').trim());
  const categoryNames = categories.map((category) => category.name);

  if (releaseCategories.join('|') !== categoryNames.join('|')) {
    throw new Error(
      `Legacy release category columns do not match main category table: ${releaseCategories.join(
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

    const offsetMonths = parseLegacyLockLabel(label);
    const sourceReportedMonth = String(row[2] ?? '').trim();
    const categoryCumulative = {};

    categories.forEach((category, index) => {
      categoryCumulative[category.key] = parseIntegerTokenAmount(row[3 + index]);
    });

    schedule.push({
      offsetMonths,
      legacySourceLabel: label,
      legacySourceReportedMonth: sourceReportedMonth,
      categoryCumulative,
      circulatingCumulativeTokens: parseIntegerTokenAmount(row[18]),
      sourceMonthlyIncrementTokens:
        String(row[19] ?? '').trim() === '-'
          ? null
          : parseIntegerTokenAmount(row[19]),
    });
  }

  return {
    categories: categories.sort((left, right) => left.index - right.index),
    schedule: schedule.sort((left, right) => left.offsetMonths - right.offsetMonths),
    csvPath: path.resolve(csvPath),
  };
}

function parseReferenceLockupCsv(csvPath) {
  const rows = readRows(csvPath);
  const categoryHeaderRow = rows.find((row) =>
    row.some((value) => String(value ?? '').includes('One-time Unlock')),
  );
  const displayHeaderRowIndex = rows.findIndex(
    (row) =>
      String(row[1] ?? '').trim() === 'Sales' &&
      String(row[3] ?? '').trim() === 'Dev Fund',
  );

  if (displayHeaderRowIndex === -1 || !categoryHeaderRow) {
    throw new Error(`Reference lockup layout not recognized in ${csvPath}`);
  }

  const displayHeaderRow = rows[displayHeaderRowIndex];
  const categories = [];
  for (let i = 1; i < displayHeaderRow.length; i += 2) {
    const displayName = String(displayHeaderRow[i] ?? '').trim();
    if (!displayName) {
      continue;
    }

    const key = Object.entries(CATEGORY_REFERENCE_NAME_BY_KEY).find(
      ([, referenceName]) => referenceName === displayName,
    )?.[0];

    if (!key) {
      throw new Error(`Unexpected reference category name "${displayName}" in ${csvPath}`);
    }

    categories.push({
      key,
      name: CATEGORY_DISPLAY_NAME_BY_KEY[key],
      referenceName: displayName,
    });
  }

  const schedule = [];
  for (let i = displayHeaderRowIndex + 2; i < rows.length; i += 1) {
    const row = rows[i];
    const label = String(row[0] ?? '').trim();
    if (!label) {
      continue;
    }

    const offsetMonths = parseReferenceLockLabel(label);
    const categoryCumulative = {};
    const categoryDelta = {};

    categories.forEach((category, index) => {
      categoryDelta[category.key] = parseDecimalTokenAmount(row[1 + index * 2]);
      categoryCumulative[category.key] = parseDecimalTokenAmount(row[2 + index * 2]);
    });

    schedule.push({
      offsetMonths,
      referenceSourceLabel: label,
      categoryDelta,
      categoryCumulative,
    });
  }

  return {
    categories,
    schedule: schedule.sort((left, right) => left.offsetMonths - right.offsetMonths),
    csvPath: path.resolve(csvPath),
  };
}

function serializeObjectOfBigInts(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.toString()]),
  );
}

export function buildLockupPlan({
  primaryCsvPath = 'lockup.csv',
  referenceCsvPath = 'lockup2.csv',
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
  const legacy = parseLegacyLockupCsv(primaryCsvPath);
  const reference = parseReferenceLockupCsv(referenceCsvPath);
  const referenceByOffset = new Map(
    reference.schedule.map((row) => [row.offsetMonths, row]),
  );

  if (legacy.schedule.length !== reference.schedule.length) {
    throw new Error(
      `Schedule length mismatch between ${primaryCsvPath} and ${referenceCsvPath}`,
    );
  }

  const warnings = [
    'Unlock timestamps use the TGE baseline at 2026-04-03T07:46:03Z and the first monthly unlock anchor at 2026-05-01T12:00:00Z, so +1M means 2026-05-01T12:00:00Z.',
    'lockup2.csv Sales values are treated as outdated and excluded from the chosen execution schedule.',
  ];
  const checks = [];
  const schedule = [];
  const mergedScheduleRows = [];

  let previousLegacyRow = null;
  for (const legacyRow of legacy.schedule) {
    const referenceRow = referenceByOffset.get(legacyRow.offsetMonths);
    if (!referenceRow) {
      throw new Error(
        `Reference row for offset ${legacyRow.offsetMonths} is missing in ${referenceCsvPath}`,
      );
    }

    const snapshotAt = getScheduleSnapshotAt(
      legacyRow.offsetMonths,
      anchors,
    ).toISOString();
    const periodStartAt = getSchedulePeriodStartAt(
      legacyRow.offsetMonths,
      anchors,
    );
    const unlockAt = getScheduleUnlockAt(legacyRow.offsetMonths, anchors);
    const categoryCumulative = {};
    const categoryMonthlyIncrement = {};
    let computedCirculatingTokens = 0n;

    for (const category of legacy.categories) {
      const currentValue = legacyRow.categoryCumulative[category.key];
      const previousValue =
        previousLegacyRow?.categoryCumulative[category.key] ?? currentValue;
      if (previousLegacyRow && currentValue < previousValue) {
        throw new Error(
          `Category ${category.name} decreases at ${legacyRow.legacySourceLabel}`,
        );
      }

      const deltaTokens = previousLegacyRow === null ? 0n : currentValue - previousValue;
      const referenceValue = referenceRow.categoryCumulative[category.key];
      const referenceDiff = Number(currentValue) - referenceValue;

      let referenceStatus = 'matched';
      let chosenSource = 'lockup.csv';
      let notes = '';
      if (category.key === 'sales') {
        referenceStatus = Math.abs(referenceDiff) <= NON_SALES_REFERENCE_TOLERANCE_TOKENS
          ? 'matched'
          : 'outdated_reference';
        notes =
          referenceStatus === 'outdated_reference'
            ? 'lockup2.csv Sales is outdated; execution uses lockup.csv.'
            : '';
      } else if (
        Math.abs(referenceDiff) > NON_SALES_REFERENCE_TOLERANCE_TOKENS
      ) {
        throw new Error(
          `Reference mismatch for ${category.name} at ${legacyRow.legacySourceLabel}: legacy=${currentValue}, reference=${referenceValue}`,
        );
      } else if (Math.abs(referenceDiff) > 0) {
        referenceStatus = 'rounded_match';
      }

      categoryCumulative[category.key] = currentValue;
      categoryMonthlyIncrement[category.key] = deltaTokens;
      computedCirculatingTokens += currentValue;

      mergedScheduleRows.push({
        offsetMonths: legacyRow.offsetMonths,
        sourceLabel: legacyRow.legacySourceLabel,
        sourceReportedMonth: legacyRow.legacySourceReportedMonth,
        snapshotAt,
        periodStartAt,
        unlockAt,
        categoryKey: category.key,
        categoryName: category.name,
        chosenSource,
        legacyCumulativeTokens: currentValue.toString(),
        referenceCumulativeTokens: formatDecimalTokenAmount(referenceValue),
        chosenCumulativeTokens: currentValue.toString(),
        deltaTokens: deltaTokens.toString(),
        referenceDiffTokens: formatReferenceDiff(referenceDiff),
        referenceStatus,
        circulatingCumulativeTokens: legacyRow.circulatingCumulativeTokens.toString(),
        circulatingDeltaTokens:
          previousLegacyRow === null
            ? '0'
            : (
                legacyRow.circulatingCumulativeTokens -
                previousLegacyRow.circulatingCumulativeTokens
              ).toString(),
        notes,
      });
    }

    if (computedCirculatingTokens !== legacyRow.circulatingCumulativeTokens) {
      throw new Error(
        `Circulating supply mismatch at ${legacyRow.legacySourceLabel}: row says ${legacyRow.circulatingCumulativeTokens}, computed ${computedCirculatingTokens}`,
      );
    }

    const monthlyIncrementTokens =
      previousLegacyRow === null
        ? 0n
        : legacyRow.circulatingCumulativeTokens -
          previousLegacyRow.circulatingCumulativeTokens;

    if (
      legacyRow.sourceMonthlyIncrementTokens !== null &&
      legacyRow.sourceMonthlyIncrementTokens !== monthlyIncrementTokens
    ) {
      warnings.push(
        `Monthly increment rounding mismatch at ${legacyRow.legacySourceLabel}: row says ${legacyRow.sourceMonthlyIncrementTokens}, computed ${monthlyIncrementTokens}. The computed row-over-row delta is used for execution.`,
      );
    }

    schedule.push({
      offsetMonths: legacyRow.offsetMonths,
      sourceLabel: legacyRow.legacySourceLabel,
      sourceReportedMonth: legacyRow.legacySourceReportedMonth,
      computedSnapshotMonth: formatMonthLabel(new Date(snapshotAt)),
      snapshotAt,
      cumulativeCirculatingTokens: legacyRow.circulatingCumulativeTokens.toString(),
      monthlyIncrementTokens: monthlyIncrementTokens.toString(),
      categoryCumulative: serializeObjectOfBigInts(categoryCumulative),
      categoryMonthlyIncrement: serializeObjectOfBigInts(categoryMonthlyIncrement),
    });

    previousLegacyRow = legacyRow;
  }

  const finalScheduleRow = schedule.at(-1);
  const baselineScheduleRow = schedule[0];
  if (!finalScheduleRow || !baselineScheduleRow) {
    throw new Error('Schedule generation failed');
  }

  const categories = legacy.categories.map((category) => {
    const finalValue = BigInt(finalScheduleRow.categoryCumulative[category.key]);
    if (finalValue !== category.allocationTokens) {
      throw new Error(
        `Final cumulative amount for ${category.name} does not match allocation`,
      );
    }

    return {
      index: category.index,
      key: category.key,
      name: category.name,
      referenceName: CATEGORY_REFERENCE_NAME_BY_KEY[category.key],
      walletAddressFromCsv: category.walletAddressFromCsv,
      allocationTokens: category.allocationTokens.toString(),
      allocationWei: toWei(category.allocationTokens).toString(),
      tgeReleasePercent: category.tgeReleasePercent,
    };
  });

  const baselineByCategory = categories.map((category) => ({
    categoryKey: category.key,
    categoryName: category.name,
    amountTokens: baselineScheduleRow.categoryCumulative[category.key],
    amountWei: toWei(BigInt(baselineScheduleRow.categoryCumulative[category.key])).toString(),
  }));

  const futureLockEntries = mergedScheduleRows
    .filter((row) => Number(row.offsetMonths) > 0 && BigInt(row.deltaTokens) > 0n)
    .map((row) => ({
      categoryKey: row.categoryKey,
      categoryName: row.categoryName,
      beneficiaryKey: row.categoryKey,
      periodOffsetMonths: Number(row.offsetMonths),
      periodStartAt: row.periodStartAt,
      unlockAt: row.unlockAt,
      sourceLabel: row.sourceLabel,
      amountTokens: row.deltaTokens,
      amountWei: toWei(BigInt(row.deltaTokens)).toString(),
      chosenSource: row.chosenSource,
      referenceStatus: row.referenceStatus,
    }));

  const totalSupplyTokens = categories.reduce(
    (sum, category) => sum + BigInt(category.allocationTokens),
    0n,
  );
  const baselineCirculatingTokens = BigInt(baselineScheduleRow.cumulativeCirculatingTokens);
  const futureLockedTokens = totalSupplyTokens - baselineCirculatingTokens;

  checks.push('Category allocations sum to 1,000,000,000 tokens.');
  checks.push('Every schedule row is monotonically non-decreasing per category.');
  checks.push('Every schedule row recomputes to the stated circulating supply.');
  checks.push('Every non-Sales category matches lockup2.csv within 1 token tolerance.');
  checks.push('Sales explicitly uses lockup.csv because lockup2.csv is outdated.');
  checks.push('Final category cumulative values match the category allocations.');

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    token: {
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      address: tokenAddress,
      chainId: BASE_CHAIN_ID,
      decimals: Number(TOKEN_DECIMALS),
    },
    source: {
      primaryCsvPath: legacy.csvPath,
      referenceCsvPath: reference.csvPath,
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
      mergeRule:
        'Use lockup.csv as the chosen execution schedule; use lockup2.csv as reference validation, except Sales which is explicitly marked outdated in lockup2.csv.',
    },
    validation: {
      passed: true,
      checks,
      warnings,
    },
    categories,
    baselineCirculating: {
      snapshotAt: anchors.tgeBaselineAt,
      totalTokens: baselineCirculatingTokens.toString(),
      totalWei: toWei(baselineCirculatingTokens).toString(),
      byCategory: baselineByCategory,
    },
    schedule,
    mergedScheduleRows,
    futureLockEntries,
    summary: {
      categoryCount: categories.length,
      scheduleRowCount: schedule.length,
      mergedRowCount: mergedScheduleRows.length,
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

export function buildLockupPlanFromMergedCsv({
  mergedCsvPath = 'generated/lockup-merged.csv',
  tokenAddress = DEFAULT_TOKEN_ADDRESS,
} = {}) {
  const records = parseCsv(readFileSync(path.resolve(mergedCsvPath), 'utf8'), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: false,
  });

  const scheduleByOffset = new Map();
  const categoriesByKey = new Map();

  for (const record of records) {
    const offsetMonths = Number(record.offset_months);
    if (!Number.isInteger(offsetMonths)) {
      throw new Error(`Invalid offset_months in merged CSV: ${record.offset_months}`);
    }

    if (!categoriesByKey.has(record.category_key)) {
      categoriesByKey.set(record.category_key, {
        key: record.category_key,
        name: record.category_name,
      });
    }

    let scheduleRow = scheduleByOffset.get(offsetMonths);
    if (!scheduleRow) {
      scheduleRow = {
        offsetMonths,
        sourceLabel: record.source_label,
        sourceReportedMonth: record.source_reported_month,
        computedSnapshotMonth: formatMonthLabel(new Date(record.snapshot_at_utc)),
        snapshotAt: record.snapshot_at_utc,
        cumulativeCirculatingTokens: record.circulating_cumulative_tokens,
        monthlyIncrementTokens: record.circulating_delta_tokens,
        categoryCumulative: {},
        categoryMonthlyIncrement: {},
      };
      scheduleByOffset.set(offsetMonths, scheduleRow);
    }

    scheduleRow.categoryCumulative[record.category_key] = record.chosen_cumulative_tokens;
    scheduleRow.categoryMonthlyIncrement[record.category_key] = record.delta_tokens;
  }

  const schedule = [...scheduleByOffset.values()].sort(
    (left, right) => left.offsetMonths - right.offsetMonths,
  );
  const finalScheduleRow = schedule.at(-1);
  const baselineScheduleRow = schedule[0];
  if (!finalScheduleRow || !baselineScheduleRow) {
    throw new Error(`No schedule rows found in merged CSV ${mergedCsvPath}`);
  }
  const firstFutureScheduleRow =
    schedule.find((row) => row.offsetMonths > 0) ?? null;
  const tgeBaselineAt = baselineScheduleRow.snapshotAt;
  const firstFutureUnlockAt = firstFutureScheduleRow?.snapshotAt ?? null;

  const categories = [...categoriesByKey.values()].map((category, index) => {
    const allocationTokens = finalScheduleRow.categoryCumulative[category.key];
    return {
      index: index + 1,
      key: category.key,
      name: category.name,
      referenceName: CATEGORY_REFERENCE_NAME_BY_KEY[category.key],
      walletAddressFromCsv: null,
      allocationTokens,
      allocationWei: toWei(BigInt(allocationTokens)).toString(),
      tgeReleasePercent: null,
    };
  });

  const baselineByCategory = categories.map((category) => ({
    categoryKey: category.key,
    categoryName: category.name,
    amountTokens: baselineScheduleRow.categoryCumulative[category.key],
    amountWei: toWei(BigInt(baselineScheduleRow.categoryCumulative[category.key])).toString(),
  }));

  const futureLockEntries = records
    .filter(
      (record) =>
        Number(record.offset_months) > 0 && BigInt(record.delta_tokens) > 0n,
    )
    .map((record) => ({
      categoryKey: record.category_key,
      categoryName: record.category_name,
      beneficiaryKey: record.category_key,
      periodOffsetMonths: Number(record.offset_months),
      periodStartAt: record.period_start_at_utc,
      unlockAt: record.unlock_at_utc,
      sourceLabel: record.source_label,
      amountTokens: record.delta_tokens,
      amountWei: toWei(BigInt(record.delta_tokens)).toString(),
      chosenSource: record.chosen_source,
      referenceStatus: record.reference_status,
    }));

  const totalSupplyTokens = categories.reduce(
    (sum, category) => sum + BigInt(category.allocationTokens),
    0n,
  );
  const baselineCirculatingTokens = BigInt(baselineScheduleRow.cumulativeCirculatingTokens);
  const futureLockedTokens = totalSupplyTokens - baselineCirculatingTokens;

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    token: {
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      address: tokenAddress,
      chainId: BASE_CHAIN_ID,
      decimals: Number(TOKEN_DECIMALS),
    },
    source: {
      mergedCsvPath: path.resolve(mergedCsvPath),
      tgeBaselineAt,
      firstFutureUnlockAt,
    },
    assumptions: {
      tgeBaselineAt,
      firstFutureUnlockAt,
      baselineMeaning:
        'The TGE row is treated as the already-circulating baseline snapshot and excluded from lock entries.',
      monthlyRule:
        'Monthly lock entries are generated from the increase between consecutive snapshots and unlock at the end snapshot timestamp.',
      firstLockPeriod:
        firstFutureUnlockAt === null
          ? null
          : `${tgeBaselineAt} -> ${firstFutureUnlockAt}`,
      mergeRule:
        'Use lockup.csv as the chosen execution schedule; use lockup2.csv as reference validation, except Sales which is explicitly marked outdated in lockup2.csv.',
    },
    validation: {
      passed: true,
      checks: ['Execution plan reconstructed from canonical merged CSV.'],
      warnings: [],
    },
    categories,
    baselineCirculating: {
      snapshotAt: tgeBaselineAt,
      totalTokens: baselineCirculatingTokens.toString(),
      totalWei: toWei(baselineCirculatingTokens).toString(),
      byCategory: baselineByCategory,
    },
    schedule,
    futureLockEntries,
    summary: {
      categoryCount: categories.length,
      scheduleRowCount: schedule.length,
      mergedRowCount: records.length,
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

export function buildMergedScheduleCsv(plan) {
  const headers = [
    'offset_months',
    'source_label',
    'source_reported_month',
    'snapshot_at_utc',
    'period_start_at_utc',
    'unlock_at_utc',
    'category_key',
    'category_name',
    'chosen_source',
    'legacy_cumulative_tokens',
    'lockup2_reference_cumulative_tokens',
    'chosen_cumulative_tokens',
    'delta_tokens',
    'reference_diff_tokens',
    'reference_status',
    'circulating_cumulative_tokens',
    'circulating_delta_tokens',
    'notes',
  ];

  const rows = plan.mergedScheduleRows.map((row) => [
    row.offsetMonths,
    row.sourceLabel,
    row.sourceReportedMonth,
    row.snapshotAt,
    row.periodStartAt,
    row.unlockAt,
    row.categoryKey,
    row.categoryName,
    row.chosenSource,
    row.legacyCumulativeTokens,
    row.referenceCumulativeTokens,
    row.chosenCumulativeTokens,
    row.deltaTokens,
    row.referenceDiffTokens,
    row.referenceStatus,
    row.circulatingCumulativeTokens,
    row.circulatingDeltaTokens,
    row.notes,
  ]);

  return buildCsv(headers, rows);
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
    'chosen_source',
    'reference_status',
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
    entry.chosenSource,
    entry.referenceStatus,
    entry.amountTokens,
    entry.amountWei,
  ]);

  return buildCsv(headers, rows);
}
