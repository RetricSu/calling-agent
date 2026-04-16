import { useState } from "react";
import { useFiberNode } from "@fiber-pay/react";
import { Header } from "./components/Header";
import { Chat } from "./components/Chat";

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
  });
  const [isConnecting, setIsConnecting] = useState(false);

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
        onRegisterPasskey={handleRegisterPasskey}
        onConnectPasskey={handleConnectPasskey}
        onDisconnect={handleDisconnect}
      />
      <main className="flex flex-1 flex-col">
        <Chat node={node} />
      </main>
    </div>
  );
}

export default App;
