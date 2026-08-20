# Extension Runtime Threat Model

> **Scope**: This document covers every OMK extension. OMK does not currently provide extension permission tiers or an extension-specific OS sandbox.
>
> **Version**: 0.96.1

## 1. Overview

Extensions execute as trusted code inside the OMK process with the host user's permissions. Treat every loaded extension as capable of:

- Read and modify the agent's configuration (`~/.omk/agent/`)
- Intercept and mutate tool calls and their results
- Access session state, including conversation history
- Execute arbitrary code within the extension's context
- Register custom tools that run with the same privileges as built-in tools

This document outlines the threat model for such extensions and provides guidance for users, extension developers, and security auditors.

## 2. Threat Actors

| Actor | Motivation | Capability |
|-------|-----------|------------|
| Malicious Extension Author | Data exfiltration, credential theft, supply-chain compromise | Distributes a seemingly benign extension with hidden malicious logic |
| Compromised Extension Dependency | Indirect compromise via a dependency of a legitimate extension | Injects malicious code into a trusted extension's dependency tree |
| Insider Threat | Espionage, sabotage, unauthorized data access | Installs or modifies an extension on a target's machine |
| User (Self-Inflicted) | Accidental misconfiguration | Loads an untrusted extension without review |

## 3. Attack Scenarios

### 3.1 Configuration Exfiltration

An extension can read `~/.omk/agent/auth.json`, which contains API keys and OAuth tokens for LLM providers.

**Impact**: Credential theft leading to unauthorized LLM API usage, financial loss, or data leakage through the compromised API account.

**Mitigation**:
- Store auth credentials in OS keychain or encrypted vault rather than plaintext `auth.json` where possible.
- Audit extensions before loading them.
- Run the whole OMK process inside an isolated environment when the extension is not fully trusted.

### 3.2 Session Hijacking

A malicious extension can intercept session `.jsonl` files in `~/.omk/agent/sessions/`, extracting conversation history, source code, and proprietary business logic discussed with the agent.

**Impact**: Intellectual property theft, privacy violation, exposure of secrets mentioned in prompts.

**Mitigation**:
- Encrypt session files at rest.
- Use sandboxed session directories per project.
- Review extension code for file-system access patterns.

### 3.3 Tool Call Interception and Mutation

Extensions can wrap built-in tools (e.g., `bash`, `read`, `write`). A malicious wrapper could:
- Log all `bash` commands and their outputs to a remote server.
- Modify `write` tool calls to inject backdoors into source files.
- Block `read` operations on sensitive files to hide evidence of tampering.

**Impact**: Supply-chain compromise, data integrity loss, covert surveillance.

**Mitigation**:
- Use `--no-extensions` to disable discovered third-party extensions when working with highly sensitive codebases.
- Pin extension versions and review diffs on updates.
- Run extensions in an isolated environment (container, VM) where feasible.

### 3.4 Privilege Escalation via Custom Tools

An extension can register new tools that appear in the agent's tool list. These tools execute with the same privileges as the OMK process.

**Impact**: Arbitrary code execution, system compromise if the agent process has elevated privileges.

**Mitigation**:
- Never run OMK as root or with sudo.
- Run the whole OMK process in a container, VM, or other verified OS sandbox when containment is required.
- Review the full source code of any extension before installation.

### 3.5 Telemetry and Data Leakage

Extensions can silently exfiltrate data via DNS queries, HTTP requests, or by writing to shared directories.

**Impact**: Loss of confidentiality for proprietary code, conversation content, and system information.

**Mitigation**:
- Block outbound network access for the OMK process using a firewall or network namespace.
- Monitor DNS and network traffic for anomalies.
- Do not treat `--offline` as a network sandbox; it disables OMK startup network operations, not arbitrary extension traffic.

## 4. Actual Isolation Boundary

OMK does not sandbox extension JavaScript separately. Extension code, extension tools, custom code, and the OMK process run with the host user's permissions.

AgentSession's built-in local bash sandbox wraps only built-in local bash child processes. It does not contain extension callbacks, custom tools, OMK file tools, or the OMK process. For broader isolation, run the whole process inside a container or VM, or route every relevant tool through an isolated backend. See [Containerization](containerization.md).

## 5. Security Checklist for Users

Before installing or upgrading an extension, verify:

- [ ] The extension source code is available and has been reviewed.
- [ ] The extension is from a trusted author or has been audited by a third party.
- [ ] The extension's `package.json` or manifest does not include unexpected dependencies.
- [ ] The extension's network behavior is justified by its functionality.
- [ ] You have a backup of `~/.omk/agent/` (especially `auth.json` and sessions).
- [ ] You have considered running the extension in a sandboxed environment.

## 6. Security Checklist for Extension Developers

When building an extension, adhere to:

- [ ] **Principle of Least Privilege**: Keep the extension's file, process, network, and credential access to the minimum required, even though OMK does not enforce a per-extension tier.
- [ ] **No Credential Access**: Never read `auth.json` or environment variables containing API keys unless the extension's core purpose is authentication management.
- [ ] **Transparent Logging**: Log all file system and network operations to a user-visible location.
- [ ] **Minimal Dependencies**: Keep the dependency tree small to reduce supply-chain risk.
- [ ] **Signed Releases**: Provide cryptographic signatures for extension releases.
- [ ] **Auditable Code**: Avoid obfuscation, minification, or dynamic code evaluation (`eval`, `new Function`).

## 7. Incident Response

If a malicious or compromised extension is suspected:

1. **Immediately revoke** any exposed API keys (check `auth.json` and provider dashboards).
2. **Remove** the extension directory from `~/.omk/agent/extensions/`.
3. **Audit** session files in `~/.omk/agent/sessions/` for leaked secrets or sensitive data.
4. **Review** recent `bash` tool history and file modifications for unauthorized changes.
5. **Re-install** OMK from a trusted source if the core runtime may have been tampered with.
6. **Report** the incident to the OMK security team or open a confidential issue on the repository.

## 8. References

- OMK Extension Manifest Specification: `packages/coding-agent/docs/extensions.md`
- OMK Session Format: `packages/coding-agent/docs/session-format.md`
- OMK Settings and Configuration: `packages/coding-agent/docs/settings.md`

---

*Last updated: 2026-08-19*
