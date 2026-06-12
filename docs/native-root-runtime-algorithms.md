# Native Root Runtime Algorithms and Acceptance Criteria

This appendix records the algorithmic contract and acceptance criteria for the OMK native root loop and runtime router. It is intended for papers, README excerpts, and DESIGN/architecture handoffs without claiming that every adapter has reached stable release status.

Implementation baseline:

- Upstream reference discussed during the hardening review: `6305e2b62185c11549f59e2340936769a3027cdd`.
- Current branch implementation target: `v1.2/native-root-runtime` after native runtime hardening.
- The upstream reference commit mainly patched release/smoke tarball globs; the algorithms below describe the native root loop, runtime router, context-capsule conversion, secure prompt transport, and scoped worker environment contracts.
- Safety wording is scoped to the exact adapter and evidence gates. Prompt envelopes, run artifacts, and explicit override environments remain trusted local/private data.

## LaTeX preamble

```latex
\usepackage{algorithm}
\usepackage{algpseudocode}
\usepackage{amsmath}
\usepackage{xspace}

\newcommand{\OMK}{\textsc{OMK}\xspace}
\newcommand{\Kimi}{\textsc{Kimi}\xspace}
\newcommand{\Runtime}{\mathcal{R}}
\newcommand{\Capsule}{\mathcal{C}}
\newcommand{\Task}{\mathcal{T}}
\newcommand{\Env}{\mathcal{E}}
```

## Algorithm 1: OMK Native Root Turn Execution

```latex
\begin{algorithm}[t]
\caption{\OMK Native Root Turn Execution}
\label{alg:omk-native-root-turn}
\begin{algorithmic}[1]
\Require User input stream $U$, runtime bootstrap $\beta$, task runner $\Runtime$, environment $\Env$
\Require Scoped MCP allowlist $M$, skills $S$, hooks $H$, turn timeout $\tau$
\Ensure Runtime output, TODO synchronization, and per-turn execution evidence

\State $\tau \gets \textsc{ResolveTimeout}(\Env[\texttt{OMK\_TURN\_TIMEOUT\_MS}], 120000)$
\State $\mathcal{Q} \gets \textsc{BuildSlashCommandTable}(\beta, \Env)$

\While{\textsc{SessionActive}()}
    \State $u \gets \textsc{ReadLine}(\texttt{omk>})$
    \If{$u = \emptyset$}
        \State \textbf{continue}
    \EndIf

    \If{$u \in \{\texttt{exit}, \texttt{quit}, \texttt{:q}, \texttt{/exit}, \texttt{/quit}\}$}
        \State \textbf{break}
    \EndIf

    \If{\textsc{IsSlashCommand}$(u)$}
        \State $(c,a) \gets \textsc{ParseCommand}(u)$
        \If{$c \in \mathcal{Q}$}
            \State \textsc{ExecuteCommand}$(\mathcal{Q}[c], a)$
        \Else
            \State \textsc{Print}(\texttt{Unknown command})
        \EndIf
        \State \textbf{continue}
    \EndIf

    \State $A \gets \textsc{BuildCapabilityInjection}(M,S,H)$
    \State $P \gets \textsc{BuildPromptEnvelope}(\beta,u,A)$
    \State $v \gets \textsc{BuildDagNode}(P,\beta,A)$
    \Comment{$v$ is a coordinator node with provider/model routing}

    \State $a \gets \textsc{NewAbortController}()$
    \State \textsc{StartTimer}$(a,\tau)$

    \Try
        \State $r \gets \Runtime.\textsc{Run}(v,\Env,a.\textsc{Signal})$
        \If{$r.\texttt{stdout} \neq \emptyset$}
            \State \textsc{WriteStdout}$(r.\texttt{stdout})$
            \State \textsc{AppendRecentOutput}$(r.\texttt{stdout})$
            \State \textsc{SyncTodosIfPresent}$(r.\texttt{stdout})$
        \EndIf
        \If{$r.\texttt{stderr} \neq \emptyset \land r.\texttt{exitCode} \neq 0$}
            \State \textsc{WriteStderr}$(r.\texttt{stderr})$
        \EndIf
    \Catch{$e$}
        \If{$a.\textsc{Aborted}()$}
            \State \textsc{ReportError}(\texttt{Turn timed out after }$\tau$)
        \Else
            \State \textsc{ReportError}$(e)$
        \EndIf
    \EndTry

    \State \textsc{ClearTimer}()
\EndWhile
\State \Return $0$
\end{algorithmic}
\end{algorithm}
```

## Algorithm 2: Native Root Turn Node Construction

The current hardening branch infers turn risk before assigning capabilities. This supersedes the earlier fixed `write,shell` construction. The classifier is a conservative prompt heuristic, not a full semantic planner.

```latex
\begin{algorithm}[t]
\caption{Native Root Turn Node Construction}
\label{alg:omk-turn-node}
\begin{algorithmic}[1]
\Require Bootstrap $\beta$, user prompt $u$, optional node id $i$, MCP set $M$, skill set $S$, hook set $H$
\Require Execution policy $x \in \{\texttt{ask},\texttt{auto},\texttt{never}\}$
\Ensure DAG node $v$ with provider-neutral prompt envelope and scoped capability routing

\State $i \gets i \ \textbf{or}\ \texttt{turn-}\textsc{Now}()$
\State $z \gets \textsc{InferNativeTurnRisk}(u)$
\Comment{heuristic: merge/shell/write keywords, else read}
\State $A \gets \textsc{NormalizeCapabilities}(M,S,H)$
\State $\pi \gets \textsc{NativeTurnRoutingPolicy}(\beta.\texttt{provider},z)$

\If{$\beta.\texttt{provider}=\texttt{deepseek} \land z \neq \texttt{read}$}
    \State $\pi.\texttt{capabilities} \gets [\texttt{read},\texttt{review}]$
    \State $\pi.\texttt{readOnly} \gets \texttt{true}$
    \State $\pi.\texttt{sandboxMode} \gets \texttt{read-only}$
\ElsIf{$z=\texttt{read}$}
    \State $\pi.\texttt{capabilities} \gets [\texttt{read}]$
    \State $\pi.\texttt{readOnly} \gets \texttt{true}$
\ElsIf{$z=\texttt{write}$}
    \State $\pi.\texttt{capabilities} \gets [\texttt{write},\texttt{patch}]$
\ElsIf{$z=\texttt{merge}$}
    \State $\pi.\texttt{capabilities} \gets [\texttt{write},\texttt{patch},\texttt{shell},\texttt{merge}]$
\Else
    \State $\pi.\texttt{capabilities} \gets [\texttt{write},\texttt{patch},\texttt{shell}]$
\EndIf

\State $E \gets \textsc{BuildPromptEnvelope}(\beta,u,A,\texttt{role}=\texttt{root-coordinator},\texttt{nodeId}=i,\texttt{risk}=z,\texttt{approval}=x,\texttt{sandbox}=\pi.\texttt{sandboxMode})$

\State $R \gets \{$
\Statex \hspace{\algorithmicindent}
$\texttt{provider}: \beta.\texttt{provider},$
\Statex \hspace{\algorithmicindent}
$\texttt{providerModel}: \beta.\texttt{selectedModel},$
\Statex \hspace{\algorithmicindent}
$\texttt{providerReason}: \textsc{ExplainSelection}(\beta),$
\Statex \hspace{\algorithmicindent}
$\texttt{assignedProviderCapabilities}: \pi.\texttt{capabilities},$
\Statex \hspace{\algorithmicindent}
$\texttt{risk}: z,$
\Statex \hspace{\algorithmicindent}
$\texttt{approvalPolicy}: x,$
\Statex \hspace{\algorithmicindent}
$\texttt{sandboxMode}: \pi.\texttt{sandboxMode},$
\Statex \hspace{\algorithmicindent}
$\texttt{readOnly}: \pi.\texttt{readOnly}$
\State $\}$

\State $R \gets \textsc{ApplyCapabilityInjectionToRouting}(R,A)$
\State $v \gets \textsc{DagNode}(i,\texttt{name}=\textsc{Render}(E),\texttt{role}=\texttt{coordinator},\texttt{dependsOn}=[],\texttt{routing}=R)$
\State \Return $v$
\end{algorithmic}
\end{algorithm}
```

## Algorithm 3: Runtime-backed Task Runner

```latex
\begin{algorithm}[t]
\caption{Runtime-backed Task Runner}
\label{alg:omk-runtime-backed-runner}
\begin{algorithmic}[1]
\Require DAG node $v$, runtime registry $\mathbb{R}$, context broker $B$, router $\rho$, environment $\Env$
\Ensure Task result $r$ with selected runtime metadata and fallback chain

\State $s \gets \textsc{BuildRunState}(v)$
\State $(\Capsule, q) \gets B.\textsc{BuildCapsule}(v,s)$
\State $F \gets \textsc{ResolveFallbackChain}(\Capsule.\texttt{node.routing})$
\State $a \gets \textsc{ResolveAbortSignal}()$

\State $\Task \gets \textsc{CapsuleToTask}(\Capsule,\Env,F,a)$
\Comment{Convert DAG context into provider-neutral AgentTask}

\If{$\rho.\textsc{Execute}$ is available}
    \State $y \gets \rho.\textsc{Execute}(\Task)$
    \State $r \gets \textsc{AgentResultToTaskResult}(y)$
\Else
    \State $y \gets \rho.\textsc{RunNode}(\Capsule,a)$
    \State $r \gets \textsc{AgentRunResultToTaskResult}(y)$
\EndIf

\State $r.\texttt{metadata.fallbackChain} \gets F$
\State \Return $r$
\end{algorithmic}
\end{algorithm}
```

## Algorithm 4: Context Capsule to AgentTask Conversion

```latex
\begin{algorithm}[t]
\caption{Context Capsule to AgentTask Conversion}
\label{alg:omk-capsule-to-task}
\begin{algorithmic}[1]
\Require Context capsule $\Capsule$, execution options $O$
\Ensure Provider-neutral agent task $\Task$

\State $v \gets \Capsule.\texttt{node}$
\State $R \gets v.\texttt{routing}$

\State $C \gets \{$
\Statex \hspace{\algorithmicindent}
$\texttt{runId}: \Capsule.\texttt{runId},$
\Statex \hspace{\algorithmicindent}
$\texttt{nodeId}: \Capsule.\texttt{nodeId},$
\Statex \hspace{\algorithmicindent}
$\texttt{role}: v.\texttt{role},$
\Statex \hspace{\algorithmicindent}
$\texttt{goal}: \Capsule.\texttt{goal},$
\Statex \hspace{\algorithmicindent}
$\texttt{system}: \Capsule.\texttt{system},$
\Statex \hspace{\algorithmicindent}
$\texttt{files}: \textsc{Paths}(\Capsule.\texttt{relevantFiles}),$
\Statex \hspace{\algorithmicindent}
$\texttt{memory}: \textsc{Summaries}(\Capsule.\texttt{graphMemory}),$
\Statex \hspace{\algorithmicindent}
$\texttt{abortSignal}: O.\texttt{signal},$
\Statex \hspace{\algorithmicindent}
$\texttt{cwd}: O.\texttt{cwd},$
\Statex \hspace{\algorithmicindent}
$\texttt{env}: O.\texttt{env},$
\Statex \hspace{\algorithmicindent}
$\texttt{risk}: R.\texttt{risk},$
\Statex \hspace{\algorithmicindent}
$\texttt{approvalPolicy}: R.\texttt{approvalPolicy},$
\Statex \hspace{\algorithmicindent}
$\texttt{sandboxMode}: R.\texttt{sandboxMode}$
\State $\}$

\State $T \gets R.\texttt{tools} \cup R.\texttt{assignedCapabilities.tools}$
\State $M \gets R.\texttt{mcpServers} \cup R.\texttt{assignedCapabilities.mcpServers}$
\State $S \gets R.\texttt{skills} \cup R.\texttt{assignedCapabilities.skills}$
\State $H \gets R.\texttt{hooks} \cup R.\texttt{assignedCapabilities.hooks}$

\State $P \gets \textsc{BuildProviderPolicy}(R.\texttt{provider},R.\texttt{candidateProviders},O.\texttt{fallbackChain})$
\State $K \gets \textsc{InferCapabilities}(v,R,\Capsule.\texttt{budget})$

\State $\Task \gets \langle \texttt{prompt}=\Capsule.\texttt{task},\texttt{context}=C,\texttt{tools}=(T,M,S,H),\texttt{providerPolicy}=P,\texttt{capabilities}=K \rangle$
\State \Return $\Task$
\end{algorithmic}
\end{algorithm}
```

## Algorithm 5: Intent-aware Runtime Routing and Fallback

```latex
\begin{algorithm}[t]
\caption{Intent-aware Runtime Routing and Fallback}
\label{alg:omk-runtime-routing}
\begin{algorithmic}[1]
\Require Agent task $\Task$, runtime set $\mathbb{R}$, evidence history $\mathcal{H}$
\Ensure Agent result $y$ with selected runtime and fallback metadata

\State $z \gets \textsc{ClassifyIntent}(\Task)$
\State $P \gets \textsc{RuntimePreferencesFromTask}(\Task)$

\If{$P \neq \emptyset$}
    \State $\mathbb{C} \gets \{r \in \mathbb{R} \mid r.\texttt{id} \in P\}$
\Else
    \State $\mathbb{C} \gets \mathbb{R}$
\EndIf

\State $\mathbb{S} \gets \{r \in \mathbb{C} \mid r.\textsc{Execute} \neq \emptyset \land \textsc{Supports}(r,\Task)\}$

\If{$\mathbb{S} = \emptyset$}
    \State \textbf{raise} \texttt{NoRuntimeSupportsTask}
\EndIf

\ForAll{$r \in \mathbb{S}$}
    \State $q_r \gets \textsc{ComputeQualityScore}(r,z,\mathcal{H})$
    \State $e_r \gets \textsc{EvidencePassRate}(r,z,\mathcal{H})$
    \State $p_r \gets \textsc{RecentFailurePenalty}(r,\mathcal{H})$
    \State $c_r \gets \textsc{CompositeScore}(q_r,e_r,p_r,P,r.\texttt{id})$
\EndFor

\State Sort $\mathbb{S}$ by $c_r$ in descending order
\State $r^\star \gets \mathbb{S}[0]$
\State $F \gets \mathbb{S}[1:]$
\State $\mathbb{A} \gets [r^\star] \mathbin{+\!\!+} F$

\State \textsc{RecordDecisionTrace}$(\Task,z,r^\star,F,\{c_r\})$

\ForAll{$r \in \mathbb{A}$}
    \If{$\Task.\texttt{context.abortSignal.aborted}$}
        \State \Return $\textsc{AbortedResult}(r)$
    \EndIf

    \Try
        \State $y \gets r.\textsc{Execute}(\Task)$
        \If{$y.\texttt{exitCode}=0$}
            \State $y.\texttt{metadata.selectedRuntime} \gets r.\texttt{id}$
            \State $y.\texttt{metadata.intent} \gets z$
            \State $y.\texttt{metadata.fallbackChain} \gets \textsc{Ids}(\mathbb{A})$
            \State $y.\texttt{metadata.scores} \gets \{c_r\}$
            \State \Return $y$
        \EndIf
        \State $y_{\mathrm{last}} \gets y$
    \Catch{$e$}
        \State $y_{\mathrm{last}} \gets \textsc{ErrorResult}(r,e)$
    \EndTry
\EndFor

\State \Return $y_{\mathrm{last}} \ \textbf{or}\ \textsc{NoRuntimeAvailableResult}(\mathbb{A})$
\end{algorithmic}
\end{algorithm}
```

## Algorithm 6: Secure Worker Prompt Transport for Kimi Runtime

```latex
\begin{algorithm}[t]
\caption{Secure Worker Prompt Transport for Kimi Runtime}
\label{alg:omk-secure-kimi-transport}
\begin{algorithmic}[1]
\Require DAG node $v$, merged environment $\Env$, prompt prefix $\pi$, Kimi binary $b$
\Ensure Kimi execution result without exposing prompt text through process arguments

\State $p \gets \textsc{BuildNodeMessage}(v,\Env,\pi)$
\State $A \gets [\texttt{--print}, \texttt{--input-format}, \texttt{text}]$
\Comment{Do not append $p$ to argv}

\If{$v$ has scoped agent file}
    \State $f \gets \textsc{WriteScopedAgentFile}(v,\Env)$
    \State $A \gets [\texttt{--agent-file}, f] \mathbin{+\!\!+} A$
\EndIf

\State $b \gets \textsc{ResolveKimiBinary}(\Env)$
\If{$\neg \textsc{CommandExists}(b)$}
    \State \Return \textsc{Failure}(\texttt{Primary provider not found})
\EndIf

\State $r \gets \textsc{RunShellStreaming}(b,A,\texttt{cwd}=v.\texttt{worktree},\texttt{env}=\Env,\texttt{input}=p,\texttt{timeout}=v.\texttt{timeout})$
\State \Return $r$
\end{algorithmic}
\end{algorithm}
```

## Algorithm 7: Scoped Worker Environment Construction

```latex
\begin{algorithm}[t]
\caption{Scoped Worker Environment Construction}
\label{alg:omk-worker-env}
\begin{algorithmic}[1]
\Require Capability context $C$, optional provider policy $P$, optional capabilities $K$
\Require Parent environment $\Env_{\mathrm{parent}}$, run id $\rho$, node id $\nu$, role $\omega$
\Ensure Sanitized child environment $\Env_{\mathrm{child}}$

\State $\Env_{\mathrm{worker}} \gets C.\texttt{env}$

\If{$P \neq \emptyset$}
    \State $\Env_{\mathrm{worker}}[\texttt{OMK\_NODE\_PROVIDER\_POLICY}] \gets \textsc{JsonEncode}(P)$
\EndIf

\If{$K \neq \emptyset$}
    \State $\Env_{\mathrm{worker}}[\texttt{OMK\_NODE\_CAPABILITIES}] \gets \textsc{JsonEncode}(K)$
\EndIf

\State $\Delta \gets \Env_{\mathrm{worker}} \cup \{$
\Statex \hspace{\algorithmicindent}
$\texttt{OMK\_RUN\_ID}: \rho,$
\Statex \hspace{\algorithmicindent}
$\texttt{OMK\_NODE\_ID}: \nu,$
\Statex \hspace{\algorithmicindent}
$\texttt{OMK\_NODE\_ROLE}: \omega$
\State $\}$

\State $\Env_{\mathrm{child}} \gets \textsc{BuildChildEnv}(\texttt{parentEnv}=\Env_{\mathrm{parent}},\texttt{overrideEnv}=\Delta)$
\State \Return $\Env_{\mathrm{child}}$
\end{algorithmic}
\end{algorithm}
```

## Paper-ready summary paragraphs

```latex
\paragraph{Kimi-first native orchestration.}
OMK implements a Kimi-first but provider-neutral runtime architecture under active hardening. For each interactive root turn, OMK constructs a prompt envelope, injects scoped capabilities such as MCP servers, skills, and hooks, and materializes the turn as a DAG coordinator node. The node is converted into a context capsule and then into a provider-neutral AgentTask. A runtime router classifies the task intent, filters runtimes by capability compatibility, scores them using evidence history and preference priors, and executes the selected runtime with an explicit fallback chain. This design preserves Kimi as the mature authority runtime while allowing Codex, DeepSeek, OpenCode, and CommandCode to participate as typed worker runtimes when adapter health, approval policy, sandbox behavior, and capability contracts match the task.

\paragraph{Secure prompt and environment transport.}
Recent OMK revisions harden worker execution by removing prompt payloads from process arguments. Kimi DAG prompts are transmitted through standard input with \texttt{--input-format text}, reducing process-list leakage risk. Kimi child execution and default native worker spawn paths receive scoped metadata through sanitized child environments. External CLI adapters and explicit override environments remain trusted local inputs and must be reviewed per adapter.
```

## Placement guide

| Target | Recommended algorithms |
| --- | --- |
| Main paper / README excerpt | Algorithm 1, Algorithm 5, Algorithm 6 |
| Architecture appendix | Algorithm 2, Algorithm 3, Algorithm 4 |
| Security section | Algorithm 6, Algorithm 7 |
| Release hardening checklist | Algorithm 2, Algorithm 5, Algorithm 7 |

## Current implementation caveats

- `/provider` is restart-only in the native root loop; it does not live-switch the active runtime in-place.
- `/model` currently reports the requested model but should be treated as UX debt until live state mutation or a restart-only message is enforced consistently.
- Approval and sandbox routing are preserved in the native root task contract and consumed by Codex/external adapters; Kimi print runtime currently receives limited hints rather than a fully enforced sandbox contract.
- Kimi worker prompt payloads are sent through stdin, but prompt envelopes, DAG node names, and run artifacts may still contain private user prompt content and must be treated as private.
- Provider stderr diagnostics still require continued redaction/debug-gating work; safety claims depend on the exact adapter path and tests.
- Provider health probes are improving, but binary/API presence, auth state, model support, and quota state are not yet uniformly separated across every adapter; Algorithm 5 routes by available registry/capability/evidence metadata, not by universal quota-aware health.
- ActionAtom, Novelty Guard, and provider-lane fanout language in prompt/harness surfaces remains contract-level unless backed by a concrete runtime implementation and tests.
