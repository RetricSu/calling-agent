# registry

CKB on-chain service registry contract workspace.

This workspace is generated from `ckb-script-templates` and contains one contract crate:

- `contracts/service-registry`: type script used for service discovery.

## Contract behavior

The `service-registry` type script is indexed by:

- `code_hash`: hash of deployed `service-registry` binary.
- `hash_type`: default `data1`.
- `args`: **type-id** (32-byte hex).

Validation rules:

1. `args` must be exactly 32 bytes (type-id format).
2. Type-script group output count must be exactly `1`.
3. Type-script group input count must be `0` (create) or `1` (update).
4. For updates (`group input = 1`), input and output lock hash must stay the same.
5. Output data must be UTF-8 JSON text with:
	 - minimum/maximum size guard (`24..=1024` bytes)
	 - `"url"` field
	 - `"price"` field
	 - `http://` or `https://` URL fragment

Suggested JSON payload:

```json
{
	"endpoints": [
		{ "url": "https://agent-a.example", "price": "0.1 CKB" },
		{ "url": "https://agent-b.example", "price": "0.2 CKB" }
	],
	"updatedAt": "2026-04-24T00:00:00.000Z"
}
```

## Build and test

```bash
cd registry
make build
make test
```

## Deploy helper script

`scripts/deploy_registry.mjs` supports:

- deploying contract code cell (when code hash/outpoint not provided)
- creating or updating registry cell
- computing type-id args automatically on first creation
- writing deployment artifacts:
	- `deployment/<network>/registry.latest.json`
	- `deployment/<network>/frontend.env`

Required env:

- `REGISTRY_PRIVATE_KEY`

Optional env:

- `REGISTRY_NETWORK=devnet|testnet` (default: `devnet`)
- `REGISTRY_RPC_URL` (default devnet: `http://127.0.0.1:8114`, testnet: `https://testnet.ckb.dev/rpc`)
- `REGISTRY_URL`, `REGISTRY_PRICE`
- `REGISTRY_ENDPOINTS_JSON` (object or array)
- `REGISTRY_FEE_RATE` (default: `1200`)
- `REGISTRY_TYPE_CODE_HASH`
- `REGISTRY_TYPE_OUT_POINT_TX_HASH`
- `REGISTRY_TYPE_OUT_POINT_INDEX`
- `REGISTRY_TYPE_HASH_TYPE` (default: `data1`)
- `REGISTRY_TYPE_ARGS` (existing type-id, for updates)
- `WRITE_FRONTEND_ENV=1` (also overwrite project root `.env.local`)

### Offckb local devnet flow

1. Start local chain:

```bash
offckb node --network devnet
```

2. Build contract:

```bash
cd registry && make build
```

3. Deploy and seed registry cell:

```bash
REGISTRY_NETWORK=devnet \
REGISTRY_PRIVATE_KEY=0x6109170b275a09ad54877b82f7d9930f88cab5717d484fb4741ae9d1dd078cd6 \
REGISTRY_ENDPOINTS_JSON='[{"url":"https://agent.local","price":"0.01 CKB"}]' \
node scripts/deploy_registry.mjs
```

Use generated `deployment/devnet/frontend.env` for frontend config.

### Testnet flow

```bash
cd registry && make build

REGISTRY_NETWORK=testnet \
REGISTRY_PRIVATE_KEY=<funded_testnet_privkey> \
REGISTRY_ENDPOINTS_JSON='[{"url":"https://agent.testnet.example","price":"0.1 CKB"}]' \
node scripts/deploy_registry.mjs
```

Mainnet deployment is intentionally not included.

*This project was bootstrapped with [ckb-script-templates].*

[ckb-script-templates]: https://github.com/cryptape/ckb-script-templates
