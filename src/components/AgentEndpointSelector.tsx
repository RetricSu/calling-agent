import { ccc } from "@ckb-ccc/ccc";
import { useEffect, useMemo, useRef, useState } from "react";

type HashType = "type" | "data" | "data1" | "data2";

type AgentEndpointRecord = {
  id: string;
  url: string;
  priceLabel: string;
  sourceTx: string;
};

type AgentEndpointSelectorProps = {
  value: string;
  onChange: (url: string) => void;
};

type AgentCellData = {
  url: string;
  price?: string;
};

const HASH_TYPE_SET = new Set<HashType>(["type", "data", "data1", "data2"]);

const DEFAULT_CELL_LIMIT = 20;

const REGISTRY_RPC_URL = (import.meta.env.VITE_AGENT_REGISTRY_RPC_URL ?? "").trim();
const REGISTRY_TYPE_CODE_HASH = (import.meta.env.VITE_AGENT_REGISTRY_TYPE_CODE_HASH ?? "").trim();
const REGISTRY_TYPE_HASH_TYPE = normalizeHashType(
  import.meta.env.VITE_AGENT_REGISTRY_TYPE_HASH_TYPE
);
const REGISTRY_TYPE_ARGS = normalizeHex(import.meta.env.VITE_AGENT_REGISTRY_TYPE_ARGS ?? "0x");
const REGISTRY_CELL_LIMIT = normalizeCellLimit(import.meta.env.VITE_AGENT_REGISTRY_CELL_LIMIT);

function normalizeHashType(value?: string): HashType {
  if (value && HASH_TYPE_SET.has(value as HashType)) {
    return value as HashType;
  }
  return "type";
}

function normalizeHex(value: string): string {
  if (!value) return "0x";
  return value.startsWith("0x") ? value : `0x${value}`;
}

function normalizeCellLimit(value?: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CELL_LIMIT;
  return Math.min(parsed, 200);
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isHexData(value: string): boolean {
  return /^0x[0-9a-fA-F]*$/.test(value);
}

function hexToUtf8(hex: string): string {
  if (!isHexData(hex) || hex.length <= 2) return "";

  const data = hex.slice(2);
  const bytes = new Uint8Array(data.length / 2);

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(data.slice(i * 2, i * 2 + 2), 16);
  }

  let decoded = new TextDecoder().decode(bytes).trim();
  while (decoded.endsWith("\0")) {
    decoded = decoded.slice(0, -1);
  }
  return decoded.trim();
}

function toPriceLabel(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "N/A";
  }

  if (value && typeof value === "object") {
    const maybeAmount = (value as { amount?: unknown }).amount;
    const maybeUnit = (value as { unit?: unknown }).unit;

    if (
      (typeof maybeAmount === "number" || typeof maybeAmount === "string" || typeof maybeAmount === "bigint") &&
      typeof maybeUnit === "string"
    ) {
      return `${String(maybeAmount)} ${maybeUnit}`;
    }
  }

  return "N/A";
}

function parseStructuredData(payload: unknown): AgentCellData | null {
  if (!payload || typeof payload !== "object") return null;

  const data = payload as {
    url?: unknown;
    endpoint?: unknown;
    agentUrl?: unknown;
    price?: unknown;
    fee?: unknown;
    amount?: unknown;
  };

  const urlCandidate = [data.url, data.endpoint, data.agentUrl].find(
    (item): item is string => typeof item === "string" && isLikelyUrl(item)
  );

  if (!urlCandidate) return null;

  const priceCandidate =
    data.price ??
    data.fee ??
    data.amount;

  return {
    url: urlCandidate.trim(),
    price: toPriceLabel(priceCandidate),
  };
}

function parseCellData(outputData: string): AgentCellData | null {
  const text = hexToUtf8(outputData);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const record = parseStructuredData(item);
        if (record) return record;
      }
      return null;
    }

    return parseStructuredData(parsed);
  } catch {
    const segments = text
      .split(/\r?\n|\||,/)
      .map((item) => item.trim())
      .filter(Boolean);

    const url = segments.find((item) => isLikelyUrl(item));
    if (!url) return null;

    const price = segments.find((item) => item !== url);

    return {
      url,
      price: price ?? "N/A",
    };
  }
}

async function fetchRegistryEndpoints(): Promise<AgentEndpointRecord[]> {
  if (!REGISTRY_TYPE_CODE_HASH) {
    throw new Error("Missing VITE_AGENT_REGISTRY_TYPE_CODE_HASH");
  }

  const client = REGISTRY_RPC_URL
    ? new ccc.ClientPublicTestnet({ url: REGISTRY_RPC_URL })
    : new ccc.ClientPublicTestnet();

  const records: AgentEndpointRecord[] = [];
  const dedup = new Set<string>();

  const typeScript = {
    codeHash: REGISTRY_TYPE_CODE_HASH,
    hashType: REGISTRY_TYPE_HASH_TYPE,
    args: REGISTRY_TYPE_ARGS,
  };

  for await (const cell of client.findCellsByType(typeScript, true, "desc", REGISTRY_CELL_LIMIT)) {
    const outputData = String(cell.outputData ?? "0x");
    const parsed = parseCellData(outputData);
    if (!parsed || dedup.has(parsed.url)) {
      continue;
    }

    dedup.add(parsed.url);

    const txHash = String(cell.outPoint.txHash);
    const txIndex = String(cell.outPoint.index);
    records.push({
      id: `${txHash}-${txIndex}`,
      url: parsed.url,
      priceLabel: parsed.price ?? "N/A",
      sourceTx: txHash,
    });
  }

  return records;
}

function compactUrl(url: string): string {
  if (url.length <= 48) return url;
  return `${url.slice(0, 20)}...${url.slice(-16)}`;
}

function compactCustomUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "Custom endpoint";
  if (trimmed.length <= 32) return `Custom: ${trimmed}`;
  return `Custom: ${trimmed.slice(0, 14)}...${trimmed.slice(-12)}`;
}

export function AgentEndpointSelector({ value, onChange }: AgentEndpointSelectorProps) {
  const [records, setRecords] = useState<AgentEndpointRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"registry" | "custom">("registry");
  const [isCustomEditing, setIsCustomEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [customUrl, setCustomUrl] = useState(value);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);
  const customInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const endpoints = await fetchRegistryEndpoints();
        if (cancelled) return;

        setRecords(endpoints);

        if (endpoints.length === 0) {
          setMode("custom");
          return;
        }

        const matched = endpoints.find((item) => item.url === initialValueRef.current);
        if (matched) {
          setMode("registry");
          setSelectedId(matched.id);
          return;
        }

        setMode("registry");
        setSelectedId(endpoints[0].id);
        if (endpoints[0].url !== initialValueRef.current) {
          onChangeRef.current(endpoints[0].url);
        }
      } catch (err) {
        if (cancelled) return;
        setMode("custom");
        const message = err instanceof Error ? err.message : "Failed to load registry";
        setError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCustomUrl(value);
  }, [value]);

  useEffect(() => {
    if (isCustomEditing) {
      customInputRef.current?.focus();
      customInputRef.current?.select();
    }
  }, [isCustomEditing]);

  useEffect(() => {
    if (mode !== "registry" || records.length === 0) {
      return;
    }

    const matched = records.find((item) => item.url === value);
    if (matched && matched.id !== selectedId) {
      setSelectedId(matched.id);
    }
  }, [mode, records, selectedId, value]);

  const selectedRecord = useMemo(
    () => records.find((item) => item.id === selectedId),
    [records, selectedId]
  );

  function handleSelectChange(next: string) {
    if (next === "custom-edit") {
      setMode("custom");
      setIsCustomEditing(true);
      return;
    }

    if (next === "custom-current") {
      setMode("custom");
      setIsCustomEditing(false);
      return;
    }

    setMode("registry");
    setIsCustomEditing(false);
    setSelectedId(next);

    const record = records.find((item) => item.id === next);
    if (record && record.url !== value) {
      onChange(record.url);
    }
  }

  function handleCustomInput(next: string) {
    setCustomUrl(next);
    onChange(next);
  }

  function handleCustomInputBlur() {
    setIsCustomEditing(false);
  }

  function handleCustomInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "Escape") {
      event.currentTarget.blur();
    }
  }

  return (
    <div className="mx-4 hidden min-w-0 flex-1 items-center justify-center gap-3 md:flex">
      <div className="shrink-0 text-xs text-[var(--text-secondary)]">
        AI Agent Endpoint
        <span className="mx-1.5 text-[var(--border-strong)]">|</span>
        <a
          href="https://github.com/RetricSu/fiber-pay/blob/feat/agent-boxlite-sandbox/docs/boxlite-agent-setup.md"
          target="_blank"
          rel="noreferrer"
          className="transition-micro hover:text-[var(--accent)] hover:underline"
        >
          Host your own
        </a>
      </div>

      <div className="flex min-w-0 flex-1 items-center">
        {mode === "custom" && isCustomEditing ? (
          <input
            ref={customInputRef}
            type="text"
            value={customUrl}
            onChange={(e) => handleCustomInput(e.target.value)}
            onBlur={handleCustomInputBlur}
            onKeyDown={handleCustomInputKeyDown}
            placeholder="https://..."
            className="w-full max-w-[320px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-micro focus:border-[var(--accent-dim)]"
          />
        ) : (
          <select
            value={mode === "custom" ? "custom-current" : selectedId}
            onChange={(e) => handleSelectChange(e.target.value)}
            className="w-full max-w-[320px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-primary)] outline-none transition-micro focus:border-[var(--accent-dim)]"
          >
            {loading && <option value="">Loading endpoints from chain...</option>}
            {!loading && records.length === 0 && (
              <option value="">No on-chain endpoints</option>
            )}
            {records.map((item) => (
              <option key={item.id} value={item.id}>
                {`${compactUrl(item.url)} | ${item.priceLabel}`}
              </option>
            ))}
            <option value="custom-current">{compactCustomUrl(customUrl)}</option>
            <option value="custom-edit">Edit custom URL...</option>
          </select>
        )}
      </div>

      <div className="max-w-[180px] truncate text-[10px] text-[var(--text-muted)]" title={selectedRecord?.sourceTx}>
        {mode === "registry" && selectedRecord
          ? `Price ${selectedRecord.priceLabel}`
          : error
            ? `Registry unavailable: ${error}`
            : "Custom endpoint"}
      </div>
    </div>
  );
}
