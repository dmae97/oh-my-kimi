import { type JSX } from "solid-js";

import { runTrigger } from "../../state";
import { Events } from "../Events";
import { Logs } from "../Logs";

// Activity (investigate mode). Full history table + full-height log stream.
// Logs finally get real vertical room.
export function Activity(): JSX.Element {
  const handleRetry = (deliveryId: string): void => {
    void runTrigger({ mode: "retry", delivery_id: deliveryId });
  };

  return (
    <>
      <Events onRetry={handleRetry} />
      <Logs />
    </>
  );
}
