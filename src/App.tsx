import { useState } from "react";
import { useFiberNode } from "@fiber-pay/react";
import { Fiber } from "@nervosnetwork/fiber-js";
import { Header } from "./components/Header";
import { Chat } from "./components/Chat";

const DEFAULT_AGENT_URL = "https://agent.pingkey.xyz/";

function App() {
  const fiber = useFiberNode({
    network: "testnet",
    wasmFactory: () => new Fiber(),
  });
  const { node } = fiber;
  const [agentUrl, setAgentUrl] = useState(DEFAULT_AGENT_URL);
  const [chatKey, setChatKey] = useState(0);

  function handleAgentUrlChange(url: string) {
    setAgentUrl(url);
    setChatKey((k) => k + 1);
  }

  return (
    <div className="flex min-h-svh flex-col bg-[var(--bg-primary)]">
      <Header
        fiber={fiber}
        agentUrl={agentUrl}
        onAgentUrlChange={handleAgentUrlChange}
      />
      <main className="flex flex-1 flex-col">
        <Chat key={chatKey} node={node} agentUrl={agentUrl} />
      </main>
    </div>
  );
}

export default App;
