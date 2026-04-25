import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

async function isRpcReady(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    }),
  });

  if (!response.ok) {
    return false;
  }

  const body = await response.json();
  return typeof body.result === 'string';
}

export async function startAnvil({
  forkUrl,
  port = 8547,
  chainId,
  timeoutMs = 30000,
} = {}) {
  const args = ['--port', String(port), '--silent'];
  if (forkUrl) {
    args.push('--fork-url', forkUrl);
  }
  if (chainId) {
    args.push('--chain-id', String(chainId));
  }

  const child = spawn('anvil', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const rpcUrl = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await isRpcReady(rpcUrl)) {
        return {
          rpcUrl,
          process: child,
          getLogs() {
            return { stdout, stderr };
          },
        };
      }
    } catch (error) {
      lastError = error;
    }

    if (child.exitCode !== null) {
      throw new Error(
        `Anvil exited early with code ${child.exitCode}: ${stderr || stdout}`,
      );
    }

    await sleep(500);
  }

  child.kill('SIGTERM');
  throw new Error(`Timed out waiting for Anvil: ${lastError}`);
}

export async function startAnvilFork(options = {}) {
  if (!options.forkUrl) {
    throw new Error('forkUrl is required to start an Anvil fork');
  }

  return startAnvil(options);
}

export async function stopAnvilFork(handle) {
  if (!handle?.process || handle.process.exitCode !== null) {
    return;
  }

  handle.process.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => {
      handle.process.once('exit', resolve);
    }),
    sleep(3000),
  ]);

  if (handle.process.exitCode === null) {
    handle.process.kill('SIGKILL');
  }
}

export async function impersonateAccount(provider, account) {
  await provider.send('anvil_impersonateAccount', [account]);
  await provider.send('anvil_setBalance', [account, '0x3635C9ADC5DEA00000']);
}
