import { useEffect, useRef, useState } from "react";
import type { FiberBrowserNode, NodeInfoResult } from "@fiber-pay/sdk/browser";
import {
  ChannelState,
  ConfigBuilder,
  getLockBalanceShannons,
  formatShannonsAsCkb,
} from "@fiber-pay/sdk/browser";
import { scriptToAddress, ckbToShannons } from "@fiber-pay/sdk";
import { QRCodeSVG } from "qrcode.react";

function truncateNodeId(id: string) {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function truncateMiddle(str: string, left = 8, right = 8): string {
  if (str.length <= left + right + 3) return str;
  return `${str.slice(0, left)}...${str.slice(-right)}`;
}

function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text);
}

const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  [ChannelState.NegotiatingFunding]: "Negotiating funding...",
  [ChannelState.CollaboratingFundingTx]: "Building funding transaction...",
  [ChannelState.SigningCommitment]: "Signing commitment...",
  [ChannelState.AwaitingTxSignatures]: "Awaiting transaction signatures...",
  [ChannelState.AwaitingChannelReady]: "Waiting for on-chain confirmation...",
  [ChannelState.ChannelReady]: "Channel ready!",
  [ChannelState.ShuttingDown]: "Shutting down...",
  [ChannelState.Closed]: "Channel closed",
};

type NodeStats = {
  pubkey: string;
  peers: number;
  channels: number;
  ckbAddress: string | null;
  balanceCkb: string | null;
  externalFunding: boolean;
};

async function fetchNodeStats(node: FiberBrowserNode, network: "testnet" | "mainnet"): Promise<NodeStats> {
  const [nodeInfo, peers, channels] = await Promise.all([
    node.getNodeInfo(),
    node.listPeers(),
    node.listChannels(),
  ]);

  const lockScript = nodeInfo.default_funding_lock_script;
  const ckbRpcUrl = ConfigBuilder.getDefaults(network).ckbRpcUrl;

  if (!lockScript || lockScript.args === "0x") {
    return {
      pubkey: nodeInfo.pubkey,
      peers: peers.peers.length,
      channels: channels.channels.length,
      ckbAddress: null,
      balanceCkb: null,
      externalFunding: true,
    };
  }

  const ckbAddress = scriptToAddress(lockScript, network);
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

interface HeaderProps {
  node: FiberBrowserNode | null;
  nodeInfo: NodeInfoResult | null;
  error: string | null;
  isPasskeySupported: boolean;
  passkeyUnavailableReason: string | null;
  hasPasskeyConfigured: boolean;
  isStarting: boolean;
  isRunning: boolean;
  agentUrl: string;
  onAgentUrlChange: (url: string) => void;
  onRegisterPasskey: () => void;
  onConnectPasskey: () => void;
  onDisconnect: () => void;
}

export function Header({
  node,
  nodeInfo,
  error,
  isPasskeySupported,
  passkeyUnavailableReason,
  hasPasskeyConfigured,
  isStarting,
  isRunning,
  agentUrl,
  onAgentUrlChange,
  onRegisterPasskey,
  onConnectPasskey,
  onDisconnect,
}: HeaderProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [stats, setStats] = useState<NodeStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [peerAddress, setPeerAddress] = useState("/dns4/bottle.fiber.channel/tcp/443/wss/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo");
  const [fundingAmount, setFundingAmount] = useState("1000");
  const [peerActionLoading, setPeerActionLoading] = useState(false);
  const [peerActionMsg, setPeerActionMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const channelPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const peerActionHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasError = !!error;

  function setPeerActionFeedback(
    message: { type: "success" | "error"; text: string } | null,
    autoHideMs?: number,
  ) {
    if (peerActionHideRef.current) {
      clearTimeout(peerActionHideRef.current);
      peerActionHideRef.current = null;
    }

    setPeerActionMsg(message);

    if (message && autoHideMs && autoHideMs > 0) {
      peerActionHideRef.current = setTimeout(() => {
        setPeerActionMsg(null);
        peerActionHideRef.current = null;
      }, autoHideMs);
    }
  }

  useEffect(() => {
    if (!node || node.state !== "running") {
      setStats(null);
      setStatsError(null);
      return;
    }

    const currentNode = node;
    let cancelled = false;

    async function load() {
      setStatsLoading(true);
      setStatsError(null);
      try {
        const data = await fetchNodeStats(currentNode, "testnet");
        if (!cancelled) setStats(data);
      } catch (e) {
        if (!cancelled) {
          setStatsError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setStatsLoading(false);
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
  }, [node, node?.state]);

  useEffect(() => {
    return () => {
      if (channelPollRef.current) {
        clearInterval(channelPollRef.current);
        channelPollRef.current = null;
      }
      if (peerActionHideRef.current) {
        clearTimeout(peerActionHideRef.current);
        peerActionHideRef.current = null;
      }
    };
  }, []);

  async function handleDisconnect() {
    await onDisconnect();
    setShowDropdown(false);
  }

  async function handleConnectPeer() {
    if (!node || !peerAddress.trim()) return;
    setPeerActionLoading(true);
    setPeerActionFeedback(null);
    try {
      await node.connectPeer({ address: peerAddress.trim() });
      setPeerActionFeedback({ type: "success", text: "Peer connected" }, 4000);
    } catch (e) {
      setPeerActionFeedback({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPeerActionLoading(false);
    }
  }

  async function handleOpenChannel() {
    if (!node || !peerAddress.trim()) return;

    const trimmed = peerAddress.trim();
    const isHexPubkey = /^0x[0-9a-fA-F]{66}$/.test(trimmed);
    let pubkey = isHexPubkey ? trimmed : null;

    setPeerActionLoading(true);
    setPeerActionFeedback(null);

    if (channelPollRef.current) {
      clearInterval(channelPollRef.current);
      channelPollRef.current = null;
    }

    try {
      if (!pubkey) {
        await node.connectPeer({ address: trimmed });
        const peers = await node.listPeers();
        const matched = peers.peers.find((p) => p.address === trimmed);
        if (!matched) {
          setPeerActionFeedback({ type: "error", text: "Connected but could not find peer pubkey. Try again in a moment." });
          setPeerActionLoading(false);
          return;
        }
        pubkey = matched.pubkey;
      }

      const result = await node.openChannel({
        pubkey: pubkey as `0x${string}`,
        funding_amount: ckbToShannons(fundingAmount.trim()),
        public: true,
      });

      const channelId = result.temporary_channel_id;
      setPeerActionFeedback({ type: "success", text: CHANNEL_STATE_LABELS[ChannelState.NegotiatingFunding] });

      const uiPoll = setInterval(async () => {
        try {
          const list = await node.listChannels();
          const ch = list.channels.find((c) => c.channel_id === channelId);
          if (!ch) return;
          const stateName = ch.state.state_name;
          const label = CHANNEL_STATE_LABELS[stateName] || stateName;
          setPeerActionFeedback({ type: "success", text: label });
        } catch {
        }
      }, 3000);

      channelPollRef.current = uiPoll;

      const safetyTimeout = setTimeout(() => {
        clearInterval(uiPoll);
        channelPollRef.current = null;
        setPeerActionFeedback({ type: "error", text: "Timed out waiting for channel to open. Please check your node balance and logs." });
        setPeerActionLoading(false);
      }, 180000);

      node.waitForChannelReady(channelId, { timeout: 180000, interval: 5000 })
        .then(() => {
          clearTimeout(safetyTimeout);
          clearInterval(uiPoll);
          channelPollRef.current = null;
          setPeerActionFeedback({ type: "success", text: CHANNEL_STATE_LABELS[ChannelState.ChannelReady] }, 6000);
          setPeerActionLoading(false);
        })
        .catch((err) => {
          clearTimeout(safetyTimeout);
          clearInterval(uiPoll);
          channelPollRef.current = null;
          setPeerActionFeedback({ type: "error", text: err instanceof Error ? err.message : String(err) });
          setPeerActionLoading(false);
        });
    } catch (e) {
      setPeerActionFeedback({ type: "error", text: e instanceof Error ? e.message : String(e) });
      setPeerActionLoading(false);
    }
  }

  let buttonContent: React.ReactNode = null;
  let buttonOnClick: (() => void) | undefined = undefined;
  let buttonDisabled = false;

  if (isRunning) {
    buttonContent = (
      <>
        <span className="h-2 w-2 rounded-full bg-[var(--accent)]"></span>
        <span className="font-mono">
          {nodeInfo?.pubkey ? truncateNodeId(nodeInfo.pubkey) : "Connected"}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-micro ${showDropdown ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </>
    );
  } else if (isStarting) {
    buttonContent = (
      <>
        <svg
          className="h-4 w-4 animate-spin"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        Connecting...
      </>
    );
    buttonDisabled = true;
  } else if (!isPasskeySupported) {
    buttonContent = "Passkey unavailable";
    buttonDisabled = true;
  } else if (!hasPasskeyConfigured) {
    buttonContent = "Connect via Passkey";
    buttonOnClick = onRegisterPasskey;
  } else {
    buttonContent = "Connect with Passkey";
    buttonOnClick = onConnectPasskey;
  }

  const InfoRow = ({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-[var(--text-primary)]">{truncateMiddle(value, 6, 6)}</span>
        {copyable && (
          <button
            onClick={() => copyToClipboard(value)}
            className="rounded p-1 text-[var(--text-tertiary)] transition-micro hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title="Copy"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[var(--border-default)] bg-[var(--bg-primary)]/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-subtle)] text-[var(--accent)]">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2a3 3 0 0 0-3 3v14a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3Z" />
              <path d="M5 10a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3Z" />
            </svg>
          </div>
          <span className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            Calling Agent
          </span>
        </div>

        <div className="mx-4 hidden min-w-0 flex-1 items-center justify-center gap-2 md:flex">
          <span className="shrink-0 text-xs text-[var(--text-secondary)]">Agent URL</span>
          <input
            type="text"
            value={agentUrl}
            onChange={(e) => onAgentUrlChange(e.target.value)}
            placeholder="https://..."
            className="w-full max-w-[220px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-micro focus:border-[var(--accent-dim)]"
          />
          <a
            href="https://github.com/RetricSu/fiber-pay/blob/feat/agent-boxlite-sandbox/docs/boxlite-agent-setup.md"
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs text-[var(--text-tertiary)] transition-micro hover:text-[var(--accent)] hover:underline"
          >
            Host your own
          </a>
        </div>

        <div className="relative flex items-center gap-3">
          {(hasError || (!isPasskeySupported && passkeyUnavailableReason)) && (
            <span className="hidden max-w-[220px] truncate text-sm text-[var(--error)] sm:block">
              {error || passkeyUnavailableReason}
            </span>
          )}

          {isRunning ? (
            <div className="relative">
              <button
                onClick={() => setShowDropdown((s) => !s)}
                className="flex items-center gap-2 rounded-full border border-[var(--accent)]/35 bg-[var(--accent)]/12 px-4 py-2 text-sm font-medium text-[var(--accent)] transition-micro hover:bg-[var(--accent)]/20"
              >
                {buttonContent}
              </button>

              {showDropdown && (
                <div className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 shadow-lg animate-in fade-in zoom-in-95">
                  <div className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Node Info</div>

                  {statsLoading && !stats && (
                    <div className="flex items-center gap-2 py-2 text-xs text-[var(--text-secondary)]">
                      <svg className="h-3 w-3 animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      Loading...
                    </div>
                  )}

                  {statsError && (
                    <div className="mb-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-2 py-1.5 text-xs text-[var(--error)]">
                      {statsError}
                    </div>
                  )}

                  {stats && (
                    <>
                      <InfoRow label="Pubkey" value={stats.pubkey} copyable />
                      {stats.externalFunding ? (
                        <div className="py-1 text-xs text-[var(--text-tertiary)]">External funding mode</div>
                      ) : stats.ckbAddress ? (
                        <>
                          <InfoRow label="CKB Address" value={stats.ckbAddress} copyable />
                          <InfoRow label="Balance" value={`${stats.balanceCkb ?? "—"} CKB`} />
                        </>
                      ) : null}

                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 text-center">
                          <div className="text-[10px] text-[var(--text-tertiary)]">Peers</div>
                          <div className="text-sm font-semibold text-[var(--text-primary)]">{stats.peers}</div>
                        </div>
                        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 text-center">
                          <div className="text-[10px] text-[var(--text-tertiary)]">Channels</div>
                          <div className="text-sm font-semibold text-[var(--text-primary)]">{stats.channels}</div>
                        </div>
                      </div>

                      {stats.ckbAddress && (
                        <div className="mt-3 flex flex-col items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2">
                          <QRCodeSVG value={stats.ckbAddress} size={120} bgColor="transparent" fgColor="currentColor" className="text-[var(--text-primary)]" />
                          <span className="text-[10px] text-[var(--text-tertiary)]">Scan to fund</span>
                        </div>
                      )}
                    </>
                  )}

                  <div className="my-3 border-t border-[var(--border-default)]" />

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-[var(--text-primary)]">Connect / Open Channel</div>
                    <input
                      type="text"
                      value={peerAddress}
                      onChange={(e) => setPeerAddress(e.target.value)}
                      placeholder="/ip4/.../tcp/.../p2p/..."
                      className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-dim)]"
                    />
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        type="text"
                        value={fundingAmount}
                        onChange={(e) => setFundingAmount(e.target.value)}
                        placeholder="Funding amount (CKB)"
                        className="min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-dim)]"
                      />
                      <button
                        onClick={handleConnectPeer}
                        disabled={peerActionLoading || !peerAddress.trim()}
                        className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--bg-primary)] transition-micro hover:bg-[var(--accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Connect
                      </button>
                      <button
                        onClick={handleOpenChannel}
                        disabled={peerActionLoading || !peerAddress.trim()}
                        className="rounded-lg border border-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accent)] transition-micro hover:bg-[var(--accent-subtle)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Open
                      </button>
                    </div>
                    {peerActionMsg && (
                      <div className={`rounded-lg px-2 py-1.5 text-xs ${peerActionMsg.type === "success" ? "border border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]" : "border border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]"}`}>
                        {peerActionMsg.text}
                    </div>
                    )}
                  </div>

                  <div className="mt-3 border-t border-[var(--border-default)] pt-2">
                    <button
                      onClick={handleDisconnect}
                      className="group flex w-full items-center justify-between rounded-lg border border-[var(--error)]/35 bg-[var(--error)]/8 px-3 py-2 text-left text-sm font-medium text-[var(--error)] transition-micro hover:bg-[var(--error)]/14"
                    >
                      <span>Disconnect</span>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="transition-micro group-hover:translate-x-0.5"
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={buttonOnClick}
              disabled={buttonDisabled}
              className="flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[var(--bg-primary)] shadow-[var(--shadow-md)] transition-micro hover:bg-[var(--accent-dim)] hover:shadow-[var(--shadow-glow)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {buttonContent}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
