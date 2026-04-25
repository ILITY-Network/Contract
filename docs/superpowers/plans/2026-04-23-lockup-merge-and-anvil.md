# Lockup Merge And Anvil Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `lockup.csv` and `lockup2.csv` into one canonical machine-readable CSV, generate lockup batches from that CSV, and verify the full Base mainnet flow on an Anvil fork before mainnet execution.

**Architecture:** Keep the canonical schedule generation in Node so the same code path feeds dry-run, integration tests, and real execution. Use `lockup.csv` as the authoritative integer schedule, use `lockup2.csv` as a cross-check dataset with an explicit override note that `Sales` in `lockup2.csv` is outdated, and write a merged CSV artifact that execution reads directly. For testing, spin up `anvil --fork-url <Base RPC>`, impersonate the Base token owner, deploy `Lockup`, run `approve + lockBatch`, and assert balances and lock counts.

**Tech Stack:** Node.js, ethers v6, csv-parse, solc, Foundry `anvil`

---

### Task 1: Canonical Merge Format

**Files:**
- Modify: `scripts/lib/lockup-plan.mjs`
- Create: `generated/lockup-merged.csv`
- Test: `test/lockup-merge.test.mjs`

- [ ] Add parsers for both CSV shapes.
- [ ] Encode merge rules with explicit provenance and warnings.
- [ ] Emit a canonical merged CSV with offsets, unlock timestamps, deltas, cumulative totals, and source notes.
- [ ] Assert `Sales` mismatch is intentional and all other categories match within rounding tolerance.

### Task 2: Execution Reads Canonical CSV

**Files:**
- Modify: `scripts/generate-lockup-plan.mjs`
- Modify: `scripts/execute-lockups.mjs`
- Modify: `README.md`
- Test: `test/lockup-plan.test.mjs`

- [ ] Make plan generation produce the merged CSV artifact on every run.
- [ ] Make execution consume the merged-plan JSON derived from the merged CSV path, not the ad hoc legacy layout.
- [ ] Preserve dry-run previews and on-chain guardrails.
- [ ] Update docs with the new canonical artifact and run order.

### Task 3: Anvil Fork Integration

**Files:**
- Create: `scripts/lib/anvil.mjs`
- Create: `test/anvil-lockup.test.mjs`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] Add helpers to launch and stop an Anvil Base fork.
- [ ] In tests, impersonate the Base token owner, deploy `Lockup`, approve tokens, execute at least one real batch, and assert resulting locks.
- [ ] Ensure the test skips cleanly only when the required Base RPC env var is missing.

### Task 4: Final Verification

**Files:**
- Modify: `generated/lockup-plan.json`
- Modify: `generated/lockup-locks.csv`
- Modify: `generated/lockup-normalized.csv`

- [ ] Run `npm test`.
- [ ] Run the merged plan generator and inspect totals, first unlock, and last unlock.
- [ ] Run the Anvil fork integration and record the actual assertions that passed.
