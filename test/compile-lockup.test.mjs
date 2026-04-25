import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLockup } from '../scripts/lib/compile-lockup.mjs';

test('Lockup contract compiles with expected surface', () => {
  const artifact = compileLockup();
  const functionNames = artifact.abi
    .filter((entry) => entry.type === 'function')
    .map((entry) => entry.name);

  assert.ok(artifact.bytecode.startsWith('0x'));
  assert.ok(artifact.bytecode.length > 2);
  assert.ok(functionNames.includes('lockBatch'));
  assert.ok(functionNames.includes('claimAll'));
});
