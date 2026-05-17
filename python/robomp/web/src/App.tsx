import { type JSX, onCleanup, onMount } from "solid-js";

import { Browse } from "./components/Browse";
import { Events } from "./components/Events";
import { Header } from "./components/Header";
import { Issues } from "./components/Issues";
import { Logs } from "./components/Logs";
import { Stats } from "./components/Stats";
import { Trigger } from "./components/Trigger";
import { Working } from "./components/Working";
import { runTrigger, startPolling, stopPolling } from "./state";

export function App(): JSX.Element {
  onMount(() => {
    startPolling();
  });
  onCleanup(() => {
    stopPolling();
  });

  const handleRetry = (deliveryId: string): void => {
    void runTrigger({ mode: "retry", delivery_id: deliveryId });
  };

  return (
    <div class="mx-auto w-full max-w-[1400px]">
      <Header />

      <main class="px-6 lg:px-10 pb-16 flex flex-col gap-5">
        <div class="grid gap-5" style={{ "grid-template-columns": "minmax(0, 1fr)" }}>
          <Trigger />
          <Browse />
        </div>

        <Stats />

        <div class="grid gap-5 grid-cols-1 xl:grid-cols-2">
          <Working />
          <Issues onRetry={handleRetry} />
        </div>

        <Events onRetry={handleRetry} />

        <Logs />

        <footer class="text-center text-[11px] text-ink-500 pt-2 pb-1">
          robomp · self-hosted triage &amp; fix · polling every 3s
        </footer>
      </main>
    </div>
  );
}
