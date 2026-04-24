import type { UseFiberNodeResult } from "@fiber-pay/react";
import { AgentEndpointSelector } from "./AgentEndpointSelector";
import { ConnectButton } from "@fiber-pay/react";

export interface HeaderProps {
  fiber: UseFiberNodeResult;
  agentUrl: string;
  onAgentUrlChange: (url: string) => void;
}

export function Header({
  fiber,
  agentUrl,
  onAgentUrlChange,
}: HeaderProps) {
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
            Water Computer
          </span>
        </div>

        <AgentEndpointSelector value={agentUrl} onChange={onAgentUrlChange} />

        <ConnectButton fiber={fiber} />
      </div>
    </header>
  );
}
