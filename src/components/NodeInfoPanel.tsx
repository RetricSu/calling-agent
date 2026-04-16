import { useEffect, useState } from "react";
import type { FiberBrowserNode } from "@fiber-pay/sdk/browser";
import {
  ConfigBuilder,
  getLockBalanceShannons,
  formatShannonsAsCkb,
} from "@fiber-pay/sdk/browser";
import { derivePublicKey, ckbHash, scriptToAddress } from "@fiber-pay/sdk";
import { QRCodeSVG } from "qrcode.react";

type NodeStats = {
  pubkey: string;
  peers: number;
  channels: number;
  ckbAddress: string | null;
  balanceCkb: string | null;
  externalFunding: boolean;
};

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function truncateMiddle(str: string, left = 8, right = 8): string {
  if (str.length <= left + right + 3) return str;
  return `${str.slice(0, left)}...${str.slice(-right)}`;
}

function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text);
}

const SECP256K1_BLAKE160_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8" as `0x${string}`;

async function fetchNodeStats(node: FiberBrowserNode, network: "testnet" | "mainnet"): Promise<NodeStats> {
  const [nodeInfo, peers, channels] = await Promise.all([
    node.getNodeInfo(),
    node.listPeers(),
    node.listChannels(),
  ]);

  const credential = (node as unknown as { config: { credential: { getCkbSecretKey: () => Promise<Uint8Array | undefined> } } }).config.credential;
  const ckbSecretKey = await credential.getCkbSecretKey();

  if (!ckbSecretKey) {
    return {
      pubkey: nodeInfo.pubkey,
      peers: peers.peers.length,
      channels: channels.channels.length,
      ckbAddress: null,
      balanceCkb: null,
      externalFunding: true,
    };
  }

  const pubkeyHex = await derivePublicKey(ckbSecretKey);
  const hash = ckbHash(hexToBytes(pubkeyHex));
  const blake160 = ("0x" + Array.from(hash.slice(0, 20))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")) as `0x${string}`;

  const lockScript = {
    code_hash: SECP256K1_BLAKE160_CODE_HASH,
    hash_type: "type" as const,
    args: blake160,
  };

  const ckbAddress = scriptToAddress(lockScript, network);
  const ckbRpcUrl = ConfigBuilder.getDefaults(network).ckbRpcUrl;
  const balanceShannons = await getLockBalanceShannons(ckbRpcUrl, lockScript);
  const balanceCkb = formatShannonsAsCkb(balanceShannons, 4);

  return {
    pubkey: nodeInfo.pubkey,
    peers: peers.peers.length,
    channels: channels.channels.length,
    ckbAddress,
    balanceCkb,
    externalFunding: false,
  };
}

interface NodeInfoPanelProps {
  node: FiberBrowserNode | null;
  network?: "testnet" | "mainnet";
}

export function NodeInfoPanel({ node, network = "testnet" }: NodeInfoPanelProps) {
  const [stats, setStats] = useState<NodeStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!node || node.state !== "running") {
      setStats(null);
      return;
    }

    const currentNode = node;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchNodeStats(currentNode, network);
        if (!cancelled) setStats(data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    const interval = setInterval(() => {
      void load();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [node, network]);

  if (!node || node.state !== "running") {
    return null;
  }

  const InfoRow = ({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) => (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-[var(--text-primary)]">{truncateMiddle(value)}</span>
        {copyable && (
          <button
            onClick={() => copyToClipboard(value)}
            className="rounded-md p-1 text-[var(--text-tertiary)] transition-micro hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title="Copy"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  const StatPill = ({ label, value }: { label: string; value: string | number }) => (
    <div className="flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-4 py-3">
      <span className="text-xs text-[var(--text-tertiary)]">{label}</span>
      <span className="text-lg font-semibold text-[var(--text-primary)]">{value}</span>
    </div>
  );

  return (
    <div className="mx-4 mt-4 w-full max-w-[900px] self-center rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-6 shadow-[var(--shadow-lg)]">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">Node Info</h2>
        {loading && (
          <span className="text-xs text-[var(--text-tertiary)]">Refreshing...</span>
        )}
      </div>

      {stats ? (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-1">
            <InfoRow label="Pubkey" value={stats.pubkey} copyable />
            {stats.externalFunding ? (
              <div className="py-2 text-sm text-[var(--text-tertiary)]">External funding mode — CKB address unavailable</div>
            ) : stats.ckbAddress ? (
              <>
                <InfoRow label="CKB Address" value={stats.ckbAddress} copyable />
                <InfoRow label="Balance" value={`${stats.balanceCkb ?? "—"} CKB`} />
              </>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <StatPill label="Peers" value={stats.peers} />
            <StatPill label="Channels" value={stats.channels} />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <svg className="h-4 w-4 animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Loading node info...
        </div>
      )}

      {stats?.ckbAddress && (
        <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
          <QRCodeSVG value={stats.ckbAddress} size={160} bgColor="transparent" fgColor="currentColor" className="text-[var(--text-primary)]" />
          <span className="text-xs text-[var(--text-tertiary)]">Scan to fund this CKB address</span>
        </div>
      )}
    </div>
  );
}
