import { useState, useRef, useEffect } from "react";
import type { FiberBrowserNode } from "@fiber-pay/sdk/browser";

type Message = {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
};

const STORAGE_KEY = "agentSessionId";

const quickActions = [
  "Build a landing page for my project",
  "Debug this TypeScript error",
  "Write a product announcement tweet",
];

interface ChatProps {
  node: FiberBrowserNode | null;
  agentUrl: string;
}

async function callAgent(
  url: string,
  prompt: string,
  sessionId: string,
  node: FiberBrowserNode,
  onStatus: (text: string) => void
): Promise<{ response: string; agent?: string; durationMs?: number }> {
  const initial = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, sessionId }),
  });

  if (initial.ok) {
    return await initial.json();
  }

  if (initial.status === 402) {
    const challenge = await initial.json();
    const macaroon = challenge.macaroon as string;
    const invoice = challenge.invoice as string;

    onStatus("Paying L402 invoice via Fiber...");
    const payment = await node.sendPayment({ invoice });

    onStatus("Waiting for payment confirmation...");
    const result = await node.waitForPayment(payment.payment_hash, {
      timeout: 120_000,
      interval: 2000,
    });

    if (result.status !== "Success") {
      throw new Error(`Payment failed: ${result.status}`);
    }

    onStatus("Agent is executing...");
    const retry = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `L402 ${macaroon}`,
        "X-L402-Payment-Hash": payment.payment_hash,
      },
      body: JSON.stringify({ prompt, sessionId }),
    });

    if (!retry.ok) {
      throw new Error(`Agent request failed after payment: ${retry.status}`);
    }

    return await retry.json();
  }

  throw new Error(`Agent request failed: ${initial.status}`);
}

function formatAgentContent(content: string) {
  const parts: { type: "text" | "tag" | "thinking" | "tool"; value: string }[] = [];
  const tagRegex = /\[(client|thinking|done|tool)\b([^\]]*)\]/g;
  const tags: { index: number; kind: string; header: string }[] = [];

  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(content)) !== null) {
    tags.push({
      index: m.index,
      kind: m[1],
      header: `[${m[1]}${m[2] ? ` ${m[2]}` : ""}]`,
    });
  }

  let lastEnd = 0;
  for (let i = 0; i < tags.length; i++) {
    const before = content.slice(lastEnd, tags[i].index).trim();
    if (before) {
      parts.push({ type: "text", value: before });
    }

    const start = tags[i].index;
    const end = tags[i + 1] ? tags[i + 1].index : content.length;
    const body = content.slice(start + tags[i].header.length, end).trim();
    const value = tags[i].header + (body ? `\n${body}` : "");

    if (tags[i].kind === "thinking") {
      parts.push({ type: "thinking", value: "Thinking" });
      if (body) parts.push({ type: "text", value: body });
    } else if (tags[i].kind === "tool") {
      parts.push({ type: "tool", value });
    } else if (tags[i].kind === "client") {
      parts.push({ type: "tag", value });
    } else if (tags[i].kind !== "done") {
      parts.push({ type: "tag", value });
    }

    lastEnd = end;
  }

  const after = content.slice(lastEnd).trim();
  if (after) {
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

export function Chat({ node, agentUrl }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(() => {
    if (typeof window === "undefined") return "";
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  function startNewChat() {
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    setSessionId(id);
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

      const result = await callAgent(agentUrl, content, sessionId, node, (status) => {
        setStatusLabel(status);
      });

      const agentMsg: Message = {
        id: crypto.randomUUID(),
        role: "agent",
        content: result.response,
      };
      setMessages((prev) => [...prev, agentMsg]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Failed to call agent: ${message}`,
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
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-6">
      <div className="flex w-full max-w-[900px] flex-1 flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-lg)]">
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
                A crowdsourced agent marketplace. Connect to any hosted service, pay over L402, and get work done. No platform lock-in.
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
                    className={`max-w-[80%] rounded-2xl px-5 py-3 text-[15px] leading-relaxed sm:max-w-[70%] ${bubbleClasses[msg.role]}`}
                  >
                    {msg.role === "agent" ? (
                      <div className="flex flex-col gap-2">
                        {formatAgentContent(msg.content).map((part, idx) => {
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
                          return <p key={idx} className="whitespace-pre-wrap">{part.value}</p>;
                        })}
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
              Session: {sessionId.slice(0, 8)}…
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
    </div>
  );
}
