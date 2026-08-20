# Reverse Skill route map

The TS module implements a compact, OMK-native route map adapted from `zhaoxuya520/reverse-skill` (MIT) without copying its global-injection behavior or vendoring tool-specific submodules.

| Route ID | Primary path | Typical signals | Tool hints | MCP / hooks |
|---|---|---|---|---|
| `apk-reverse` | `skills/apk-reverse/SKILL.md` | APK, Android, smali, Frida, SSL pinning | jadx, apktool, adb, frida | filesystem, idapro if `.so`; pre-shell-guard, protect-secrets |
| `ida-reverse` | `skills/ida-reverse/SKILL.md` | exe, dll, elf, `.so`, xref, pseudocode | idapro, idalib-mcp, ghidra, radare2 | idapro, filesystem; stop-verify |
| `radare2` | `skills/radare2/SKILL.md` | CLI recon, strings, imports, offsets | radare2, rabin2, rasm2, radiff2 | filesystem; pre-shell-guard |
| `js-reverse` | `skills/js-reverse/SKILL.md` | frontend signature, encrypted params, replay | node, playwright, jshookmcp | chrome-devtools, playwright, fetch; session-context |
| `browser-automation` | `skills/browser-automation/SKILL.md` | open page, screenshot, capture network | playwright, chrome, agent-browser | playwright, chrome-devtools |
| `gitreverse` | `skills/gitreverse/SKILL.md` | github repo, vibe code, repo → one prompt | git, gh | github, filesystem; protect-secrets, stop-verify |
| `ctf-sandbox-orchestrator` | `../CTF-Sandbox-Orchestrator/ctf-sandbox-orchestrator/SKILL.md` | CTF, challenge, flag, pwn | python, gdb, pwntools, z3 | filesystem, memory; stop-verify |
| `api-security` | `skills/api-security/SKILL.md` | REST, GraphQL, JWT, IDOR/BOLA | burp, nuclei, zap | filesystem, github, playwright; protect-secrets |
| `supply-chain-security` | `skills/supply-chain-security/SKILL.md` | SBOM, CI/CD, lockfiles, secrets | trivy, syft, gitleaks, osv-scanner | filesystem, github; npm-audit-summary |
| `docs-generator` | `skills/docs-generator/SKILL.md` | report, writeup, diagram | markdown, mermaid, graphviz | filesystem; protect-secrets |

Scoring is deterministic: target matches weight 4, intent 3, toolchain 2, keywords 1, with a triad bonus when all three dimensions match.
