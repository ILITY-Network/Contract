# ILITY Lockup Workflow

`lockup.csv` and `lockup2.csv` are merged into one canonical machine-readable CSV. From that, the workflow produces a compact execution CSV whose core fields are `address`, `unlock_at_utc`, and `amount`, then validates it before `lockBatch` execution on Base mainnet.

## Assumptions

- Token: `0x90eb0e291e9d78a96bfe423b8e616a02c4838cf0` on Base mainnet (`8453`)
- TGE baseline snapshot: `2026-04-03T07:46:03Z` (deployment timestamp)
- First monthly unlock anchor: `2026-05-01T12:00:00Z` (`+1M`)
- Future lock deltas are computed row-to-row, so the `TGE -> +1M` increase unlocks on `2026-05-01T12:00:00Z`, and the `05/01 -> 06/01` increase unlocks on `2026-06-01T12:00:00Z`
- The first `TGE` row in `lockup.csv` is treated as already-circulating baseline and is not locked
- `lockup2.csv` is used as a reference check; its `Sales` column is explicitly treated as outdated

## Files

- `src/ILITY.sol`: ILITY ERC20 token contract
- `src/Lockup_ILY.sol`: ILITY lockup contract
- `foundry.toml`: Foundry build configuration
- `scripts/generate-lockup-plan.mjs`: parses `lockup.csv` and `lockup2.csv`, validates totals, and writes machine-friendly outputs to `generated/`
- `scripts/generate-execution-csv.mjs`: writes the compact execution CSV from the validated plan plus beneficiary addresses
- `scripts/verify-execution-csv.mjs`: verifies the execution CSV against the validated plan
- `scripts/deploy-lockup.mjs`: compiles and deploys `src/Lockup_ILY.sol`
- `scripts/execute-lockups.mjs`: loads the execution CSV, performs on-chain checks, and optionally executes approvals plus `lockBatch`
- `scripts/lib/anvil.mjs`: starts and stops Anvil chains for integration tests
- `config/beneficiaries.example.json`: category-to-wallet template

## Commands

```bash
npm run build
npm run lockup:plan
npm run lockup:csv
npm run lockup:verify
npm test
npm run test:anvil
node scripts/deploy-lockup.mjs
node scripts/execute-lockups.mjs
node scripts/execute-lockups.mjs --execute --approveIfNeeded
node scripts/execute-lockups.mjs --execute --approveIfNeeded --transferBaselineAfterLockups
```

## Runbook

1. Fill `.env` from `.env.example`.
2. Fill `config/beneficiaries.json` from `config/beneficiaries.example.json`.
   The keys must stay exactly as generated, including `team_and_advisor`.
3. Run `npm run lockup:plan` and inspect:
   - `generated/lockup-merged.csv`
   - `generated/lockup-plan.json`
   - `generated/lockup-normalized.csv`
   - `generated/lockup-locks.csv`
   - `generated/lockup-execution-preview.csv`
   - `generated/lockup-execution.csv` when all beneficiary addresses are filled
4. If `generated/lockup-execution.csv` was not written, fill the missing addresses in `config/beneficiaries.json` and run `npm run lockup:csv`.
5. Verify the final execution CSV with `npm run lockup:verify`.
6. Run `npm run build`.
7. Run `npm test`.
8. Run `npm run test:anvil` if you want the full isolated Anvil deployment and execution test.
9. If the lockup contract is not deployed yet, deploy it with `node scripts/deploy-lockup.mjs --execute`.
10. Dry-run on-chain checks with `node scripts/execute-lockups.mjs`.
11. Execute with `node scripts/execute-lockups.mjs --execute --approveIfNeeded`.
12. If you also want the TGE-immediate amounts sent after lockups, run `node scripts/execute-lockups.mjs --execute --approveIfNeeded --transferBaselineAfterLockups`.

## Immediate Transfers

- `baseline transfer` means sending the TGE-immediate circulating amounts (`210,000,000 ILY` total) from the owner wallet to the beneficiary wallets after all `lockBatch` calls finish.
- Before creating new lockups, the script reads existing `Lockup` entries for the beneficiary addresses in the execution CSV.
- If an on-chain lock entry already matches `address + unlockTime + amount`, it is treated as already applied and skipped.
- If an on-chain lock entry exists for those beneficiaries but is not part of the expected execution CSV, the script stops with an error instead of trying to continue on top of an unknown state.
- The script checks the current beneficiary balance before sending:
- If current balance is `0`, it sends the full expected amount.
- If current balance exactly matches the expected immediate amount, it skips that wallet as already funded.
- If current balance is greater than the expected immediate amount, it skips that wallet.
- If current balance is between `0` and the expected amount, it stops with an error because the wallet is in a partial state and an automatic retry would be unsafe.
- Preview and execution artifacts are written to `baseline-transfers.preview.json` and `baseline-transfers.applied.json`.
