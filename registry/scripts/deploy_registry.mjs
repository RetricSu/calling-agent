import { ccc } from "@ckb-ccc/ccc";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const registryRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(registryRoot, "..");

const DEFAULT_DEVNET_RPC = "http://127.0.0.1:8114";
const DEFAULT_TESTNET_RPC = "https://testnet.ckb.dev/rpc";
const DEFAULT_HASH_TYPE = "data1";
const DEFAULT_FEE_RATE = 1200n;

function readEnv(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function requireEnv(name) {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function normalizeHex(value) {
  if (!value) return "0x";
  return value.startsWith("0x") ? value : `0x${value}`;
}

function isValidTypeIdArgs(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function parseNetwork() {
  const network = readEnv("REGISTRY_NETWORK", "devnet").toLowerCase();
  if (network !== "devnet" && network !== "testnet") {
    throw new Error(`Unsupported REGISTRY_NETWORK=${network}. Use devnet or testnet.`);
  }
  return network;
}

function parseFeeRate() {
  const raw = readEnv("REGISTRY_FEE_RATE", "");
  if (!raw) return DEFAULT_FEE_RATE;
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new Error(`REGISTRY_FEE_RATE must be > 0, got ${raw}`);
  }
  return value;
}

function parseCodeOutPointFromEnv() {
  const txHash = readEnv("REGISTRY_TYPE_OUT_POINT_TX_HASH");
  const index = readEnv("REGISTRY_TYPE_OUT_POINT_INDEX");
  if (!txHash && !index) return undefined;
  if (!txHash || index === "") {
    throw new Error("REGISTRY_TYPE_OUT_POINT_TX_HASH and REGISTRY_TYPE_OUT_POINT_INDEX must be provided together");
  }

  const parsedIndex = Number(index);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new Error(`Invalid REGISTRY_TYPE_OUT_POINT_INDEX=${index}`);
  }

  return {
    txHash: normalizeHex(txHash),
    index: parsedIndex,
  };
}

function buildEndpointPayload() {
  const endpointsJson = readEnv("REGISTRY_ENDPOINTS_JSON");

  if (endpointsJson) {
    const parsed = JSON.parse(endpointsJson);
    if (Array.isArray(parsed)) {
      const endpoints = parsed.map(validateEndpoint);
      if (endpoints.length === 0) {
        throw new Error("REGISTRY_ENDPOINTS_JSON array cannot be empty");
      }
      return {
        endpoints,
        updatedAt: new Date().toISOString(),
      };
    }

    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.endpoints)) {
        const endpoints = parsed.endpoints.map(validateEndpoint);
        if (endpoints.length === 0) {
          throw new Error("REGISTRY_ENDPOINTS_JSON.endpoints cannot be empty");
        }
        return {
          ...parsed,
          endpoints,
          updatedAt: new Date().toISOString(),
        };
      }

      const endpoint = validateEndpoint(parsed);
      return {
        endpoints: [endpoint],
        updatedAt: new Date().toISOString(),
      };
    }

    throw new Error("REGISTRY_ENDPOINTS_JSON must be an object or array");
  }

  const url = readEnv("REGISTRY_URL", "https://agent.pingkey.xyz/");
  const price = readEnv("REGISTRY_PRICE", "N/A");

  return {
    endpoints: [validateEndpoint({ url, price })],
    updatedAt: new Date().toISOString(),
  };
}

function validateEndpoint(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Endpoint must be an object containing url and price");
  }

  const endpoint = value;
  const url = typeof endpoint.url === "string" ? endpoint.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid endpoint url: ${String(endpoint.url)}`);
  }

  const price = endpoint.price;
  if (
    typeof price !== "string" &&
    typeof price !== "number" &&
    typeof price !== "bigint"
  ) {
    throw new Error(`Invalid endpoint price for ${url}`);
  }

  return {
    url,
    price: typeof price === "bigint" ? price.toString() : price,
  };
}

async function createClient(network, rpcUrl) {
  const url = rpcUrl || (network === "testnet" ? DEFAULT_TESTNET_RPC : DEFAULT_DEVNET_RPC);

  if (network === "devnet") {
    const scripts = await loadDevnetScriptsFromOffckb(url);
    return new ccc.ClientPublicTestnet({ url, scripts });
  }

  return new ccc.ClientPublicTestnet({ url });
}

async function loadDevnetScriptsFromOffckb(rpcUrl) {
  const { stdout } = await execFileAsync("offckb", [
    "system-scripts",
    "--network",
    "devnet",
    "--export-style",
    "ccc",
  ]);

  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Failed to parse offckb devnet scripts output");
  }

  const scripts = JSON.parse(stdout.slice(start, end + 1));

  if (!scripts.NervosDao) {
    const daoInfo = await loadDaoScriptFromCkbCli(rpcUrl);
    if (daoInfo) {
      scripts.NervosDao = daoInfo;
    }
  }

  return scripts;
}

function depTypeFromCli(value) {
  if (value === "dep_group") return "depGroup";
  return value;
}

function parseHexIndex(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.startsWith("0x")) {
    return Number.parseInt(value.slice(2), 16);
  }
  return Number(value);
}

async function loadDaoScriptFromCkbCli(rpcUrl) {
  try {
    const { stdout } = await execFileAsync("ckb-cli", [
      "--url",
      rpcUrl,
      "util",
      "genesis-scripts",
      "--output-format",
      "json",
    ]);

    const parsed = JSON.parse(stdout);
    const dao = parsed?.dao;
    if (!dao?.script_id || !dao?.cell_dep?.out_point) {
      return undefined;
    }

    return {
      codeHash: dao.script_id.code_hash,
      hashType: dao.script_id.hash_type,
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: dao.cell_dep.out_point.tx_hash,
              index: parseHexIndex(dao.cell_dep.out_point.index),
            },
            depType: depTypeFromCli(dao.cell_dep.dep_type),
          },
        },
      ],
    };
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeMineOneBlock(client, network) {
  if (network !== "devnet") return;
  try {
    await client.requestor.request("generate_block", []);
  } catch {
    // Ignore generate_block failures for non-test RPC endpoints.
  }
}

async function waitForCommitted(client, txHash, network) {
  const maxAttempts = network === "devnet" ? 40 : 80;

  for (let i = 0; i < maxAttempts; i += 1) {
    const tx = await client.getTransaction(txHash);
    if (tx?.status === "committed") {
      return tx;
    }
    if (tx?.status === "rejected") {
      throw new Error(`Transaction rejected: ${txHash} (${tx.reason ?? "unknown reason"})`);
    }

    await maybeMineOneBlock(client, network);
    await sleep(1500);
  }

  throw new Error(`Transaction not committed in time: ${txHash}`);
}

async function deployCodeCell(client, signer, binaryPath, feeRate, network) {
  const binary = await fs.readFile(binaryPath);
  const binaryHex = ccc.hexFrom(binary);

  const ownerAddress = await signer.getRecommendedAddressObj();

  const tx = ccc.Transaction.default();
  const outputIndex = tx.addOutput({ lock: ownerAddress.script }, binaryHex) - 1;

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, feeRate);

  const txHash = await signer.sendTransaction(tx);
  await waitForCommitted(client, txHash, network);

  return {
    txHash,
    index: outputIndex,
    codeHash: ccc.hashCkb(binaryHex),
  };
}

function toOutPointLike(outPoint) {
  return {
    txHash: outPoint.txHash,
    index: outPoint.index,
  };
}

async function upsertRegistryCell({
  client,
  network,
  signer,
  codeHash,
  hashType,
  typeArgs,
  codeOutPoint,
  payloadHex,
  feeRate,
}) {
  const ownerAddress = await signer.getRecommendedAddressObj();
  const codeDep = {
    outPoint: toOutPointLike(codeOutPoint),
    depType: "code",
  };

  let args = typeArgs;
  const scriptForSearch = args
    ? { codeHash, hashType, args }
    : undefined;

  let existing;
  if (scriptForSearch) {
    existing = await client.findSingletonCellByType(scriptForSearch, true);
  }

  if (existing) {
    const tx = ccc.Transaction.default();
    tx.addCellDeps(codeDep);
    tx.addInput(existing);
    tx.addOutput(
      {
        lock: existing.cellOutput.lock,
        type: {
          codeHash,
          hashType,
          args,
        },
      },
      payloadHex,
    );

    await tx.completeFeeBy(signer, feeRate);

    const txHash = await signer.sendTransaction(tx);
    await waitForCommitted(client, txHash, network);

    return {
      action: "updated",
      txHash,
      typeArgs: args,
      codeHash,
      hashType,
      codeOutPoint,
      registryCellOutPoint: { txHash, index: 0 },
    };
  }

  const tx = ccc.Transaction.default();
  tx.addCellDeps(codeDep);

  const placeholderArgs = args ?? `0x${"00".repeat(32)}`;
  const registryOutputIndex = tx.addOutput(
    {
      lock: ownerAddress.script,
      type: {
        codeHash,
        hashType,
        args: placeholderArgs,
      },
    },
    payloadHex,
  ) - 1;

  await tx.completeInputsByCapacity(signer);

  if (!args) {
    const firstInput = tx.getInput(0);
    if (!firstInput) {
      throw new Error("Unable to compute type-id: missing first input");
    }

    args = ccc.hashTypeId(firstInput, registryOutputIndex);
    if (!isValidTypeIdArgs(args)) {
      throw new Error(`Computed invalid type-id args: ${args}`);
    }

    if (!tx.outputs[registryOutputIndex].type) {
      throw new Error("Registry output has no type script");
    }
    tx.outputs[registryOutputIndex].type.args = args;
  }

  await tx.completeFeeBy(signer, feeRate);

  const txHash = await signer.sendTransaction(tx);
  await waitForCommitted(client, txHash, network);

  return {
    action: "created",
    txHash,
    typeArgs: args,
    codeHash,
    hashType,
    codeOutPoint,
    registryCellOutPoint: { txHash, index: registryOutputIndex },
  };
}

function normalizeOutPoint(outPoint) {
  const indexRaw = outPoint.index;
  const indexNum = Number(
    typeof indexRaw === "object" && indexRaw !== null && "toString" in indexRaw
      ? indexRaw.toString()
      : indexRaw,
  );

  return {
    txHash: outPoint.txHash,
    index: indexNum,
  };
}

async function writeDeploymentFiles({ network, rpcUrl, payloadJson, deployResult }) {
  const outputDir = path.join(registryRoot, "deployment", network);
  await fs.mkdir(outputDir, { recursive: true });

  const latestPath = path.join(outputDir, "registry.latest.json");
  const frontendPath = path.join(outputDir, "frontend.env");

  const latest = {
    network,
    rpcUrl,
    payload: JSON.parse(payloadJson),
    deployedAt: new Date().toISOString(),
    ...deployResult,
    codeOutPoint: normalizeOutPoint(deployResult.codeOutPoint),
    registryCellOutPoint: normalizeOutPoint(deployResult.registryCellOutPoint),
  };

  await fs.writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");

  const frontendEnv = [
    `VITE_AGENT_REGISTRY_RPC_URL=${rpcUrl}`,
    `VITE_AGENT_REGISTRY_TYPE_CODE_HASH=${deployResult.codeHash}`,
    `VITE_AGENT_REGISTRY_TYPE_HASH_TYPE=${deployResult.hashType}`,
    `VITE_AGENT_REGISTRY_TYPE_ARGS=${deployResult.typeArgs}`,
    "VITE_AGENT_REGISTRY_CELL_LIMIT=50",
    "",
  ].join("\n");

  await fs.writeFile(frontendPath, frontendEnv, "utf8");

  const writeProjectEnv = readEnv("WRITE_FRONTEND_ENV", "0") === "1";
  if (writeProjectEnv) {
    const targetEnv = path.join(workspaceRoot, ".env.local");
    await fs.writeFile(targetEnv, frontendEnv, "utf8");
  }

  return { latestPath, frontendPath };
}

async function main() {
  const network = parseNetwork();
  const rpcUrl = readEnv(
    "REGISTRY_RPC_URL",
    network === "testnet" ? DEFAULT_TESTNET_RPC : DEFAULT_DEVNET_RPC,
  );
  const privateKey = requireEnv("REGISTRY_PRIVATE_KEY");
  const feeRate = parseFeeRate();

  const client = await createClient(network, rpcUrl);
  const signer = new ccc.SignerCkbPrivateKey(client, privateKey);

  const payload = buildEndpointPayload();
  const payloadJson = JSON.stringify(payload);
  const payloadHex = ccc.hexFrom(ccc.bytesFrom(payloadJson, "utf8"));

  let codeHash = normalizeHex(readEnv("REGISTRY_TYPE_CODE_HASH"));
  if (codeHash === "0x") {
    codeHash = "";
  }

  let codeOutPoint = parseCodeOutPointFromEnv();

  if (!codeHash || !codeOutPoint) {
    const binaryPath = path.resolve(
      readEnv(
        "REGISTRY_BINARY_PATH",
        path.join(registryRoot, "build", "release", "service-registry"),
      ),
    );

    const deployed = await deployCodeCell(client, signer, binaryPath, feeRate, network);
    codeHash = deployed.codeHash;
    codeOutPoint = {
      txHash: deployed.txHash,
      index: deployed.index,
    };
  }

  const hashType = readEnv("REGISTRY_TYPE_HASH_TYPE", DEFAULT_HASH_TYPE);
  const typeArgsInput = normalizeHex(readEnv("REGISTRY_TYPE_ARGS"));
  const typeArgs = typeArgsInput === "0x" ? undefined : typeArgsInput;

  if (typeArgs && !isValidTypeIdArgs(typeArgs)) {
    throw new Error(`REGISTRY_TYPE_ARGS must be 32-byte hex, got ${typeArgs}`);
  }

  const deployResult = await upsertRegistryCell({
    client,
    network,
    signer,
    codeHash,
    hashType,
    typeArgs,
    codeOutPoint,
    payloadHex,
    feeRate,
  });

  const files = await writeDeploymentFiles({
    network,
    rpcUrl,
    payloadJson,
    deployResult,
  });

  console.log("Registry deployment finished");
  console.log(`- action: ${deployResult.action}`);
  console.log(`- txHash: ${deployResult.txHash}`);
  console.log(`- codeHash: ${deployResult.codeHash}`);
  console.log(`- hashType: ${deployResult.hashType}`);
  console.log(`- typeArgs(type-id): ${deployResult.typeArgs}`);
  console.log(`- codeOutPoint: ${deployResult.codeOutPoint.txHash}#${deployResult.codeOutPoint.index.toString()}`);
  console.log(`- record: ${files.latestPath}`);
  console.log(`- frontend env: ${files.frontendPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
