import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { ContractFactory, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { compileLockup } from './lib/compile-lockup.mjs';
import { BASE_CHAIN_ID, DEFAULT_TOKEN_ADDRESS } from './lib/lockup-plan.mjs';
import { impersonateAccount } from './lib/anvil.mjs';

dotenv.config();

const { values } = parseArgs({
  options: {
    execute: { type: 'boolean', default: false },
    rpcUrl: { type: 'string', default: process.env.BASE_RPC_URL ?? '' },
    privateKey: { type: 'string', default: process.env.PRIVATE_KEY ?? '' },
    impersonate: { type: 'string', default: '' },
    tokenAddress: {
      type: 'string',
      default: process.env.TOKEN_ADDRESS ?? DEFAULT_TOKEN_ADDRESS,
    },
    initialOwner: {
      type: 'string',
      default: process.env.INITIAL_OWNER ?? '',
    },
    outputDir: { type: 'string', default: 'generated' },
  },
});

if (!values.rpcUrl) {
  throw new Error('Missing Base RPC URL. Set BASE_RPC_URL or pass --rpcUrl.');
}

const provider = new JsonRpcProvider(values.rpcUrl);
const network = await provider.getNetwork();
if (Number(network.chainId) !== BASE_CHAIN_ID) {
  throw new Error(`Expected chainId ${BASE_CHAIN_ID}, received ${network.chainId}`);
}

let signer;
if (values.impersonate) {
  const impersonatedAddress = getAddress(values.impersonate);
  await impersonateAccount(provider, impersonatedAddress);
  signer = await provider.getSigner(impersonatedAddress);
} else {
  if (!values.privateKey) {
    throw new Error('Missing admin private key. Set PRIVATE_KEY or pass --privateKey.');
  }

  signer = new Wallet(values.privateKey, provider);
}

const tokenAddress = getAddress(values.tokenAddress);
const initialOwner = values.initialOwner
  ? getAddress(values.initialOwner)
  : getAddress(await signer.getAddress());
const artifact = compileLockup();

console.log(`Signer: ${getAddress(await signer.getAddress())}`);
console.log(`Token: ${tokenAddress}`);
console.log(`Initial owner: ${initialOwner}`);
console.log(`Bytecode size: ${artifact.bytecode.length / 2 - 1} bytes`);

if (!values.execute) {
  console.log('Dry-run only. Re-run with --execute to broadcast deployment.');
  process.exit(0);
}

const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
const deployment = await factory.deploy(tokenAddress, initialOwner);
console.log(`Deployment tx: ${deployment.deploymentTransaction()?.hash ?? 'pending'}`);
await deployment.waitForDeployment();
const lockupAddress = await deployment.getAddress();

const outputDir = path.resolve(values.outputDir);
await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, 'deploy-lockup.latest.json'),
  `${JSON.stringify(
    {
      deployedAt: new Date().toISOString(),
      chainId: Number(network.chainId),
      tokenAddress,
      initialOwner,
      lockupAddress,
      deploymentTxHash: deployment.deploymentTransaction()?.hash ?? null,
    },
    null,
    2,
  )}\n`,
);

console.log(`Lockup deployed at: ${lockupAddress}`);
