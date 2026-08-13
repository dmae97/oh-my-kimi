const CMDS = {
  npm: `npm install -g open-multi-agent-kit@0.95.1 --ignore-scripts
omk --version
omk`,
  pnpm: `pnpm add -g open-multi-agent-kit@0.95.1
omk --version
omk`,
  bun: `bun add -g open-multi-agent-kit@0.95.1
omk --version
omk`,
};

const cmdEl = document.getElementById("install-cmd");
const copyBtn = document.getElementById("copy-install");
const tabs = document.querySelectorAll(".install__tabs button");

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) t.classList.remove("is-active");
    tab.classList.add("is-active");
    const key = tab.getAttribute("data-cmd") || "npm";
    if (cmdEl) cmdEl.textContent = CMDS[key] || CMDS.npm;
  });
}

copyBtn?.addEventListener("click", async () => {
  const text = cmdEl?.textContent?.trim() || CMDS.npm;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1200);
  } catch {
    copyBtn.textContent = "Copy failed";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1200);
  }
});
