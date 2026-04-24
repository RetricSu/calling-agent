import { useState, useRef, useEffect, useMemo } from "react";
import type { FiberBrowserNode } from "@fiber-pay/sdk/browser";

type Message = {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  stderr?: string;
  stderrFirst?: boolean;
};

type SessionState = { id: string; token: string } | null;

const SESSION_STORAGE_KEY = "agentSession";

class SessionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
// Testnet trampoline node pubkey used to delegate payment routing calculations.
// Browser nodes typically lack the full network graph and compute, so using a well-connected 
// trampoline hop significantly improves the success rate of finding a payment path.
const DEFAULT_TRAMPOLINE_HOP =
  "0x02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";

const quickActions = [
  "Write a python script to fetch CKB price and generate a 24h trend chart",
  "Read the Fiber documentation and run test scripts to verify it",
  "Use the @ckb-ccc/ccc library to write a simple CKB DApp",
];

type WorkspaceListEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | string;
  sizeBytes?: number;
  mtimeEpochSeconds?: number;
};

type WorkspaceListResponse = {
  sessionId: string;
  path: string;
  entries: WorkspaceListEntry[];
  truncated: boolean;
  limit: number;
  code?: string;
  error?: string;
};

interface ChatProps {
  node: FiberBrowserNode | null;
  agentUrl: string;
}

type AgentResponse = {
  response: string;
  stderr?: string;
  agent?: string;
  durationMs?: number;
  transport: "sse" | "json";
  session?: { id: string; token: string; created: boolean };
  chunkCount?: number;
  stdoutChunkCount?: number;
  stderrChunkCount?: number;
};

type StreamChunk = {
  type: "stdout" | "stderr";
  text: string;
};

function getAgentRequestInit(
  prompt: string,
  session: SessionState,
  extraHeaders?: Record<string, string>
): RequestInit {
  const body: Record<string, unknown> = { prompt, format: "json", stream: "sse" };
  if (session) {
    body.sessionId = session.id;
    body.sessionToken = session.token;
  }
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

async function readSseResponse(
  response: Response,
  onChunk: (chunk: StreamChunk) => void | Promise<void>,
  onStatus: (text: string) => void
): Promise<AgentResponse> {
  if (!response.body) {
    throw new Error("Agent stream is not readable");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let output = "";
  let stderrOutput = "";
  let stdoutChunkCount = 0;
  let stderrChunkCount = 0;
  let sawDone = false;
  let doneMeta: { agent?: string; durationMs?: number; session?: { id: string; token: string; created: boolean } } = {};

  onStatus("SSE connected, waiting for chunks...");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      if (!frame.trim()) continue;

      const lines = frame.split(/\r?\n/);
      let event = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length === 0) continue;

      const dataRaw = dataLines.join("\n");
      let payload: unknown;

      try {
        payload = JSON.parse(dataRaw);
      } catch {
        continue;
      }

      if (event === "chunk") {
        const chunkTypeRaw =
          typeof payload === "object" &&
          payload !== null &&
          "type" in payload &&
          typeof (payload as { type?: unknown }).type === "string"
            ? (payload as { type: string }).type
            : "stdout";
        const chunkType: "stdout" | "stderr" =
          chunkTypeRaw === "stderr" ? "stderr" : "stdout";

        const text =
          typeof payload === "object" &&
          payload !== null &&
          "text" in payload &&
          typeof (payload as { text?: unknown }).text === "string"
            ? (payload as { text: string }).text
            : "";

        if (text) {
          if (chunkType === "stderr") {
            stderrOutput += text;
            stderrChunkCount += 1;
          } else {
            output += text;
            stdoutChunkCount += 1;
          }

          await onChunk({ type: chunkType, text });
          onStatus(
            chunkType === "stderr"
              ? "Agent is streaming (with warnings)..."
              : "Agent is streaming..."
          );
        }
      } else if (event === "done") {
        const meta =
          typeof payload === "object" && payload !== null
            ? (payload as { agent?: unknown; durationMs?: unknown; session?: unknown })
            : {};
        const rawSession = meta.session;
        const sessionInfo =
          typeof rawSession === "object" &&
          rawSession !== null &&
          "id" in rawSession &&
          "token" in rawSession
            ? {
                id: String((rawSession as { id: unknown }).id),
                token: String((rawSession as { token: unknown }).token),
                created: !!(rawSession as { created?: unknown }).created,
              }
            : undefined;
        doneMeta = {
          agent: typeof meta.agent === "string" ? meta.agent : undefined,
          durationMs:
            typeof meta.durationMs === "number" ? meta.durationMs : undefined,
          session: sessionInfo,
        };
        sawDone = true;
      } else if (event === "error") {
        const errPayload =
          typeof payload === "object" && payload !== null
            ? (payload as { message?: unknown; code?: unknown; session?: unknown })
            : {};
        const message =
          typeof errPayload.message === "string"
            ? errPayload.message
            : "Agent execution failed";
        const code =
          typeof errPayload.code === "string" ? errPayload.code : "";
        if (code.startsWith("SESSION_")) {
          throw new SessionError(code, message);
        }
        throw new Error(message);
      }
    }
  }

  if (!sawDone) {
    throw new Error("Agent stream ended unexpectedly before done event");
  }

  return {
    response: output,
    stderr: stderrOutput || undefined,
    agent: doneMeta.agent,
    durationMs: doneMeta.durationMs,
    session: doneMeta.session,
    transport: "sse",
    chunkCount: stdoutChunkCount + stderrChunkCount,
    stdoutChunkCount,
    stderrChunkCount,
  };
}

async function parseAgentResponse(
  response: Response,
  onChunk: (chunk: StreamChunk) => void | Promise<void>,
  onStatus: (text: string) => void
): Promise<AgentResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return await readSseResponse(response, onChunk, onStatus);
  }

  onStatus("Server returned JSON fallback");
  const json = (await response.json()) as Record<string, unknown>;
  const rawSession = json.session;
  const sessionInfo =
    typeof rawSession === "object" &&
    rawSession !== null &&
    "id" in rawSession &&
    "token" in rawSession
      ? {
          id: String((rawSession as { id: unknown }).id),
          token: String((rawSession as { token: unknown }).token),
          created: !!(rawSession as { created?: unknown }).created,
        }
      : undefined;
  return {
    response: typeof json.response === "string" ? json.response : "",
    stderr: typeof json.stderr === "string" ? json.stderr : undefined,
    agent: typeof json.agent === "string" ? json.agent : undefined,
    durationMs: typeof json.durationMs === "number" ? json.durationMs : undefined,
    session: sessionInfo,
    transport: "json",
  };
}

async function callAgent(
  url: string,
  prompt: string,
  session: SessionState,
  node: FiberBrowserNode,
  onStatus: (text: string) => void,
  onChunk: (chunk: StreamChunk) => void | Promise<void>
): Promise<AgentResponse> {
  const initial = await fetch(url, getAgentRequestInit(prompt, session));

  if (initial.ok) {
    return await parseAgentResponse(initial, onChunk, onStatus);
  }

  // Handle session contract errors (400 / 403)
  if (initial.status === 400 || initial.status === 403) {
    const errBody = await initial.json().catch(() => ({} as Record<string, unknown>));
    const code = typeof errBody?.code === "string" ? errBody.code : "";
    if (code.startsWith("SESSION_")) {
      throw new SessionError(code, typeof errBody?.message === "string" ? errBody.message : "Session error");
    }
  }

  if (initial.status === 402) {
    const challenge = await initial.json();
    const macaroon = challenge.macaroon as string;
    const invoice = challenge.invoice as string;

    onStatus("Paying L402 invoice via Fiber...");
    const payment = await node.sendPayment({
      invoice,
      trampoline_hops: [DEFAULT_TRAMPOLINE_HOP],
    });

    onStatus("Waiting for payment confirmation...");
    const result = await node.waitForPayment(payment.payment_hash, {
      timeout: 120_000,
      interval: 2000,
    });

    if (result.status !== "Success") {
      throw new Error(`Payment failed: ${result.status}`);
    }

    onStatus("Agent is executing...");
    const retry = await fetch(
      url,
      getAgentRequestInit(prompt, session, {
        Authorization: `L402 ${macaroon}`,
        "X-L402-Payment-Hash": payment.payment_hash,
      })
    );

    if (!retry.ok) {
      throw new Error(`Agent request failed after payment: ${retry.status}`);
    }

    return await parseAgentResponse(retry, onChunk, onStatus);
  }

  throw new Error(`Agent request failed: ${initial.status}`);
}

function formatAgentContent(content: string) {
  // Remove protocol-like completion lines and their surrounding newlines to prevent artificial gaps.
  const sanitized = content
    .replace(/(?:^|\r?\n)[ \t]*\[done\][ \t]*end_turn[ \t]*(?:\r?\n|$)/gi, "")
    .replace(/(?:^|\r?\n)[ \t]*end_turn[ \t]*(?:\r?\n|$)/gi, "");

  const parts: { type: "text" | "tag" | "thinking" | "tool"; value: string }[] = [];
  const tagRegex = /\[(client|thinking|done|tool)\b([^\]]*)\]/g;
  const tags: { index: number; kind: string; header: string }[] = [];

  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(sanitized)) !== null) {
    tags.push({
      index: m.index,
      kind: m[1],
      header: `[${m[1]}${m[2] ? ` ${m[2]}` : ""}]`,
    });
  }

  let lastEnd = 0;
  for (let i = 0; i < tags.length; i++) {
    const before = sanitized.slice(lastEnd, tags[i].index);
    if (before.length > 0) {
      parts.push({ type: "text", value: before });
    }

    const start = tags[i].index;
    const end = tags[i + 1] ? tags[i + 1].index : sanitized.length;
    const rawBody = sanitized.slice(start + tags[i].header.length, end);
    const body = rawBody.trim();
    const value = tags[i].header + (body ? `\n${body}` : "");

    if (tags[i].kind === "thinking") {
      parts.push({ type: "thinking", value: "Thinking" });
      if (rawBody.length > 0) parts.push({ type: "text", value: rawBody });
    } else if (tags[i].kind === "tool") {
      parts.push({ type: "tool", value });
    } else if (tags[i].kind === "client") {
      parts.push({ type: "tag", value });
    } else if (tags[i].kind !== "done") {
      parts.push({ type: "tag", value });
    }

    lastEnd = end;
  }

  const after = sanitized.slice(lastEnd);
  if (after.length > 0) {
    parts.push({ type: "text", value: after });
  }

  return parts.filter((p) => !(p.type === "text" && p.value === "end_turn"));
}

function ToolBlock({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const label = value.slice(0, 60) + (value.length > 60 ? "…" : "");

  return (
    <button
      onClick={() => setExpanded((e) => !e)}
      className="inline-flex w-fit flex-col gap-1 rounded-md border border-[var(--border-default)]/50 bg-[var(--bg-secondary)]/50 px-2 py-1 text-left transition-micro hover:bg-[var(--bg-secondary)]"
    >
      <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
          <line x1="9" y1="9" x2="15" y2="15" />
          <line x1="15" y1="9" x2="9" y2="15" />
        </svg>
        {expanded ? "Hide tool" : "Tool call"}
      </span>
      <span className={`whitespace-pre-wrap font-mono text-[10px] text-[var(--text-muted)] ${expanded ? "max-h-48 overflow-y-auto" : "line-clamp-1"}`}>
        {expanded ? value : label}
      </span>
    </button>
  );
}

function normalizeArtifactDirectoryPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";

  const stripped = trimmed.replace(/^\/+/, "");
  const withoutQuery = stripped.split("?")[0].split("#")[0];
  const segments = withoutQuery.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}

function buildWorkspaceStaticUrl(
  agentUrl: string,
  path: string
) {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return new URL(`/workspace/static/${encodedPath}`, agentUrl).toString();
}

function buildWorkspaceListUrl(agentUrl: string, path: string) {
  const url = new URL("/workspace/static/list", agentUrl);
  if (path) {
    url.searchParams.set("path", path);
  }
  return url.toString();
}

function isTextLikePreview(contentType: string, filePath: string) {
  if (contentType.startsWith("text/") && !contentType.includes("text/html")) {
    return true;
  }

  if (
    contentType.includes("application/json") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/x-yaml")
  ) {
    return true;
  }

  return /\.(txt|log|md|json|yaml|yml|toml|ini|csv|tsv|env|py|ts|tsx|js|jsx|css|html?)$/i.test(
    filePath
  );
}

function isImageLikePreview(contentType: string, filePath: string) {
  if (contentType.startsWith("image/")) {
    return true;
  }

  return /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(filePath);
}

function shouldInvalidateSession(code: unknown, message: unknown) {
  if (typeof code === "string" && code.startsWith("SESSION_")) {
    return true;
  }

  if (typeof message !== "string") {
    return false;
  }

  const normalized = message.toLowerCase();
  return normalized.includes("session token") || normalized.includes("session id");
}

function ArtifactsPanel({
  agentUrl,
  session,
  onSessionInvalid,
}: {
  agentUrl: string;
  session: SessionState;
  onSessionInvalid: () => void;
}) {
  const [activePath, setActivePath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [isImagePreview, setIsImagePreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewRequestSeqRef = useRef(0);
  const [currentDir, setCurrentDir] = useState("");
  const [entries, setEntries] = useState<WorkspaceListEntry[]>([]);
  const [isListing, setIsListing] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const selectedName = useMemo(() => {
    if (!activePath) return null;
    const parts = activePath.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? activePath;
  }, [activePath]);

  const parentDir = useMemo(() => {
    if (!currentDir) return null;
    const segments = currentDir.split("/").filter(Boolean);
    segments.pop();
    return segments.join("/");
  }, [currentDir]);

  useEffect(() => {
    return () => {
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
      }
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  async function refreshDirectory(dirPath: string) {
    if (!session) return;

    const normalizedDir = normalizeArtifactDirectoryPath(dirPath);
    if (normalizedDir === null) {
      setListError("Unable to open this folder.");
      return;
    }

    setIsListing(true);
    setListError(null);
    try {
      const response = await fetch(buildWorkspaceListUrl(agentUrl, normalizedDir), {
        headers: {
          Accept: "application/json",
          "x-session-id": session.id,
          "x-session-token": session.token,
        },
      });

      const payload = (await response.json().catch(() => ({}))) as WorkspaceListResponse;
      if (!response.ok) {
        if (shouldInvalidateSession(payload.code, payload.error)) {
          onSessionInvalid();
          return;
        }
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to list files");
      }

      const safeEntries = Array.isArray(payload.entries)
        ? payload.entries
            .filter((entry) => typeof entry?.name === "string" && typeof entry?.path === "string")
            .sort((left, right) => {
              if (left.type === right.type) {
                return left.name.localeCompare(right.name);
              }
              if (left.type === "dir") return -1;
              if (right.type === "dir") return 1;
              return left.name.localeCompare(right.name);
            })
        : [];

      setCurrentDir(typeof payload.path === "string" ? payload.path : normalizedDir);
      setEntries(safeEntries);
      setIsTruncated(!!payload.truncated);
    } catch (error) {
      setEntries([]);
      setIsTruncated(false);
      setListError(error instanceof Error ? error.message : "Unable to load files.");
    } finally {
      setIsListing(false);
    }
  }

  async function previewFile(filePath: string) {
    if (!session) return;

    const normalized = normalizeArtifactDirectoryPath(filePath);
    if (!normalized) return;

    if (previewAbortRef.current) {
      previewAbortRef.current.abort();
    }
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const requestSeq = ++previewRequestSeqRef.current;

    setIsPreviewLoading(true);
    setPreviewError(null);
    setPreviewText(null);
    setIsImagePreview(false);
    try {
      const response = await fetch(buildWorkspaceStaticUrl(agentUrl, normalized), {
        signal: controller.signal,
        headers: {
          Accept: "*/*",
          "x-session-id": session.id,
          "x-session-token": session.token,
        },
      });

      if (requestSeq !== previewRequestSeqRef.current) {
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
        if (shouldInvalidateSession(payload.code, payload.error)) {
          onSessionInvalid();
          return;
        }
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to load preview");
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (isTextLikePreview(contentType, normalized)) {
        const text = await response.text();
        if (requestSeq !== previewRequestSeqRef.current) {
          return;
        }
        setPreviewUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return null;
        });
        setPreviewText(text);
        setIsImagePreview(false);
        setActivePath(normalized);
        return;
      }

      const blob = await response.blob();
      if (requestSeq !== previewRequestSeqRef.current) {
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      setPreviewUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return objectUrl;
      });
      setPreviewText(null);
      setIsImagePreview(isImageLikePreview(contentType, normalized));
      setActivePath(normalized);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (requestSeq !== previewRequestSeqRef.current) {
        return;
      }
      setPreviewError(error instanceof Error ? error.message : "Unable to load preview.");
    } finally {
      if (requestSeq === previewRequestSeqRef.current) {
        setIsPreviewLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!session) {
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
      }
      previewAbortRef.current = null;
      setActivePath(null);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      setPreviewUrl(null);
      setPreviewText(null);
      setIsImagePreview(false);
      setPreviewError(null);
      setIsPreviewLoading(false);
      setCurrentDir("");
      setEntries([]);
      setIsListing(false);
      setIsTruncated(false);
      setListError(null);
      return;
    }

    if (previewAbortRef.current) {
      previewAbortRef.current.abort();
    }
    previewAbortRef.current = null;
    setPreviewText(null);
    setIsImagePreview(false);
    setPreviewError(null);
    setIsPreviewLoading(false);

    refreshDirectory(currentDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentUrl, session?.id, session?.token]);

  function handleOpenEntry(entry: WorkspaceListEntry) {
    if (entry.type === "dir") {
      refreshDirectory(entry.path);
      return;
    }

    previewFile(entry.path);
  }

  return (
    <aside className="flex min-h-[420px] flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-lg)] lg:sticky lg:top-24 lg:h-[calc(100svh-8.5rem)] lg:min-h-0 lg:max-h-[calc(100svh-8.5rem)]">
      <div className="border-b border-[var(--border-default)] px-4 py-4">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Artifacts
        </p>
        <h2 className="mt-1 text-base font-semibold text-[var(--text-primary)]">
          Workspace files
        </h2>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Click a file to preview.
        </p>
      </div>

      {!session ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center">
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
            Send a message to create a session first.
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)]/70 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="truncate text-[11px] text-[var(--text-secondary)]">
                {currentDir ? `Folder: ${currentDir}` : "Folder: root"}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={parentDir === null}
                  onClick={() => {
                    if (parentDir !== null) refreshDirectory(parentDir);
                  }}
                  className="rounded border border-[var(--border-default)] px-2 py-1 text-[10px] text-[var(--text-secondary)] transition-micro hover:border-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Up
                </button>
                <button
                  type="button"
                  onClick={() => refreshDirectory(currentDir)}
                  className="rounded border border-[var(--border-default)] px-2 py-1 text-[10px] text-[var(--text-secondary)] transition-micro hover:border-[var(--border-strong)]"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="max-h-56 overflow-y-auto rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/50">
              {isListing ? (
                <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">Loading workspace files...</div>
              ) : listError ? (
                <div className="px-3 py-2 text-[11px] text-[var(--error)]">{listError}</div>
              ) : entries.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No files in this directory.</div>
              ) : (
                <ul className="m-0 list-none p-0">
                  {entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() => handleOpenEntry(entry)}
                        className={`flex w-full items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-left text-[11px] transition-micro last:border-b-0 ${
                          entry.type !== "dir" && activePath === entry.path
                            ? "bg-[var(--accent-subtle)] text-[var(--text-primary)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                          {entry.type === "dir" ? "DIR" : "FILE"}
                        </span>
                        <span className="min-w-0 truncate text-[11px]">
                          {entry.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {isTruncated && (
              <p className="mt-2 text-[10px] text-[var(--warning)]">
                Too many files. Open a subfolder to narrow results.
              </p>
            )}
          </div>

          <div className="text-[11px] text-[var(--text-muted)]">
            {selectedName ? `Preview: ${selectedName}` : "Preview: select a file"}
          </div>

          <div className="relative flex-1 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] min-h-[240px] lg:min-h-0">
            {isPreviewLoading ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--text-muted)]">
                Loading preview...
              </div>
            ) : previewError ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--error)]">
                {previewError}
              </div>
            ) : previewText !== null ? (
              <pre className="h-full overflow-auto bg-[var(--bg-secondary)] px-4 py-3 font-mono text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-[var(--text-primary)]">
                {previewText}
              </pre>
            ) : previewUrl && isImagePreview ? (
              <div className="flex h-full w-full items-center justify-center overflow-auto bg-[var(--bg-secondary)]/40 p-3">
                <img
                  src={previewUrl}
                  alt={selectedName ? `Preview image: ${selectedName}` : "Preview image"}
                  className="max-h-full max-w-full rounded-md object-contain shadow-[var(--shadow-md)]"
                  loading="lazy"
                />
              </div>
            ) : previewUrl ? (
              <iframe
                key={`${session.id}:${activePath ?? ""}`}
                src={previewUrl}
                title={`Artifact preview: ${activePath ?? ""}`}
                className="h-full w-full"
                sandbox="allow-scripts"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--text-muted)]">
                Select a file from the workspace list to preview it here.
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

export function Chat({ node, agentUrl }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.id && parsed?.token) return { id: parsed.id, token: parsed.token };
    } catch { /* ignore corrupt data */ }
    return null;
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  function clearPersistedSession() {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSession(null);
  }

  function startNewChat() {
    clearPersistedSession();
    setMessages([]);
    setInput("");
  }

  async function sendMessage(content: string) {
    if (!content.trim()) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);
    setStatusLabel("Agent is reading...");

    let agentMessageId: string | undefined;
    let streamedChunk = false;

    try {
      if (!node) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content:
              "Please connect your Fiber node first to pay the L402 invoice.",
          },
        ]);
        setIsTyping(false);
        setStatusLabel(null);
        return;
      }

      const result = await callAgent(
        agentUrl,
        content,
        session,
        node,
        (status) => {
          setStatusLabel(status);
        },
        (chunk) => {
          streamedChunk = true;
          if (!agentMessageId) {
            const createdAgentMessageId = crypto.randomUUID();
            agentMessageId = createdAgentMessageId;
            setMessages((prev) => [
              ...prev,
              {
                id: createdAgentMessageId,
                role: "agent",
                content: chunk.type === "stdout" ? chunk.text : "",
                stderr: chunk.type === "stderr" ? chunk.text : undefined,
                  stderrFirst: chunk.type === "stderr",
              },
            ]);
            return;
          }

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === agentMessageId
                ? chunk.type === "stderr"
                  ? { ...msg, stderr: (msg.stderr ?? "") + chunk.text }
                  : { ...msg, content: msg.content + chunk.text }
                : msg
            )
          );
        }
      );

      // Persist server-assigned session
      if (result.session) {
        const newSession = { id: result.session.id, token: result.session.token };
        setSession(newSession);
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));
      }

      if (!streamedChunk) {
        if (!result.response.trim() && !(result.stderr && result.stderr.trim())) {
          return;
        }

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "agent",
            content: result.response,
            stderr: result.stderr,
          },
        ]);
      }
    } catch (err) {
      // Auto-clear session on session contract errors
      if (err instanceof SessionError) {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        setSession(null);
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: err instanceof SessionError
            ? `Session error (${err.code}): ${message}. Starting a new session.`
            : `Failed to call agent: ${message}`,
        },
      ]);
    } finally {
      setIsTyping(false);
      setStatusLabel(null);
    }
  }

  const isEmpty = messages.length === 0;

  const bubbleClasses: Record<Message["role"], string> = {
    user: "bg-[var(--accent)] text-[var(--bg-primary)]",
    agent: "border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]",
    system: "border border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]",
  };

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6">
      <div className="flex w-full max-w-[1240px] flex-1 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex min-h-[640px] flex-1 flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-lg)] lg:h-[calc(100svh-8.5rem)] lg:min-h-0">
        <div className="flex-1 overflow-y-auto px-6 py-8">
          {isEmpty ? (
            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-subtle)] text-[var(--accent)]">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
                What would you like me to do?
              </h1>
              <p className="max-w-md text-[var(--text-secondary)]">
                The decentralized AI agent platform. Unbound, fluid compute for CI and automation powered by a global network over L402. No platform lock-in.
              </p>
              <a
                href="https://github.com/RetricSu/fiber-pay/blob/feat/agent-boxlite-sandbox/docs/boxlite-agent-setup.md"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-[var(--accent)] transition-micro hover:text-[var(--accent-dim)] hover:underline"
              >
                Host your own agent →
              </a>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                {quickActions.map((action) => (
                  <button
                    key={action}
                    onClick={() => sendMessage(action)}
                    className="rounded-full border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-micro hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-5 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] sm:max-w-[70%] ${bubbleClasses[msg.role]}`}
                  >
                    {msg.role === "agent" ? (
                      <div className="flex flex-col gap-2">
                        {msg.stderrFirst && msg.stderr && msg.stderr.trim() && (
                          <details className="rounded-lg border border-[var(--border-default)]/60 bg-[var(--bg-secondary)]/30 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-[var(--text-muted)]">
                              stderr logs ({msg.stderr.split(/\r?\n/).filter(Boolean).length} lines)
                            </summary>
                            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--text-muted)]/90">
                              {msg.stderr}
                            </pre>
                          </details>
                        )}
                        {msg.content.trim() &&
                          formatAgentContent(msg.content).map((part, idx) => {
                            if (part.type === "tool") {
                              return <ToolBlock key={idx} value={part.value} />;
                            }
                            if (part.type === "tag") {
                              return (
                                <span
                                  key={idx}
                                  className="inline-block w-fit rounded-md bg-transparent px-2 py-0.5 text-[10px] text-[var(--text-muted)]/60"
                                >
                                  {part.value}
                                </span>
                              );
                            }
                            if (part.type === "thinking") {
                              return (
                                <span
                                  key={idx}
                                  className="inline-block w-fit rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] italic text-[var(--text-secondary)]"
                                >
                                  Thinking...
                                </span>
                              );
                            }
                            return <p key={idx} className="m-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{part.value}</p>;
                          })}
                        {!msg.stderrFirst && msg.stderr && msg.stderr.trim() && (
                          <details className="rounded-lg border border-[var(--border-default)]/60 bg-[var(--bg-secondary)]/30 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-[var(--text-muted)]">
                              stderr logs ({msg.stderr.split(/\r?\n/).filter(Boolean).length} lines)
                            </summary>
                            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--text-muted)]/90">
                              {msg.stderr}
                            </pre>
                          </details>
                        )}
                      </div>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              ))}
              {isTyping && (
                <div className="flex justify-start">
                  <div className="flex flex-col gap-1">
                    {statusLabel && (
                      <span className="text-xs text-[var(--text-tertiary)]">
                        {statusLabel}
                      </span>
                    )}
                    <div className="flex items-center gap-1 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-5 py-3">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--text-tertiary)]"></span>
                      <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--text-tertiary)] [animation-delay:120ms]"></span>
                      <span className="h-2 w-2 animate-bounce rounded-full bg-[var(--text-tertiary)] [animation-delay:240ms]"></span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={scrollRef} />
            </div>
          )}
        </div>

        <div className="border-t border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[10px] text-[var(--text-muted)]">
              {session ? `Session: ${session.id.slice(0, 12)}…` : "New session"}
            </span>
            <button
              onClick={startNewChat}
              className="text-[11px] font-medium text-[var(--text-secondary)] transition-micro hover:text-[var(--accent)]"
            >
              New chat
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            className="flex items-center gap-3"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe the task you want the agent to complete..."
              className="flex-1 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-4 py-3 text-[15px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-micro focus:border-[var(--accent-dim)] focus:ring-1 focus:ring-[var(--accent-glow)]"
            />
            <button
              type="submit"
              disabled={!input.trim() || isTyping}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent)] text-[var(--bg-primary)] shadow-[var(--shadow-sm)] transition-micro hover:bg-[var(--accent-dim)] hover:shadow-[var(--shadow-glow)] disabled:cursor-not-allowed disabled:opacity-50"
            >
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
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
        </div>
        </div>

        <ArtifactsPanel
          agentUrl={agentUrl}
          session={session}
          onSessionInvalid={clearPersistedSession}
        />
      </div>
    </div>
  );
}
