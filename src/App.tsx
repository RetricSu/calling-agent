import { useState } from "react";
import { useFiberNode } from "@fiber-pay/react";
import { Fiber } from "@nervosnetwork/fiber-js";
import { Header } from "./components/Header";
import { Chat } from "./components/Chat";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8402/";

function App() {
  const {
    state,
    node,
    nodeInfo,
    error,
    isPasskeySupported,
    passkeyUnavailableReason,
    hasPasskeyConfigured,
    createPasskeyAndStart,
    startWithPasskey,
    stop,
  } = useFiberNode({
    network: "testnet",
    wasmFactory: () => new Fiber(),
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [agentUrl, setAgentUrl] = useState(DEFAULT_AGENT_URL);
  const [chatKey, setChatKey] = useState(0);

  const isStarting = isConnecting || state === "starting" || state === "unlocking";
  const isRunning = state === "running";

  async function handleRegisterPasskey() {
    setIsConnecting(true);
    try {
      await createPasskeyAndStart("User");
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleConnectPasskey() {
    setIsConnecting(true);
    try {
      await startWithPasskey();
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleDisconnect() {
    await stop();
  }

  function handleAgentUrlChange(url: string) {
    setAgentUrl(url);
    setChatKey((k) => k + 1);
  }

  return (
    <div className="flex min-h-svh flex-col bg-[var(--bg-primary)]">
      <Header
        node={node}
        nodeInfo={nodeInfo}
        error={error}
        isPasskeySupported={isPasskeySupported}
        passkeyUnavailableReason={passkeyUnavailableReason}
        hasPasskeyConfigured={hasPasskeyConfigured}
        isStarting={isStarting}
        isRunning={isRunning}
        agentUrl={agentUrl}
        onAgentUrlChange={handleAgentUrlChange}
        onRegisterPasskey={handleRegisterPasskey}
        onConnectPasskey={handleConnectPasskey}
        onDisconnect={handleDisconnect}
      />
      <main className="flex flex-1 flex-col">
        <Chat key={chatKey} node={node} agentUrl={agentUrl} />
      </main>
    </div>
  );
}

export default App;
