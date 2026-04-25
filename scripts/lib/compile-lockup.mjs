import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import solc from 'solc';

function loadSource(filePath) {
  return readFileSync(filePath, 'utf8');
}

function resolveImportPath(projectRoot, importPath) {
  const candidates = [
    path.resolve(projectRoot, importPath),
    path.resolve(projectRoot, 'node_modules', importPath),
  ];

  if (importPath.startsWith('@openzeppelin/contracts@5.5.0/')) {
    candidates.push(
      path.resolve(
        projectRoot,
        'node_modules',
        importPath.replace('@openzeppelin/contracts@5.5.0/', '@openzeppelin/contracts/'),
      ),
    );
  }

  return candidates.find((candidate) => existsSync(candidate));
}

export function compileLockup({
  projectRoot = process.cwd(),
  entryFile = 'src/Lockup_ILY.sol',
  contractName = 'Lockup',
} = {}) {
  const absoluteEntry = path.resolve(projectRoot, entryFile);
  const source = loadSource(absoluteEntry);
  const compilerInput = {
    language: 'Solidity',
    sources: {
      [entryFile]: {
        content: source,
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };

  const compiled = JSON.parse(
    solc.compile(JSON.stringify(compilerInput), {
      import: (importPath) => {
        const resolvedPath = resolveImportPath(projectRoot, importPath);
        if (!resolvedPath) {
          return {
            error: `Import not found: ${importPath}`,
          };
        }

        return {
          contents: loadSource(resolvedPath),
        };
      },
    }),
  );

  if (compiled.errors) {
    const fatalErrors = compiled.errors.filter(
      (entry) => entry.severity === 'error',
    );
    if (fatalErrors.length > 0) {
      throw new Error(fatalErrors.map((entry) => entry.formattedMessage).join('\n'));
    }
  }

  const artifact = compiled.contracts?.[entryFile]?.[contractName];
  if (!artifact) {
    throw new Error(`Contract ${contractName} not found in ${entryFile}`);
  }

  return {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
  };
}
