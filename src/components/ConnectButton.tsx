import { useEffect, useMemo, useRef, useState } from "react";
import type { FiberBrowserNode, NodeInfoResult } from "@fiber-pay/sdk/browser";
import {
  ChannelState,
  ConfigBuilder,
  getLockBalanceShannons,
  formatShannonsAsCkb,
} from "@fiber-pay/sdk/browser";
import { scriptToAddress, ckbToShannons } from "@fiber-pay/sdk";
import { QRCodeSVG } from "qrcode.react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PEER_ADDRESS =
  "/dns4/bottle.fiber.channel/tcp/443/wss/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo";
const DEFAULT_PEER_ID = "QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo";
const DEFAULT_FUNDING_CKB = "1000";
const FAUCET_URL = "https://faucet.nervos.org/";

const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  [ChannelState.NegotiatingFunding]: "Negotiating funding",
  [ChannelState.CollaboratingFundingTx]: "Building funding transaction",
  [ChannelState.SigningCommitment]: "Signing commitment",
  [ChannelState.AwaitingTxSignatures]: "Awaiting tx signatures",
  [ChannelState.AwaitingChannelReady]: "Awaiting on-chain confirmation",
  [ChannelState.ChannelReady]: "Channel ready",
  [ChannelState.ShuttingDown]: "Shutting down",
  [ChannelState.Closed]: "Closed",
};

/**
 * The browser FiberBrowserNode returns raw state names from the WASM adapter
 * (e.g. "ChannelReady"), which do NOT go through the JSON-RPC client's
 * `normalizeChannelStateName`. Normalize here so comparisons against
 * `ChannelState` enum values (SCREAMING_SNAKE_CASE) work consistently.
 */
function normalizeChannelState(stateName: string): ChannelState {
  const normalized = stateName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  for (const value of Object.values(ChannelState)) {
    if (value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() === normalized) {
      return value as ChannelState;
    }
  }
  return stateName as ChannelState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Snapshot fetching
// ---------------------------------------------------------------------------

type ChannelSummary = {
  channel_id: string;
  pubkey: string;
  state: ChannelState;
  is_ready: boolean;
  created_at: number;
};

type NodeSnapshot = {
  pubkey: string;
  ckbAddress: string | null;
  balanceCkb: string | null;
  balanceNumber: number | null;
  externalFunding: boolean;
  peerCount: number;
  isPeerConnected: boolean; // relay peer connected
  relayPubkey: string | null;
  channels: ChannelSummary[];
  channelsToRelay: ChannelSummary[];
  readyChannelToRelay: ChannelSummary | null;
};

async function fetchSnapshot(
  node: FiberBrowserNode,
  network: "testnet" | "mainnet",
): Promise<NodeSnapshot> {
  const [nodeInfo, peers, channels] = await Promise.all([
    node.getNodeInfo(),
    node.listPeers(),
    node.listChannels(),
  ]);

  const lockScript = nodeInfo.default_funding_lock_script;
  const ckbRpcUrl = ConfigBuilder.getDefaults(network).ckbRpcUrl;

  let ckbAddress: string | null = null;
  let balanceCkb: string | null = null;
  let balanceNumber: number | null = null;
  const externalFunding = !lockScript || lockScript.args === "0x";

  if (!externalFunding && lockScript) {
    ckbAddress = scriptToAddress(lockScript, network);
    try {
      const shannons = await getLockBalanceShannons(ckbRpcUrl, lockScript);
      balanceCkb = formatShannonsAsCkb(shannons, 4);
      balanceNumber = Number(balanceCkb);
    } catch {
      // ignore — surfaced as null balance
    }
  }

  const relayPeer = peers.peers.find((p) => p.address.includes(DEFAULT_PEER_ID));
  const relayPubkey = relayPeer?.pubkey ?? null;

  const channelSummaries: ChannelSummary[] = channels.channels.map((c) => {
    const state = normalizeChannelState(c.state.state_name as string);
    return {
      channel_id: c.channel_id,
      pubkey: c.pubkey,
      state,
      is_ready: state === ChannelState.ChannelReady,
      created_at: Number(c.created_at) || 0,
    };
  });

  const channelsToRelay = relayPubkey
    ? channelSummaries.filter((c) => c.pubkey === relayPubkey && c.state !== ChannelState.Closed)
    : [];

  const readyChannelToRelay =
    channelsToRelay.find((c) => c.is_ready) ?? null;

  return {
    pubkey: nodeInfo.pubkey,
    ckbAddress,
    balanceCkb,
    balanceNumber,
    externalFunding,
    peerCount: peers.peers.length,
    isPeerConnected: !!relayPeer,
    relayPubkey,
    channels: channelSummaries,
    channelsToRelay,
    readyChannelToRelay,
  };
}

// ---------------------------------------------------------------------------
// Reusable presentational helpers
// ---------------------------------------------------------------------------

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

type StepStatus = "pending" | "active" | "done";

const StepHeader = ({
  index,
  title,
  status,
  hint,
}: {
  index: number;
  title: string;
  status: StepStatus;
  hint?: string;
}) => {
  const ring =
    status === "done"
      ? "bg-[var(--success)] text-[var(--bg-primary)] border-[var(--success)]"
      : status === "active"
      ? "bg-[var(--accent)] text-[var(--bg-primary)] border-[var(--accent)]"
      : "bg-transparent text-[var(--text-tertiary)] border-[var(--border-strong)]";
  const titleColor =
    status === "pending" ? "text-[var(--text-tertiary)]" : "text-[var(--text-primary)]";

  return (
    <div className="flex items-center gap-2">
      <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${ring}`}>
        {status === "done" ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          index
        )}
      </div>
      <div className="flex-1">
        <div className={`text-xs font-medium ${titleColor}`}>{title}</div>
        {hint && <div className="text-[10px] text-[var(--text-tertiary)]">{hint}</div>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  // --- UI state -------------------------------------------------------------
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // --- Snapshot polling -----------------------------------------------------
  const [snapshot, setSnapshot] = useState<NodeSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const refreshFnRef = useRef<(() => Promise<void>) | null>(null);

  // --- Action state ---------------------------------------------------------
  const [fundingAmount, setFundingAmount] = useState(DEFAULT_FUNDING_CKB);

  const [peerActionLoading, setPeerActionLoading] = useState(false);
  const [peerError, setPeerError] = useState<string | null>(null);
  const peerAttemptedRef = useRef(false);

  const [openChannelLoading, setOpenChannelLoading] = useState(false);
  const [openChannelError, setOpenChannelError] = useState<string | null>(null);
  const [activeOpen, setActiveOpen] = useState<{
    tempChannelId: string;
    pubkey: string;
    startedAt: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());

  const [routeStatus, setRouteStatus] = useState<"unknown" | "checking" | "has-route" | "no-route">(
    "unknown",
  );
  const [routeError, setRouteError] = useState<string | null>(null);
  const lastRouteCheckKeyRef = useRef<string | null>(null);

  // --- Close-on-outside-click ----------------------------------------------
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

  // --- Reset on disconnect --------------------------------------------------
  useEffect(() => {
    if (!isRunning) {
      setSnapshot(null);
      setSnapshotError(null);
      setActiveOpen(null);
      setOpenChannelError(null);
      setPeerError(null);
      setRouteStatus("unknown");
      setRouteError(null);
      peerAttemptedRef.current = false;
      lastRouteCheckKeyRef.current = null;
    }
  }, [isRunning]);

  // --- Snapshot poll loop ---------------------------------------------------
  useEffect(() => {
    if (!node || !isRunning) return;
    const currentNode = node;
    let cancelled = false;

    async function refresh() {
      setSnapshotLoading(true);
      try {
        const data = await fetchSnapshot(currentNode, "testnet");
        if (!cancelled) {
          setSnapshot(data);
          setSnapshotError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setSnapshotError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setSnapshotLoading(false);
      }
    }

    refreshFnRef.current = refresh;
    void refresh();

    // Poll faster while the dropdown is open or while a channel open is in progress
    const intervalMs = showDropdown || activeOpen ? 3000 : 20000;
    const interval = setInterval(() => {
      void refresh();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [node, isRunning, showDropdown, activeOpen]);

  // --- Tick clock for elapsed time display while opening --------------------
  useEffect(() => {
    if (!activeOpen) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeOpen]);

  // --- Auto-connect relay peer once after running --------------------------
  useEffect(() => {
    if (!node || !isRunning || peerAttemptedRef.current) return;
    if (!snapshot) return; // wait for first snapshot
    if (snapshot.isPeerConnected) {
      peerAttemptedRef.current = true;
      return;
    }
    peerAttemptedRef.current = true;
    void runConnectRelay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, isRunning, snapshot?.isPeerConnected, snapshot]);

  // --- Detect channel-open completion via snapshot --------------------------
  useEffect(() => {
    if (!activeOpen || !snapshot) return;
    const ch =
      snapshot.channels.find((c) => c.channel_id === activeOpen.tempChannelId) ??
      snapshot.channelsToRelay
        .filter((c) => c.created_at >= activeOpen.startedAt / 1000 - 60)
        .sort((a, b) => b.created_at - a.created_at)[0];

    if (ch?.is_ready) {
      setActiveOpen(null);
      setOpenChannelLoading(false);
    } else if (ch && ch.state === ChannelState.Closed) {
      setActiveOpen(null);
      setOpenChannelLoading(false);
      setOpenChannelError("Channel was closed before becoming ready.");
    }
  }, [snapshot, activeOpen]);

  // --- Auto run dry-run route check once channel is ready ------------------
  useEffect(() => {
    if (!node || !snapshot) return;
    if (!snapshot.relayPubkey || !snapshot.readyChannelToRelay) return;
    const key = `${snapshot.relayPubkey}:${snapshot.readyChannelToRelay.channel_id}`;
    if (lastRouteCheckKeyRef.current === key) return;
    lastRouteCheckKeyRef.current = key;
    void checkRoute(snapshot.relayPubkey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, snapshot?.relayPubkey, snapshot?.readyChannelToRelay?.channel_id]);

  // --- Derived: onboarding step --------------------------------------------
  const requiredCkb = useMemo(() => {
    const v = parseFloat(fundingAmount);
    return Number.isFinite(v) ? v + 1 : 1001;
  }, [fundingAmount]);

  const walletDone =
    !!snapshot &&
    (snapshot.externalFunding ||
      (snapshot.balanceNumber !== null && snapshot.balanceNumber >= requiredCkb));
  const peerDone = !!snapshot?.isPeerConnected;
  const channelDone = !!snapshot?.readyChannelToRelay;
  const routeDone = routeStatus === "has-route";

  let activeStep: 1 | 2 | 3 | 4 | 5 = 1;
  if (!walletDone) activeStep = 1;
  else if (!peerDone) activeStep = 2;
  else if (!channelDone) activeStep = 3;
  else if (!routeDone) activeStep = 4;
  else activeStep = 5;

  // --- Actions --------------------------------------------------------------

  async function runConnectRelay() {
    if (!node) return;
    setPeerActionLoading(true);
    setPeerError(null);
    try {
      await node.connectPeer({ address: DEFAULT_PEER_ADDRESS });
      // refresh snapshot to confirm
      await refreshFnRef.current?.();
    } catch (e) {
      setPeerError(e instanceof Error ? e.message : String(e));
    } finally {
      setPeerActionLoading(false);
    }
  }

  async function checkRoute(targetPubkey: string) {
    if (!node) return;
    setRouteStatus("checking");
    setRouteError(null);
    try {
      const result = await node.sendPayment({
        target_pubkey: targetPubkey as `0x${string}`,
        amount: "0x1",
        keysend: true,
        dry_run: true,
      });
      if (result.status === "Failed") {
        setRouteStatus("no-route");
      } else {
        setRouteStatus("has-route");
      }
    } catch (e) {
      setRouteStatus("no-route");
      setRouteError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenChannel() {
    if (!node || !snapshot) return;
    if (!snapshot.relayPubkey && !snapshot.isPeerConnected) {
      setOpenChannelError("Connect to the relay peer first.");
      return;
    }
    setOpenChannelError(null);
    setOpenChannelLoading(true);

    try {
      // Ensure peer is connected and we have its pubkey
      let pubkey = snapshot.relayPubkey;
      if (!pubkey) {
        await node.connectPeer({ address: DEFAULT_PEER_ADDRESS });
        const peers = await node.listPeers();
        pubkey = peers.peers.find((p) => p.address.includes(DEFAULT_PEER_ID))?.pubkey ?? null;
        if (!pubkey) {
          setOpenChannelError("Connected, but could not resolve relay pubkey. Try again.");
          setOpenChannelLoading(false);
          return;
        }
      }

      const result = await node.openChannel({
        pubkey: pubkey as `0x${string}`,
        funding_amount: ckbToShannons(fundingAmount.trim()),
        public: true,
      });

      setActiveOpen({
        tempChannelId: result.temporary_channel_id,
        pubkey,
        startedAt: Date.now(),
      });

      // Trigger immediate snapshot refresh so the UI updates ASAP
      void refreshFnRef.current?.();
    } catch (e) {
      setOpenChannelError(e instanceof Error ? e.message : String(e));
      setOpenChannelLoading(false);
    }
  }

  async function handleDisconnect() {
    await onDisconnect();
    setShowDropdown(false);
  }

  // --- Channel-in-progress derived state -----------------------------------
  const channelInProgress = useMemo(() => {
    if (!snapshot) return null;
    if (snapshot.readyChannelToRelay) return null;
    // Pick the most recent non-closed channel toward relay.
    const candidate = snapshot.channelsToRelay
      .slice()
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!candidate) return null;
    return candidate;
  }, [snapshot]);

  // --- Render: trigger button ----------------------------------------------
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

  const hasError = !!error;

  // --- Render dropdown contents --------------------------------------------
  function renderHeader() {
    if (!snapshot && snapshotLoading) {
      return (
        <div className="flex items-center gap-2 py-2 text-xs text-[var(--text-secondary)]">
          <svg className="h-3 w-3 animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Loading node info…
        </div>
      );
    }
    if (snapshotError && !snapshot) {
      return (
        <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-2 py-1.5 text-xs text-[var(--error)]">
          {snapshotError}
        </div>
      );
    }
    if (!snapshot) return null;

    return (
      <div>
        <InfoRow label="Pubkey" value={snapshot.pubkey} copyable />
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 text-center">
            <div className="text-[10px] text-[var(--text-tertiary)]">Peers</div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">{snapshot.peerCount}</div>
          </div>
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 text-center">
            <div className="text-[10px] text-[var(--text-tertiary)]">Channels</div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">{snapshot.channels.length}</div>
          </div>
        </div>
      </div>
    );
  }

  function renderWalletStep() {
    const status: StepStatus = walletDone ? "done" : activeStep === 1 ? "active" : "pending";
    const expanded = status !== "done" || (snapshot?.ckbAddress && activeStep <= 2);

    return (
      <div className="space-y-2">
        <StepHeader
          index={1}
          title="Fund your wallet"
          status={status}
          hint={
            snapshot?.externalFunding
              ? "External funding mode"
              : snapshot?.balanceCkb !== null && snapshot?.balanceCkb !== undefined
              ? `Balance: ${snapshot.balanceCkb} CKB`
              : undefined
          }
        />
        {expanded && snapshot && !snapshot.externalFunding && snapshot.ckbAddress && (
          <div className="ml-7 space-y-2">
            <div className="flex flex-col items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2">
              <QRCodeSVG
                value={snapshot.ckbAddress}
                size={120}
                bgColor="transparent"
                fgColor="currentColor"
                className="text-[var(--text-primary)]"
              />
              <span className="text-[10px] text-[var(--text-tertiary)]">Scan to deposit testnet CKB</span>
              <div className="mt-1 flex w-full items-center justify-between gap-2 border-t border-[var(--border-default)] px-1 pt-2">
                <button
                  onClick={() => snapshot.ckbAddress && copyToClipboard(snapshot.ckbAddress)}
                  className="font-mono text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  title={snapshot.ckbAddress}
                >
                  {truncateMiddle(snapshot.ckbAddress, 8, 6)}
                </button>
                <span className="font-mono text-xs font-medium text-[var(--text-primary)]">
                  {snapshot.balanceCkb ?? "—"} CKB
                </span>
              </div>
            </div>
            {!walletDone && (
              <a
                href={FAUCET_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-lg border border-[var(--accent)]/35 bg-[var(--accent)]/12 px-3 py-2 text-xs font-medium text-[var(--accent)] transition-micro hover:bg-[var(--accent)]/20"
              >
                <span>Get testnet CKB from faucet</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7" />
                  <polyline points="7 7 17 7 17 17" />
                </svg>
              </a>
            )}
            {!walletDone && (
              <p className="text-[10px] leading-relaxed text-[var(--text-tertiary)]">
                Need at least <span className="font-mono">{requiredCkb}</span> CKB
                (channel funding + tx fee). After receiving, balance refreshes automatically.
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderPeerStep() {
    const status: StepStatus = peerDone ? "done" : activeStep === 2 ? "active" : "pending";

    return (
      <div className="space-y-2">
        <StepHeader
          index={2}
          title="Connect to relay peer"
          status={status}
          hint={peerDone ? "Connected to bottle.fiber.channel" : "Required for routing payments"}
        />
        {status === "active" && (
          <div className="ml-7 space-y-2">
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[10px] text-[var(--text-tertiary)] break-all">
              {DEFAULT_PEER_ADDRESS}
            </div>
            {peerError && (
              <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-2 py-1.5 text-xs text-[var(--error)]">
                {peerError}
              </div>
            )}
            <button
              onClick={runConnectRelay}
              disabled={peerActionLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--bg-primary)] transition-micro hover:bg-[var(--accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {peerActionLoading ? (
                <>
                  <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Connecting…
                </>
              ) : (
                "Connect peer"
              )}
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderChannelStep() {
    const status: StepStatus = channelDone ? "done" : activeStep === 3 ? "active" : "pending";
    const elapsed = activeOpen ? formatElapsed(now - activeOpen.startedAt) : null;

    let stateLabel: string | null = null;
    if (channelInProgress) {
      stateLabel = CHANNEL_STATE_LABELS[channelInProgress.state] || channelInProgress.state;
    } else if (activeOpen) {
      stateLabel = "Negotiating funding";
    }

    return (
      <div className="space-y-2">
        <StepHeader
          index={3}
          title="Open a payment channel"
          status={status}
          hint={
            channelDone
              ? `Funding: locked on-chain`
              : channelInProgress
              ? `In progress · ${stateLabel}`
              : "Required to route payments"
          }
        />
        {(status === "active" || (status === "done" && false)) && (
          <div className="ml-7 space-y-2">
            {!channelInProgress && !activeOpen && (
              <>
                <label className="block text-[10px] text-[var(--text-tertiary)]">Funding amount (CKB)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={fundingAmount}
                    onChange={(e) => setFundingAmount(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-dim)]"
                  />
                  <button
                    onClick={handleOpenChannel}
                    disabled={
                      openChannelLoading ||
                      !peerDone ||
                      !walletDone ||
                      !fundingAmount.trim()
                    }
                    className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--bg-primary)] transition-micro hover:bg-[var(--accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {openChannelLoading ? "Opening…" : "Open channel"}
                  </button>
                </div>
                {!peerDone && (
                  <p className="text-[10px] text-[var(--text-tertiary)]">
                    Connect to peer first.
                  </p>
                )}
                {peerDone && !walletDone && (
                  <p className="text-[10px] text-[var(--warning)]">
                    Insufficient balance. Need at least {requiredCkb} CKB.
                  </p>
                )}
                {openChannelError && (
                  <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/10 px-2 py-1.5 text-xs text-[var(--error)]">
                    {openChannelError}
                  </div>
                )}
              </>
            )}

            {(channelInProgress || activeOpen) && (
              <div className="space-y-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/8 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <svg className="h-3 w-3 animate-spin text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    <span className="text-xs text-[var(--text-primary)]">{stateLabel}</span>
                  </div>
                  {elapsed && (
                    <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                      {elapsed}
                    </span>
                  )}
                </div>
                <p className="text-[10px] leading-relaxed text-[var(--text-tertiary)]">
                  Funding tx must confirm on-chain. This typically takes a couple of minutes
                  on testnet — keep this tab open.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderRouteStep() {
    const status: StepStatus = routeDone ? "done" : activeStep === 4 ? "active" : "pending";
    const hint =
      routeStatus === "checking"
        ? "Checking…"
        : routeStatus === "has-route"
        ? "Payments enabled"
        : routeStatus === "no-route"
        ? "Route not yet available"
        : undefined;

    return (
      <div className="space-y-2">
        <StepHeader index={4} title="Verify payment route" status={status} hint={hint} />
        {status === "active" && (
          <div className="ml-7 space-y-2">
            {routeStatus === "checking" && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Probing route to relay…
              </div>
            )}
            {routeStatus === "no-route" && (
              <div className="space-y-2">
                <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-2 py-1.5 text-xs text-[var(--warning)]">
                  No route yet. Channel may need a few more confirmations.
                </div>
                {routeError && (
                  <div className="font-mono text-[10px] text-[var(--text-tertiary)] break-words">
                    {routeError}
                  </div>
                )}
                <button
                  onClick={() => snapshot?.relayPubkey && checkRoute(snapshot.relayPubkey)}
                  className="rounded-lg border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] transition-micro hover:bg-[var(--accent-subtle)]"
                >
                  Retry check
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderReadyBanner() {
    if (activeStep !== 5) return null;
    return (
      <div className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 px-3 py-2 text-xs text-[var(--success)]">
        <div className="flex items-center gap-1.5 font-medium">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Ready to make payments
        </div>
      </div>
    );
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
            <div className="absolute right-0 top-full mt-2 w-96 max-h-[80vh] overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 shadow-lg animate-in fade-in zoom-in-95">
              {renderHeader()}

              <div className="my-3 border-t border-[var(--border-default)]" />

              {renderReadyBanner()}

              <div className={`space-y-4 ${activeStep === 5 ? "mt-3" : ""}`}>
                {renderWalletStep()}
                {renderPeerStep()}
                {renderChannelStep()}
                {renderRouteStep()}
              </div>

              <div className="mt-4 border-t border-[var(--border-default)] pt-3">
                <button
                  onClick={handleDisconnect}
                  className="group flex w-full items-center justify-between rounded-lg border border-[var(--border-strong)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left text-sm font-semibold text-[var(--text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_0_rgba(0,0,0,0.45),0_10px_20px_rgba(0,0,0,0.25)] transition-micro hover:bg-[var(--bg-tertiary)] hover:translate-y-[1px] active:translate-y-[2px]"
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
