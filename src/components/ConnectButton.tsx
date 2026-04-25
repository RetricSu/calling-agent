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

export interface ConnectButtonProps {
  node: FiberBrowserNode | null;
  nodeInfo: NodeInfoResult | null;
  error: string | null;
  isPasskeySupported: boolean;
  passkeyUnavailableReason: string | null;
  hasPasskeyConfigured: boolean;
  isStarting: boolean;
  isRunning: boolean;
  onRegisterPasskey: () => void;
  onConnectPasskey: () => void;
  onDisconnect: () => void;
}

export function ConnectButton({
  node,
  nodeInfo,
  error,
  isPasskeySupported,
  passkeyUnavailableReason,
  hasPasskeyConfigured,
  isStarting,
  isRunning,
  onRegisterPasskey,
  onConnectPasskey,
  onDisconnect,
}: ConnectButtonProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<NodeStats | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    if (showDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showDropdown]);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const DEFAULT_PEER_ADDRESS = "/dns4/bottle.fiber.channel/tcp/443/wss/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo";
const DEFAULT_PEER_ID = "QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo";

const [peerAddress, setPeerAddress] = useState(DEFAULT_PEER_ADDRESS);
  const [fundingAmount, setFundingAmount] = useState("1000");
  const [peerActionLoading, setPeerActionLoading] = useState(false);
  const [peerActionMsg, setPeerActionMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const channelPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const peerActionHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoConnectDoneRef = useRef(false);

  const [routeCheck, setRouteCheck] = useState<"unknown" | "has-route" | "no-route">("unknown");
  const [autoConnectStatus, setAutoConnectStatus] = useState<string | null>(null);

  const hasError = !!error;

  useEffect(() => {
    if (!node || !isRunning || autoConnectDoneRef.current) return;

    const currentNode = node;
    let cancelled = false;

    async function runAutoConnect() {
      autoConnectDoneRef.current = true;
      setAutoConnectStatus("Connecting to relay peer...");

      try {
        await currentNode.connectPeer({ address: DEFAULT_PEER_ADDRESS });
        if (cancelled) return;

        const peers = await currentNode.listPeers();
        if (cancelled) return;

        const matched = peers.peers.find((p) => p.address.includes(DEFAULT_PEER_ID));
        if (!matched) {
          setAutoConnectStatus("Connected but peer not found in list");
          return;
        }

        setAutoConnectStatus("Checking payment route...");

        const result = await currentNode.sendPayment({
          target_pubkey: matched.pubkey,
          amount: "0x1",
          keysend: true,
          dry_run: true,
        });

        if (cancelled) return;

        if (result.status !== "Failed") {
          setRouteCheck("has-route");
          setAutoConnectStatus("Payment route available");
        } else {
          setRouteCheck("no-route");
          setAutoConnectStatus("No payment route — open a channel to continue");
        }
      } catch (e) {
        if (!cancelled) {
          setAutoConnectStatus(e instanceof Error ? e.message : "Auto-connect failed");
        }
      }
    }

    void runAutoConnect();

    return () => {
      cancelled = true;
    };
  }, [node, isRunning]);

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
    setRouteCheck("unknown");
    setAutoConnectStatus(null);
    autoConnectDoneRef.current = false;
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
        .then(async () => {
          clearTimeout(safetyTimeout);
          clearInterval(uiPoll);
          channelPollRef.current = null;
          setPeerActionFeedback({ type: "success", text: CHANNEL_STATE_LABELS[ChannelState.ChannelReady] }, 6000);
          setPeerActionLoading(false);

          // Re-check route after channel is ready
          try {
            const routeResult = await node.sendPayment({
              target_pubkey: pubkey as `0x${string}`,
              amount: "0x1",
              keysend: true,
              dry_run: true,
            });
            if (routeResult.status !== "Failed") {
              setRouteCheck("has-route");
              setAutoConnectStatus("Payment route available");
            }
          } catch {
            // ignore dry_run errors after channel open
          }
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

  return (
    <div className="relative flex items-center gap-3">
      {(hasError || (!isPasskeySupported && passkeyUnavailableReason)) && (
        <span className="hidden max-w-[220px] truncate text-sm text-[var(--error)] sm:block">
          {error || passkeyUnavailableReason}
        </span>
      )}

      {isRunning ? (
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowDropdown((s) => !s)}
            className="flex items-center gap-2 rounded-full border border-[var(--accent)]/35 bg-[var(--accent)]/12 px-4 py-2 text-sm font-medium text-[var(--accent)] transition-micro hover:bg-[var(--accent)]/20"
          >
            {buttonContent}
          </button>

          {showDropdown && (
            <div className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 shadow-lg animate-in fade-in zoom-in-95">
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
                  <InfoRow label="Fnn Pubkey" value={stats.pubkey} copyable />
                  {stats.externalFunding ? (
                    <div className="py-1 text-xs text-[var(--text-tertiary)]">External funding mode</div>
                  ) : stats.ckbAddress ? (
                    <InfoRow label="CKB Address" value={stats.ckbAddress} copyable />
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
                      <span className="text-[10px] text-[var(--text-tertiary)]">Scan the qrcode to deposit the CKB address</span>
                      <div className="mt-1 flex w-full items-center justify-between border-t border-[var(--border-default)] pt-2 px-1">
                        <span className="text-xs text-[var(--text-secondary)]">Balance</span>
                        <span className="font-mono text-xs font-medium text-[var(--text-primary)]">{stats.balanceCkb ?? "—"} CKB</span>
                      </div>
                    </div>
                  )}
                </>
              )}

              {autoConnectStatus && (
                <div className={`mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs ${routeCheck === "no-route" ? "border border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]" : "text-[var(--text-secondary)]"}`}>
                  {autoConnectStatus.endsWith("...") ? (
                    <svg className="h-3 w-3 animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : routeCheck === "has-route" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : routeCheck === "no-route" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  )}
                  <span>{autoConnectStatus}</span>
                </div>
              )}

              <div className="my-3 border-t border-[var(--border-default)]" />

              {routeCheck === "no-route" && (
                <div className="mb-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3 text-xs text-[var(--warning)]">
                  <div className="mb-1 flex items-center gap-1.5 font-medium">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    No payment route found
                  </div>
                  <p className="mb-2 leading-relaxed opacity-90">
                    Your node is connected but cannot route payments to the relay. You need to open a channel with this peer to make payments.
                  </p>
                  <div className="flex items-center gap-2 rounded bg-[var(--bg-secondary)] px-2 py-1.5 text-[var(--text-secondary)]">
                    <span className="text-[10px]">Set funding amount and click</span>
                    <span className="rounded border border-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)]">Open</span>
                    <span className="text-[10px]">below</span>
                  </div>
                </div>
              )}

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
                  className="group flex w-full items-center justify-between rounded-lg border border-[var(--border-strong)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left text-sm font-semibold text-[var(--text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_0_rgba(0,0,0,0.45),0_10px_20px_rgba(0,0,0,0.25)] transition-micro hover:bg-[var(--bg-tertiary)] hover:translate-y-[1px] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_2px_0_rgba(0,0,0,0.45),0_8px_16px_rgba(0,0,0,0.22)] active:translate-y-[2px] active:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_0_rgba(0,0,0,0.45),0_6px_12px_rgba(0,0,0,0.2)]"
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
                    className="text-[var(--text-secondary)] transition-micro group-hover:translate-x-0.5 group-hover:text-[var(--text-primary)]"
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
  );
}
