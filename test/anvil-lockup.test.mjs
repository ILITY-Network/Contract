import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Contract, ContractFactory, JsonRpcProvider, getAddress } from 'ethers';
import {
  buildLockupPlanFromMergedCsv,
} from '../scripts/lib/lockup-merge.mjs';
import { compileLockup } from '../scripts/lib/compile-lockup.mjs';
import { impersonateAccount, startAnvil, stopAnvilFork } from '../scripts/lib/anvil.mjs';

const execFile = promisify(execFileCallback);
const OWNER = '0xCE08282b294D685E7aeeAf64E81169B25c4AAb18';
const LOCKUP_READ_ABI = [
  'function owner() view returns (address)',
  'function token() view returns (address)',
  'function lockupCount(address account) view returns (uint256)',
  'function lockedAmount(address account) view returns (uint256)',
];
const ERC20_READ_ABI = ['function balanceOf(address account) view returns (uint256)'];

test(
  'execute-lockups runs end-to-end on an anvil chain',
  { timeout: 180000 },
  async (t) => {
    const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ility-lockup-'));
    const generatedDir = path.join(tempRoot, 'generated');
    const beneficiariesPath = path.join(tempRoot, 'beneficiaries.json');
    const port = 18545 + Math.floor(Math.random() * 1000);

    await execFile(
      process.execPath,
      ['scripts/generate-lockup-plan.mjs', '--outDir', generatedDir],
      { cwd: repoRoot },
    );

    const mergedCsvPath = path.join(generatedDir, 'lockup-merged.csv');
    const plan = buildLockupPlanFromMergedCsv({ mergedCsvPath });
    const anvil = await startAnvil({
      port,
      chainId: 8453,
    });
    t.after(async () => {
      await stopAnvilFork(anvil);
    });

    const provider = new JsonRpcProvider(anvil.rpcUrl);
    await impersonateAccount(provider, OWNER);
    const ownerSigner = await provider.getSigner(OWNER);
    const tokenArtifact = compileLockup({
      projectRoot: repoRoot,
      entryFile: 'src/ILITY.sol',
      contractName: 'ILITY',
    });
    const tokenFactory = new ContractFactory(
      tokenArtifact.abi,
      tokenArtifact.bytecode,
      ownerSigner,
    );
    const tokenDeployment = await tokenFactory.deploy(OWNER, OWNER);
    await tokenDeployment.waitForDeployment();
    const tokenAddress = getAddress(await tokenDeployment.getAddress());

    const devAccounts = (await provider.send('eth_accounts', [])).map((account) =>
      getAddress(account),
    );
    assert.ok(devAccounts.length >= 7);

    const beneficiaries = {
      sales: devAccounts[0],
      dev_fund: devAccounts[1],
      team_and_advisor: devAccounts[2],
      marketing: devAccounts[3],
      reward: devAccounts[4],
      community: devAccounts[5],
      operation: devAccounts[6],
    };
    await writeFile(beneficiariesPath, `${JSON.stringify(beneficiaries, null, 2)}\n`);
    await execFile(
      process.execPath,
      [
        'scripts/generate-execution-csv.mjs',
        '--mergedCsv',
        mergedCsvPath,
        '--beneficiaries',
        beneficiariesPath,
        '--executionCsv',
        path.join(generatedDir, 'lockup-execution.csv'),
        '--previewCsv',
        path.join(generatedDir, 'lockup-execution-preview.csv'),
      ],
      { cwd: repoRoot },
    );
    await execFile(
      process.execPath,
      [
        'scripts/verify-execution-csv.mjs',
        '--executionCsv',
        path.join(generatedDir, 'lockup-execution.csv'),
        '--mergedCsv',
        mergedCsvPath,
        '--beneficiaries',
        beneficiariesPath,
      ],
      { cwd: repoRoot },
    );

    await execFile(
      process.execPath,
      [
        'scripts/deploy-lockup.mjs',
        '--rpcUrl',
        anvil.rpcUrl,
        '--impersonate',
        OWNER,
        '--tokenAddress',
        tokenAddress,
        '--initialOwner',
        OWNER,
        '--outputDir',
        generatedDir,
        '--execute',
      ],
      { cwd: repoRoot },
    );
    const deploymentRecord = JSON.parse(
      await readFile(path.join(generatedDir, 'deploy-lockup.latest.json'), 'utf8'),
    );
    const lockupAddress = getAddress(deploymentRecord.lockupAddress);

    const execution = await execFile(
      process.execPath,
      [
        'scripts/execute-lockups.mjs',
        '--rpcUrl',
        anvil.rpcUrl,
        '--executionCsv',
        path.join(generatedDir, 'lockup-execution.csv'),
        '--beneficiaries',
        beneficiariesPath,
        '--lockupAddress',
        lockupAddress,
        '--tokenAddress',
        tokenAddress,
        '--impersonate',
        OWNER,
        '--outputDir',
        generatedDir,
        '--execute',
        '--approveIfNeeded',
        '--transferBaselineAfterLockups',
      ],
      { cwd: repoRoot },
    );

    assert.match(execution.stdout, /Lockup execution complete\./);

    const lockup = new Contract(lockupAddress, LOCKUP_READ_ABI, provider);
    const token = new Contract(tokenAddress, ERC20_READ_ABI, provider);
    assert.equal(getAddress(await lockup.owner()), getAddress(OWNER));
    assert.equal(
      getAddress(await lockup.token()),
      tokenAddress,
    );
    assert.equal(getAddress(deploymentRecord.tokenAddress), tokenAddress);
    assert.equal(
      getAddress(deploymentRecord.initialOwner),
      getAddress(OWNER),
    );
    assert.equal(
      (await token.balanceOf(lockupAddress)).toString(),
      plan.summary.futureLockedWei,
    );
    assert.equal((await token.balanceOf(OWNER)).toString(), '0');

    for (const category of plan.categories) {
      const beneficiary = beneficiaries[category.key];
      const expectedEntries = plan.futureLockEntries.filter(
        (entry) => entry.categoryKey === category.key,
      );
      const expectedWei = expectedEntries.reduce(
        (sum, entry) => sum + BigInt(entry.amountWei),
        0n,
      );
      const expectedLiquidWei =
        plan.baselineCirculating.byCategory.find(
          (entry) => entry.categoryKey === category.key,
        )?.amountWei ?? '0';

      assert.equal(
        (await lockup.lockupCount(beneficiary)).toString(),
        String(expectedEntries.length),
      );
      assert.equal(
        (await lockup.lockedAmount(beneficiary)).toString(),
        expectedWei.toString(),
      );
      assert.equal(
        (await token.balanceOf(beneficiary)).toString(),
        expectedLiquidWei,
      );
    }

    const applied = JSON.parse(
      await readFile(path.join(generatedDir, 'lockup-batches.applied.json'), 'utf8'),
    );
    const baselineApplied = JSON.parse(
      await readFile(path.join(generatedDir, 'baseline-transfers.applied.json'), 'utf8'),
    );
    const preview = JSON.parse(
      await readFile(path.join(generatedDir, 'lockup-batches.preview.json'), 'utf8'),
    );
    const baselinePreview = JSON.parse(
      await readFile(path.join(generatedDir, 'baseline-transfers.preview.json'), 'utf8'),
    );

    assert.equal(applied.totalAmountWei, plan.summary.futureLockedWei);
    assert.equal(preview.totalAmountWei, plan.summary.futureLockedWei);
    assert.equal(preview.eligibleEntryCount, plan.summary.futureLockEntryCount);
    assert.equal(preview.batches.length, 7);
    assert.equal(applied.receipts.length, 7);
    assert.equal(
      baselineApplied.totalAmountWei,
      plan.baselineCirculating.totalWei,
    );
    assert.equal(
      baselinePreview.totalAmountWei,
      plan.baselineCirculating.totalWei,
    );
    assert.equal(
      baselineApplied.receipts.length,
      plan.baselineCirculating.byCategory.filter(
        (entry) => BigInt(entry.amountWei) > 0n,
      ).length,
    );

    const rerun = await execFile(
      process.execPath,
      [
        'scripts/execute-lockups.mjs',
        '--rpcUrl',
        anvil.rpcUrl,
        '--executionCsv',
        path.join(generatedDir, 'lockup-execution.csv'),
        '--beneficiaries',
        beneficiariesPath,
        '--lockupAddress',
        lockupAddress,
        '--tokenAddress',
        tokenAddress,
        '--impersonate',
        OWNER,
        '--outputDir',
        generatedDir,
        '--execute',
        '--approveIfNeeded',
        '--transferBaselineAfterLockups',
      ],
      { cwd: repoRoot },
    );

    assert.match(
      rerun.stdout,
      /Existing lockup entries already on-chain: 339/,
    );

    const rerunApplied = JSON.parse(
      await readFile(path.join(generatedDir, 'lockup-batches.applied.json'), 'utf8'),
    );
    const rerunPreview = JSON.parse(
      await readFile(path.join(generatedDir, 'lockup-batches.preview.json'), 'utf8'),
    );
    const rerunBaselineApplied = JSON.parse(
      await readFile(path.join(generatedDir, 'baseline-transfers.applied.json'), 'utf8'),
    );
    const rerunBaselinePreview = JSON.parse(
      await readFile(path.join(generatedDir, 'baseline-transfers.preview.json'), 'utf8'),
    );

    assert.equal(rerunApplied.totalAmountWei, '0');
    assert.equal(rerunApplied.receipts.length, 0);
    assert.equal(rerunPreview.eligibleEntryCount, 0);
    assert.equal(rerunPreview.alreadyPresentEntryCount, plan.summary.futureLockEntryCount);
    assert.equal(rerunBaselineApplied.totalAmountWei, '0');
    assert.equal(rerunBaselineApplied.receipts.length, 0);
    assert.equal(
      rerunBaselinePreview.sendEntryCount,
      0,
    );
  },
);
