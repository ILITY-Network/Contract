import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { getAddress, isAddress } from 'ethers';
import {
  DEFAULT_TOKEN_ADDRESS,
  TOKEN_DECIMALS,
} from './lockup-plan.mjs';
import { buildLockupPlanFromMergedCsv } from './lockup-merge.mjs';

const TOKEN_SCALE = 10n ** TOKEN_DECIMALS;

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

export function loadJson(filePath) {
  return JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
}

export function loadPlan({
  executionCsvPath,
  mergedCsvPath = 'generated/lockup-merged.csv',
  planPath = 'generated/lockup-plan.json',
  tokenAddress = DEFAULT_TOKEN_ADDRESS,
} = {}) {
  if (executionCsvPath && existsSync(path.resolve(executionCsvPath))) {
    return null;
  }

  if (mergedCsvPath && existsSync(path.resolve(mergedCsvPath))) {
    return buildLockupPlanFromMergedCsv({
      mergedCsvPath,
      tokenAddress,
    });
  }

  if (!existsSync(path.resolve(planPath))) {
    throw new Error(
      `Neither merged CSV (${mergedCsvPath}) nor plan JSON (${planPath}) was found.`,
    );
  }

  return loadJson(planPath);
}

export function resolveBeneficiaryAddresses(
  plan,
  beneficiariesConfig,
  { allowMissing = false, allowDuplicateAddresses = false } = {},
) {
  const addresses = new Map();
  const missing = [];
  const categoriesByAddress = new Map();

  for (const category of plan.categories) {
    const configured = beneficiariesConfig?.[category.key];
    const resolved = configured || category.walletAddressFromCsv || '';
    if (!resolved) {
      missing.push(category.key);
      continue;
    }

    if (!isAddress(resolved)) {
      throw new Error(`Invalid beneficiary address for ${category.key}: ${resolved}`);
    }

    const normalized = getAddress(resolved);
    addresses.set(category.key, normalized);
    const addressKey = normalized.toLowerCase();
    const categories = categoriesByAddress.get(addressKey) ?? [];
    categories.push(category.key);
    categoriesByAddress.set(addressKey, categories);
  }

  if (!allowMissing && missing.length > 0) {
    throw new Error(
      `Missing beneficiary addresses for: ${missing.sort().join(', ')}`,
    );
  }

  if (!allowDuplicateAddresses) {
    const duplicates = [...categoriesByAddress.entries()]
      .filter(([, categories]) => categories.length > 1)
      .map(([address, categories]) => `${getAddress(address)} => ${categories.sort().join(', ')}`);

    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate beneficiary addresses found: ${duplicates.join(' | ')}`,
      );
    }
  }

  return { addresses, missing };
}

function aggregateRows(entries, resolveIdentity) {
  const grouped = new Map();

  for (const entry of entries) {
    const identity = resolveIdentity(entry);
    const groupKey = `${identity.groupKey}:${entry.unlockAt}`;
    const amountWei = BigInt(entry.amountWei);
    const amountTokens = BigInt(entry.amountTokens);
    const existing = grouped.get(groupKey);

    if (existing) {
      existing.amountWei += amountWei;
      existing.amountTokens += amountTokens;
      existing.beneficiaryKeys.add(entry.beneficiaryKey);
      existing.categoryNames.add(entry.categoryName);
      existing.sourceLabels.add(entry.sourceLabel);
    } else {
      grouped.set(groupKey, {
        groupKey,
        address: identity.address,
        beneficiaryKey: identity.beneficiaryKey,
        unlockAt: entry.unlockAt,
        unlockTimestamp: Math.floor(new Date(entry.unlockAt).getTime() / 1000),
        amountWei,
        amountTokens,
        beneficiaryKeys: new Set([entry.beneficiaryKey]),
        categoryNames: new Set([entry.categoryName]),
        sourceLabels: new Set([entry.sourceLabel]),
      });
    }
  }

  return [...grouped.values()]
    .sort((left, right) => {
      if (left.unlockTimestamp !== right.unlockTimestamp) {
        return left.unlockTimestamp - right.unlockTimestamp;
      }

      return left.groupKey.localeCompare(right.groupKey);
    })
    .map((row) => ({
      address: row.address,
      beneficiaryKey: row.beneficiaryKey,
      unlockAt: row.unlockAt,
      unlockTimestamp: row.unlockTimestamp,
      amountWei: row.amountWei.toString(),
      amountTokens: row.amountTokens.toString(),
      beneficiaryKeys: [...row.beneficiaryKeys].sort(),
      categoryNames: [...row.categoryNames].sort(),
      sourceLabels: [...row.sourceLabels].sort(),
    }));
}

export function buildExecutionPreviewRows(plan) {
  return aggregateRows(plan.futureLockEntries, (entry) => ({
    groupKey: entry.beneficiaryKey,
    address: null,
    beneficiaryKey: entry.beneficiaryKey,
  }));
}

export function buildExecutionRows(plan, beneficiaryAddresses) {
  return aggregateRows(plan.futureLockEntries, (entry) => {
    const address = beneficiaryAddresses.get(entry.beneficiaryKey);
    if (!address) {
      throw new Error(
        `No beneficiary address found for ${entry.beneficiaryKey} while building execution rows.`,
      );
    }

    return {
      groupKey: address.toLowerCase(),
      address,
      beneficiaryKey: entry.beneficiaryKey,
    };
  });
}

export function buildExecutionPreviewCsv(rows) {
  return buildCsv(
    [
      'beneficiary_key',
      'unlock_at_utc',
      'unlock_timestamp',
      'amount_tokens',
      'amount_wei',
      'beneficiary_keys',
      'category_names',
      'source_labels',
    ],
    rows.map((row) => [
      row.beneficiaryKey,
      row.unlockAt,
      row.unlockTimestamp,
      row.amountTokens,
      row.amountWei,
      row.beneficiaryKeys.join('|'),
      row.categoryNames.join('|'),
      row.sourceLabels.join('|'),
    ]),
  );
}

export function buildExecutionCsv(rows) {
  return buildCsv(
    [
      'address',
      'unlock_at_utc',
      'unlock_timestamp',
      'amount_tokens',
      'amount_wei',
      'beneficiary_keys',
      'category_names',
      'source_labels',
    ],
    rows.map((row) => [
      row.address,
      row.unlockAt,
      row.unlockTimestamp,
      row.amountTokens,
      row.amountWei,
      row.beneficiaryKeys.join('|'),
      row.categoryNames.join('|'),
      row.sourceLabels.join('|'),
    ]),
  );
}

export function parseExecutionCsv(executionCsvPath) {
  const records = parseCsv(readFileSync(path.resolve(executionCsvPath), 'utf8'), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: false,
  });

  return records.map((record, index) => {
    const address = record.address ? getAddress(record.address) : null;
    const unlockAt = String(record.unlock_at_utc ?? '').trim();
    const unlockTimestamp = Number(record.unlock_timestamp);
    const amountTokens = BigInt(String(record.amount_tokens ?? '').trim());
    const amountWei = BigInt(String(record.amount_wei ?? '').trim());

    if (!address || !isAddress(address)) {
      throw new Error(`Invalid address on row ${index + 2} of ${executionCsvPath}`);
    }

    if (!unlockAt) {
      throw new Error(`Missing unlock_at_utc on row ${index + 2}`);
    }

    const derivedTimestamp = Math.floor(new Date(unlockAt).getTime() / 1000);
    if (!Number.isInteger(unlockTimestamp) || derivedTimestamp !== unlockTimestamp) {
      throw new Error(
        `unlock_timestamp mismatch on row ${index + 2}: csv=${unlockTimestamp}, derived=${derivedTimestamp}`,
      );
    }

    if (amountTokens <= 0n || amountWei <= 0n) {
      throw new Error(`Amounts must be positive on row ${index + 2}`);
    }

    if (amountTokens * TOKEN_SCALE !== amountWei) {
      throw new Error(
        `amount_tokens and amount_wei mismatch on row ${index + 2}: ${amountTokens} vs ${amountWei}`,
      );
    }

    return {
      address,
      unlockAt,
      unlockTimestamp,
      amountTokens: amountTokens.toString(),
      amountWei: amountWei.toString(),
      beneficiaryKeys: String(record.beneficiary_keys ?? '')
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean)
        .sort(),
      categoryNames: String(record.category_names ?? '')
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean)
        .sort(),
      sourceLabels: String(record.source_labels ?? '')
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean)
        .sort(),
    };
  });
}

function normalizedRowKey(row) {
  return `${row.address}:${row.unlockTimestamp}:${row.amountWei}:${row.beneficiaryKeys.join(
    '|',
  )}:${row.categoryNames.join('|')}:${row.sourceLabels.join('|')}`;
}

export function verifyExecutionRows({ expectedRows, actualRows, expectedTotalWei }) {
  const duplicateKeys = new Set();
  const seen = new Set();
  for (const row of actualRows) {
    const duplicateKey = `${row.address}:${row.unlockTimestamp}`;
    if (seen.has(duplicateKey)) {
      duplicateKeys.add(duplicateKey);
    }
    seen.add(duplicateKey);
  }

  if (duplicateKeys.size > 0) {
    throw new Error(
      `Duplicate address+unlock rows found in execution CSV: ${[...duplicateKeys].join(', ')}`,
    );
  }

  const actualTotalWei = actualRows.reduce(
    (sum, row) => sum + BigInt(row.amountWei),
    0n,
  );

  if (actualTotalWei !== BigInt(expectedTotalWei)) {
    throw new Error(
      `Execution CSV total mismatch: actual=${actualTotalWei}, expected=${expectedTotalWei}`,
    );
  }

  const expectedKeys = expectedRows.map(normalizedRowKey).sort();
  const actualKeys = actualRows.map(normalizedRowKey).sort();
  if (expectedKeys.length !== actualKeys.length) {
    throw new Error(
      `Execution row count mismatch: actual=${actualKeys.length}, expected=${expectedKeys.length}`,
    );
  }

  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (expectedKeys[i] !== actualKeys[i]) {
      throw new Error(
        `Execution row mismatch at sorted index ${i}: actual=${actualKeys[i]} expected=${expectedKeys[i]}`,
      );
    }
  }

  return {
    rowCount: actualRows.length,
    totalAmountWei: actualTotalWei.toString(),
  };
}
