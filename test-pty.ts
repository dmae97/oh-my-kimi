import { PtySession } from "@oh-my-pi/pi-natives";

async function testPty(shell: string, command: string, label: string) {
  const session = new PtySession();
  const t0 = Date.now();
  let output = "";

  await new Promise<void>((resolve) => {
    session.start(
      {
        command,
        shell,
        timeoutMs: 5000,
        cols: 80,
        rows: 24,
      },
      (_err, chunk) => {
        if (chunk) output += chunk;
      },
    ).then((result) => {
      const ms = Date.now() - t0;
      // Strip VT sequences for readable output
      const clean = output.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trim();
      console.log(`[${label}] ${ms}ms timedOut=${result.timedOut} exitCode=${result.exitCode} output="${clean}"`);
      resolve();
    }).catch((err) => {
      console.log(`[${label}] ${Date.now() - t0}ms ERROR: ${err.message}`);
      resolve();
    });
    setTimeout(() => { console.log(`[${label}] HUNG`); resolve(); }, 10000);
  });
}

await testPty("cmd.exe", "echo hello from cmd", "cmd");
await testPty("powershell.exe", "Write-Host 'hello from pwsh'", "pwsh");
await testPty("sh", "echo hello from bash", "sh-git-bash");
process.exit(0);
