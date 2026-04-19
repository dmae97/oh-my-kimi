// @ts-nocheck — example file; install @oh-my-pi/pi-coding-agent before running
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function helloExtension(pi: ExtensionAPI) {
  // Log a greeting to the console whenever a session starts.
  pi.on("session_start", async (_event, ctx) => {
    console.log("[hello-extension] session started in", ctx.cwd);
    ctx.ui.notify("Hello from hello-extension!", "info");
  });

  // Register a /hello slash command that sends a greeting into the conversation.
  pi.commands.register("hello", {
    description: "Send a greeting into the conversation",
    handler: async (_args, ctx) => {
      await pi.sendMessage("Hello from my extension!", { triggerTurn: false });
      ctx.ui.notify("Message sent!", "info");
    },
  });
}
