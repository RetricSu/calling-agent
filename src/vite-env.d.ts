/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_AGENT_REGISTRY_RPC_URL?: string;
	readonly VITE_AGENT_REGISTRY_TYPE_CODE_HASH?: string;
	readonly VITE_AGENT_REGISTRY_TYPE_HASH_TYPE?: "type" | "data" | "data1" | "data2";
	readonly VITE_AGENT_REGISTRY_TYPE_ARGS?: string;
	readonly VITE_AGENT_REGISTRY_CELL_LIMIT?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
