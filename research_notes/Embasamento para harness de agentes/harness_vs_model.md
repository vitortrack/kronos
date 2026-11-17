# Harness vs model: empirical evidence that the agent scaffold changes coding-agent success rates

Research date: 2026-11-09. All numbers are percentages of tasks resolved or passed unless stated. "pts" means absolute percentage points. Sources marked **[secondary]** are blogs, aggregators, or search-result excerpts that I could not confirm against the primary page. Sources marked **[vendor]** were written by a company that sells one of the harnesses compared.

## 1. Same model, different harness: how much do success rates move?

### Takeaway
With the model held fixed, changing the harness moves success rates by roughly 4 to 26 pts on 2024-2026 coding benchmarks. Measured spreads: Terminal-Bench 2.0 about 24 pts for Opus 4.6 and for Haiku 4.5, SWE-bench Verified up to 11-15 pts (Epoch), Endor's security benchmark 26 pts for GPT-5.5, and a 13-pt spread across four harnesses for an open GLM model. That is the same order of magnitude as a model generation upgrade. One caveat: differences under about 3 pts are inside infrastructure noise.

### Cited Findings

**Endor Labs Agent Security League (SusVibes-based vulnerability-fix tasks; FuncPass = functional tests, SecPass = hidden security tests)**
- Post published 2026-04-27, updated 2026-04-29. Functional / secure scores: Cursor + GPT-5.5 87.2 / 23.5; Cursor + Opus 4.7 91.1 / 22.9; Claude Code + Opus 4.7 87.2 / 20.1; Codex + GPT-5.5 61.5 / 20.1; Codex + GPT-5.4 62.6 / 17.3. Same-model gaps: GPT-5.5 Codex→Cursor +25.7 pts functional; Opus 4.7 Claude Code→Cursor +3.9 pts functional. — [Endor Labs, "GPT-5.5 Sets a New Code Security Record with Cursor, not Codex"](https://endorlabs.com/learn/gpt-5-5-sets-a-new-code-security-record-with-cursor-not-codex-in-agent-security-league)
- Endor's explanation of the Codex gap: 16 of 30 analyzed Codex + GPT-5.5 failures were shared with Codex + GPT-5.4, which "suggests a systematic Codex limitation rather than something specific to GPT-5.5". The authors hypothesize that the Codex CLI harness "handles certain repository structures, build systems, or test frameworks differently". They put the security non-determinism band at ±2-3 pts. — [Endor Labs](https://endorlabs.com/learn/gpt-5-5-sets-a-new-code-security-record-with-cursor-not-codex-in-agent-security-league)
- Later snapshot of the Endor leaderboard: Cursor + GPT-5.5 84.9 functional / 24.0 secure; Codex + GPT-5.5 62.6 / 22.4. The scores were re-scored, so the snapshots differ. — **[secondary: search-result summary of Endor's leaderboard]** [Endor AI code security benchmark](https://www.endorlabs.com/research/ai-code-security-benchmark)
- 2026-06-17, Claude Fable 5, 200 tasks, one run per task, "fair" scores (anti-cheating adjusted). Cursor + Fable 5: FuncPass 72.6%, SecPass 29%. Claude Code + Fable 5: FuncPass 59.8%, SecPass 19.0%. Gap: +12.8 pts functional, +10 pts security. Endor attributes the gap to patch quality, not extra time or infrastructure: of 34 instances only Cursor solved, most were cases where Claude Code produced a substantive but incorrect patch. Of 25 SecPass instances only Cursor solved, 13 were Claude Code patches that passed functional tests but missed the vulnerability, because Cursor's patches were more complete (all input variants, every sink guarded). Caveats: Cursor served a mix of thinking and no-thinking variants, and the author did not rule out a fallback to Opus 4.8. — [Endor Labs, "Claude Fable 5 take two: same model, different harness"](https://www.endorlabs.com/learn/claude-fable-5-take-two-same-model-different-harness-and-a-very-different-result)

**Terminal-Bench 2.0 (89 tasks), from the Meta-Harness paper (primary paper, which compiles leaderboard numbers; arXiv 2026-03-30)**
- Claude Opus 4.6: ForgeCode 81.8% (not reproduced by the authors), Meta-Harness 76.4%, Capy 75.3%, Terminus-KIRA 74.7%, MAYA-V2 72.1%, TongAgents 71.9%, Droid 69.9%, Mux 66.5%, Terminus 2 62.9%, Claude Code 58.0%. Same-model spread is 23.8 pts. Claude Code, the model vendor's own harness, is last. — [Lee et al., Meta-Harness, arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Claude Haiku 4.5: Meta-Harness 37.6%, Goose 35.5%, Terminus-KIRA 33.7%, mini-SWE-agent 29.8%, Terminus 2 28.3%, Claude Code 27.5%, OpenHands 13.9%. Spread is 23.7 pts, or 2.7x from worst to best. — [Meta-Harness](https://arxiv.org/html/2603.28052v1)

**Terminal-Bench 2.0 / 2.1, other same-model entries**
- GPT-5.5: Codex CLI 83.4% vs Terminus 2 78.2% (tbench.ai leaderboard as of 2026-06-09, via MorphLLM). Vals.ai's Terminal-Bench 2.1 run, which uses Terminus 2 for every model, reports 76.40%. The source does not reconcile the two Terminus 2 numbers. — **[secondary]** [Daniel Vaughan, "Terminal-Bench 2.1 June 2026 landscape" (2026-06-11)](https://codex.danielvaughan.com/2026/06/11/terminal-bench-2-1-june-2026-benchmark-landscape-codex-cli-harness-engineering-model-scores/)
- GPT-5.3-Codex: Terminus 2 64.7% vs SageAgent 78.4% (13.7 pts). The survey reportedly says these gaps are "substantially larger than the standard errors" of leaderboard entries. I could not extract the PDF text to verify this. — **[secondary: search excerpt]** [Guo et al., "From Question Answering to Task Completion: A Survey on Agent System and Harness Design", arXiv 2606.20683 (June 2026)](https://arxiv.org/pdf/2606.20683)
- Open model GLM-5.2, Terminal-Bench 2.1 (89 tasks, 5 runs per task, averaged; inference through Moonshot's API; single model, no routing), 2026-09-07: Kimchi 72.6%, Cursor 69.0%, Claude Code 65.4%, Opencode 59.8%. Spread is 12.8 pts (13.0 in the article). Kimchi credits early compaction with a generous token reserve, pruning stale or UI-only messages, removing phantom tool calls and dangling tool results, guardrails on stale edits and repeated commands, a loop guard plus circuit breaker on edit-run-fail cycles, and a fix for GLM-5.2's unbound-thinking issue. Kimchi says the Opencode number came from different runs and periods, so it is directional only. — **[vendor]** [Kimchi, "Same Model, Different Results"](https://kimchi.dev/blog/same-model-different-harness-terminal-bench)
- GLM-5 on Terminal-Bench 2.0: Z.ai self-reports 56.2 (Claude Code), and 61.1 / 60.7 on a "verified" dataset after fixing environment issues. Vals.ai independently reports 49.44% with Terminus 2. GLM-5.1 on Vals.ai with Terminus 2: 53.93%. — **[secondary: search excerpts, mixed snapshots]** [Vals.ai Terminal-Bench 2](https://vals.ai/benchmarks/terminal-bench-2)
- Statistical attribution on Terminal-Bench 2.0: "the gains from simply picking the best harness are comparable to those from picking the best LLM". Harness effects are heterogeneous, so some harnesses work better with some LLMs. The abstract page gives no numbers. — [Han & Sun, "How good is your harness?", ICML 2026](https://icml.cc/virtual/2026/68323)

**SWE-bench Verified**
- Epoch AI (2025-12-23): "simply switching the scaffold makes up to an 11% difference for GPT-5" and "up to a 15% difference for Kimi K2 Thinking". Epoch calls the scaffold "the single biggest impact on the overall performance", but also names the API provider as "the biggest factor of variance in evaluation results". The specific scaffolds compared are not named in the post. — [Epoch AI, "Why benchmarking is hard"](https://epochai.substack.com/p/why-benchmarking-is-hard)
- GPT-5.1 scored 68% on Epoch's own scaffold vs 76.3% as reported by OpenAI. Grok 4 is self-reported at 72-75% vs 58.6% on vals.ai with the SWE-agent scaffold. — **[secondary]** [gu-log on Epoch's re-run](https://gu-log.vercel.app/en/posts/en-clawd-picks-20260222-epochai-swebench-methodology-reset)
- Live-SWE-agent vs mini-SWE-agent, same LLM, full 500 Verified, one attempt (arXiv v3, 2025-11-24): GPT-5-Mini 59.8 → 63.0 (+3.2); GPT-5 65.0 → 68.4 (+3.4); Claude 4.5 Sonnet 70.6 → 75.4 (+4.8); Gemini 3 Pro 74.2 → 77.4 (+3.2). Cost per task barely changed (for example $0.56 → $0.68 for Sonnet 4.5). SWE-bench Pro with Claude 4.5 Sonnet: SWE-agent 43.6% vs Live-SWE-agent 45.8%. — [Xia et al., Live-SWE-agent, arXiv 2511.13646](https://arxiv.org/html/2511.13646)
- mini-SWE-agent (about 100 lines of Python, bash as the only tool, no tool-calling API). Reported as about 65% on SWE-bench Verified with Claude Sonnet 4 in v1, 68% in v1.11, and ">74%" in v2 with Gemini 3 Pro. A minimal harness gets within a few points of heavy scaffolds with frontier models. — **[secondary: search excerpts of README/PyPI]** [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent); [PyPI](https://pypi.org/project/mini-swe-agent/)
- Anthropic (2025-01-06), fixed minimal scaffold (prompt + bash tool + str_replace edit tool, run to 200k context): Claude 3 Opus 22%, Claude 3.5 Sonnet (old) 33%, Claude 3.5 Sonnet (new) 49%; the previous SOTA was 45%. Quote: performance "can vary significantly based on this scaffolding, even when using the same underlying AI model." This is also a counterpoint: in a fixed harness, model upgrades moved the score by 27 pts. — [Anthropic, "Raising the bar on SWE-bench Verified with Claude 3.5 Sonnet"](https://www.anthropic.com/engineering/swe-bench-sonnet)
- Trae Agent (2025-07-31): 75.20% Pass@1 on SWE-bench Verified (first place at the time) using generation, pruning, and selection ensemble agents. It reports +10.22% average Pass@1 over four SOTA ensemble-reasoning baselines across three LLMs, which the abstract does not name. — [Trae Agent, arXiv 2507.23370](https://arxiv.org/abs/2507.23370)

**SWE-agent Agent-Computer Interface (ACI) ablations (2024-05; GPT-4 Turbo; SWE-bench Lite unless noted)**
- Main results: RAG (non-agentic) 2.67% Lite / 1.31% Full. Shell-only agent 11.00% Lite (7.33% without demonstration). SWE-agent 18.00% Lite / 12.47% Full. Claude 3 Opus: RAG 4.33 Lite / 3.79 Full, SWE-agent 13.00 Lite / 10.46 Full. The ACI over plain shell is worth +7 pts (+64% relative) with the same model. — [Yang et al., SWE-agent, arXiv 2405.15793](https://arxiv.org/html/2405.15793)
- Ablations, all against 18.0 default:
  - Editor: edit with linting 18.0, edit without linting 15.0, no edit command 10.3.
  - Search: summarized 18.0, iterative 12.0, no search 15.7.
  - File viewer window: 100 lines 18.0, 30 lines 14.3, full file 12.7.
  - Context: keep the last 5 observations 18.0, full history 15.0, no demonstration 16.3.

  — [SWE-agent](https://arxiv.org/html/2405.15793)

**Agentless vs agentic (2024)**
- Agentless (fixed localize → repair → validate pipeline, no agent loop): 32.00% on SWE-bench Lite (96 fixes) at $0.70. It reported the highest performance and lowest cost among open-source agents at the time. The abstract does not name the LLM. — [Xia et al., Agentless, arXiv 2407.01489](https://arxiv.org/abs/2407.01489)

**Infrastructure noise (fixed harness, fixed model)**
- Anthropic (2026-02-05), Terminal-Bench 2.0: the gap between the most- and least-resourced pod setups was 6 pts (p < 0.01). Infra error rate was 5.8% at 1x limits, 2.1% at 3x, and 0.5% uncapped. From 1x to 3x, success changed only within noise (p = 0.40). SWE-bench (227 problems × 10 samples): scores rose monotonically with RAM, +1.54 pts at 5x. Recommendation: "be skeptical of differences below 3 percentage points until the eval configuration is documented and matched." — [Anthropic, "Quantifying infrastructure noise in agentic coding evals"](https://www.anthropic.com/engineering/infrastructure-noise)

### Inferences
- The same model on Terminal-Bench 2.0 spans about 24 pts across public harnesses, for Opus 4.6 and Haiku 4.5 alike. The vendor's own CLI (Claude Code) is near the bottom for both. "Official harness = best harness" is therefore not a safe assumption.
- SWE-agent's ablations are still the cleanest component-level evidence. A capped file viewer (100 lines), a summarized search, an edit tool that lints before applying, and truncating old observations each moved the score by 3 to 6 pts with GPT-4 Turbo. TrackAI's tolerant edit tool, compaction, and retrieval sit on exactly these axes.
- Gains between minimal and heavy harnesses shrink at the frontier. mini-SWE-agent with Gemini 3 Pro gets 74.2%, and Live-SWE-agent adds only 3.2 pts. The large same-model gaps show up on long-horizon terminal tasks and on weaker models.
- When TrackAI measures its own harness changes, a delta under 3 pts on an 89-task set is indistinguishable from infrastructure noise unless runs are repeated. Kimchi used 5 runs per task, and Anthropic recommends runs on multiple days.

### Gaps
- I could not load the live tbench.ai Terminal-Bench 2.0 leaderboard rows (the page rendered without data). The Opus 4.6 and Haiku 4.5 rows come from the Meta-Harness paper's compilation. The GPT-5.3-Codex 64.7 vs 78.4 pair is from an unverified search excerpt.
- The Terminal-Bench paper (arXiv 2601.11868) reportedly says that choosing a stronger model usually helped more than choosing a different scaffold. The abstract page did not contain this, so it is unverified.
- No numbers found for OpenHands vs other harnesses with the same frontier model on SWE-bench Verified, apart from OpenHands at 13.9% with Haiku 4.5 on Terminal-Bench 2.0.
- The OpenAI harness-engineering post could not be fetched (HTTP 403).

## 2. What do the official engineering posts claim, and which claims are measured?

### Takeaway
The OpenAI and Anthropic "harness/context engineering" posts are almost entirely qualitative practitioner guidance; the only measured harness effects from these labs are in Anthropic's SWE-bench post (fixed-scaffold model comparison), its infrastructure-noise study, and a few token counts. Their recommendations (simple loops, poka-yoke tools, absolute paths, unique-match str_replace, compaction, external progress files, one feature per session, end-to-end self-testing) are consistent with the measured ablations in Section 1 but are not themselves controlled experiments.

### Cited Findings
- **OpenAI, "Harness engineering: leveraging Codex in an agent-first world"** (Ryan Lopopolo, 2026-02-11 per search listing; primary page returned 403): an internal beta product of "roughly a million" lines was built over a five-month experiment by a small team "without any manually written source code". Practices: a structured docs directory (maps, execution plans, design specs) as the agents' "single source of truth"; a layered architecture (Types → Config → Repo → Service → Runtime → UI) enforced by mechanical rules and structural tests; custom linters and CI validation for docs; logs, metrics, and spans so agents can reproduce bugs. InfoQ reports no productivity, quality, defect, or cost metrics, and nothing independently verified. — **[secondary]** [InfoQ, 2026-02-21](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex); primary URL [openai.com/index/harness-engineering](https://openai.com/index/harness-engineering/)
- Secondary summaries frame the difference this way: context engineering asks what the agent should see; harness engineering asks what the system should prevent, measure, and correct. — **[secondary]** [zby commonplace notes](https://zby.github.io/commonplace/sources/harness-engineering-leveraging-codex-agent-first-world)
- **Anthropic, "Building effective agents"** (2024-12-19). The recommendations:
  - "finding the simplest solution possible, and only increasing complexity when needed".
  - Frameworks "can obscure the underlying prompts and responses".
  - Tool definitions deserve "just as much prompt engineering attention as your overall prompts".
  - Poka-yoke the arguments.
  - On SWE-bench, "we actually spent more time optimizing our tools than the overall prompt". After switching to "always require absolute filepaths", "the model used this method flawlessly".

  No numbers back these claims; they are anecdotal. — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- **Anthropic SWE-bench scaffold post** (2025-01-06). Design choices were justified by reliability observations. String replacement had "the highest reliability" among edit strategies tried. The replacement happens only if `old_str` matches exactly once, otherwise an error comes back and the model retries. Absolute paths are required. The only numbers are model comparisons in the fixed scaffold: 22% / 33% / 49%. — [Anthropic](https://www.anthropic.com/engineering/swe-bench-sonnet)
- **Anthropic, "Effective context engineering for AI agents"** (2025-09-29). Claims: context rot, a finite "attention budget" with the goal of the "smallest possible set of high-signal tokens", a "minimal viable set of tools", just-in-time retrieval through lightweight references, compaction, tool-result clearing as the lightest compaction, structured note-taking, and sub-agents that return condensed summaries ("often 1,000-2,000 tokens"). Models show "a performance gradient rather than a hard cliff". Multi-agent "showed a substantial improvement over single-agent systems". None of these claims is quantified in the post. — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Anthropic, "Writing effective tools for agents"** (2025-09-11):
  - Claude-optimized tools beat human-written ones on held-out Slack and Asana test sets, shown as charts without numbers in the text.
  - The concise vs detailed response format was 72 vs 206 tokens.
  - Claude Code caps tool responses at 25,000 tokens by default.
  - Returning natural-language names instead of UUIDs reduced hallucinations (not quantified).
  - A tool-description fix stopped Claude from appending "2025" to search queries.

  — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- **Anthropic, "Effective harnesses for long-running agents"** (Justin Young, 2025-11-26). The harness design:
  - An initializer agent writes `init.sh`, `claude-progress.txt`, and an initial git commit.
  - A JSON feature list starts with every feature marked failing, and coding agents may flip only `passes`. JSON was chosen because the model is less likely to overwrite it inappropriately than Markdown; "It is unacceptable to remove or edit tests".
  - Exactly one feature per session is "critical".
  - Each session starts with a routine: read the logs, pick a feature, run an end-to-end check.
  - Explicit browser-automation (Puppeteer MCP) end-to-end testing "dramatically improved performance".

  Failure modes it addresses: one-shotting the whole app, declaring victory early, marking features done without end-to-end tests, leaving undocumented broken state, and wasting time figuring out how to run the app. No success rates, ablations, or baselines are reported; the only number is the scope of the claude.ai clone test case (">200 features"). — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Anthropic, infrastructure noise** (2026-02-05). This is the one fully measured Anthropic engineering post here. It recommends treating resource configuration as a first-class experimental variable, setting a guaranteed allocation separately from a hard kill threshold, and running public evals at multiple times and on multiple days. — [Anthropic](https://www.anthropic.com/engineering/infrastructure-noise)
- Endor Labs' framing: "the agent harness matters as much as model capability". This rests on its measured leaderboard (Section 1). — [Endor Labs](https://endorlabs.com/learn/gpt-5-5-sets-a-new-code-security-record-with-cursor-not-codex-in-agent-security-league)

### Inferences
- Several lab claims are supported by independent measurements. The minimal tool set and the constrained edit tool match SWE-agent's ablations: no edit command 10.3 vs 18.0, and linting the edit was worth +3 pts. Context trimming matches SWE-agent's last-5-observations result (+3 pts over full history). The environment snapshot at startup matches Meta-Harness's discovered bootstrap (Section 3). Long-running-agent practices such as progress files and one feature at a time have no published ablation I could find.
- For TrackAI, the measured items are worth copying as defaults: a unique-match str_replace edit with an error-and-retry path, absolute paths, a lint or syntax check before an edit is accepted, a capped file view, and observation truncation or compaction. The unmeasured items (progress JSON, initializer session) are reasonable but should be A/B tested locally.

### Gaps
- I could not read OpenAI's primary harness-engineering post (403). Details such as AGENTS.md as a short map, doc-gardening agents, or PRs per engineer come only from secondary summaries and are not included as facts.
- No Cognition, Cursor, or Google DeepMind engineering post with same-model harness measurements was retrieved in this pass.
- Anthropic's Slack/Asana tool-optimization gains exist only as charts; the exact numbers were not in the text.

## 3. Automatic harness / scaffold optimization (2024-2026): methods and measured gains

### Takeaway
Automated harness search reliably beats the starting harness: +3 to +30 pts on SWE-bench-style tasks for self-improving coding agents, and +2 to +12 pts for 2026 harness optimizers on Terminal-Bench 2.0 and professional benchmarks. Two ingredients carry the gains: giving the optimizer **raw execution traces** rather than summaries, and making additive, environment-grounded changes rather than prompt rewrites. Offline evolution is expensive (hundreds to more than 1,000 GPU or API hours), while runtime self-evolution helps strong models and can badly hurt weak ones.

### Cited Findings
- **Meta-Harness** (Lee, Nair, Zhang, K. Lee, Khattab, Finn; Stanford/KRAFTON/MIT; arXiv 2603.28052, 2026-03-30). Method: an outer loop in which an agentic proposer (Claude Code with Opus 4.6) reads the source code, scores, and execution traces of all prior candidates through the filesystem. It reads a median of 82 files per iteration: 41% prior harness code, 40% execution traces, 6% score summaries. That is about 10 MTok of context per iteration in the largest setting; prior text optimizers used about 100 to 30k tokens per step. A typical run evaluates about 60 harnesses over 20 iterations. Results:
  - Terminal-Bench 2.0 with Opus 4.6: 76.4%, vs 74.7% for the Terminus-KIRA seed and 64.4% for the starting baseline in the search log. It ranks #2 among Opus 4.6 agents.
  - Terminal-Bench 2.0 with Haiku 4.5: 37.6%, #1 ahead of Goose at 35.5%.
  - What the winning harness changed: an approximately 80-line **environment bootstrap**. One shell command snapshots the working directory, `/app`, available languages and package managers, and memory into the first prompt (15 s timeout, fails silently). It gained on 7 of 89 tasks.
  - "The first six candidates that edited prompts or completion logic all regressed"; the winner was purely additive.

  — [Meta-Harness](https://arxiv.org/html/2603.28052v1)
- Meta-Harness on text classification (GPT-OSS-120B; LawBench, Symptom2Disease, USPTO-50k): 48.6% using 11.4K context tokens, vs ACE 40.9% (50.8K tokens), MCE 40.0%, and few-shot 40.8%. That is +7.7 pts with about 4x fewer tokens. On search-set median/best it beat other optimizers: Meta-Harness 50.0/56.7, GEPA 32.6/40.2, Best-of-N 34.0/44.2, OpenEvolve 39.1/43.3, TTT-Discover 34.1/45.6. Ablation: scores only 34.6/41.3, scores plus LLM summaries 34.9/38.7, full raw traces 50.0/56.7. "Summaries don't recover the missing signal." — [Meta-Harness](https://arxiv.org/html/2603.28052v1)
- Meta-Harness on IMO-level math retrieval (200 problems; harness searched with GPT-OSS-20B, 109 candidates over 40 iterations). The discovered harness transferred to five held-out models for an average of +4.7 pts (34.1 → 38.8): GPT-5.4-nano +8.7, GPT-5.4-mini +1.6, Gemini-3.1-Flash-Lite +6.3, Gemini-3-Flash +3.7, GPT-OSS-20B +3.0. It beat BM25 (37.5) and dense retrieval (38.1). — [Meta-Harness](https://arxiv.org/html/2603.28052v1)
- **Harness²** ("Recursive Agent Harnessing for an Open World"; Xu, Chen, ..., Pfister; Google; arXiv 2610.14224, 2026-10-09). It is a plug-and-play layer over an existing harness with two recursions:
  - Task-level: a contrastive **Propose-Probe-Compose** step that needs no ground-truth verifier and can run in parallel or in sequence.
  - Harnessing-level: distills lessons from task-level edits into a continual-improvement harness so they carry over to unseen tasks.

  A single step consistently improved **GLM-5** and **Gemini 3.5 Flash** over their base harnesses. Maximum gains: +11.5 pts on WorkBuddy-Bench, +4.5 on JobBench, +11.8 on LAB. Gains grow with the task-level recursion budget. — [Harness², arXiv 2610.14224](https://arxiv.org/abs/2610.14224)
- **Darwin Gödel Machine** (Zhang, Hu, Lu, Lange, Clune; arXiv 2505.22954, v1 2025-05-29). Method: open-ended archive evolution in which the agent rewrites its own Python code. Self-modification used Claude 3.5 Sonnet (new) over 80 iterations, with a 60-task screen and then 200 SWE-bench Verified tasks. Results: SWE-bench 20.0% → 50.0%; Polyglot 14.2% → 30.7% (50-task subset 14.0 → 38.0). Discovered improvements include a granular edit tool (view by line ranges, edit by string replacement instead of whole-file operations), multiple attempts with another model ranking them, and conditioning on prior failed attempts. Transfer of the discovered agent to other models on SWE-bench (200 tasks): o3-mini 23.0 → 33.0; Claude 3.7 Sonnet 19.0 → 59.5. Cross-benchmark transfer: the SWE-evolved agent scored 28.9% on Polyglot (base 14.2). A single SWE-bench run takes about 2 weeks and "incurs significant API costs". — [DGM, arXiv 2505.22954](https://arxiv.org/html/2505.22954)
- **SICA, "A Self-Improving Coding Agent"** (Robeyns, Szummer, Aitchison; arXiv 2504.15228, 2025-04-21): 17% → 53% on a random subset of SWE-bench Verified, plus unquantified gains on LiveCodeBench and synthetic benchmarks. — [SICA](https://arxiv.org/abs/2504.15228)
- **Offline self-improvers compared on SWE-bench Verified-60 with GPT-5-Mini** (from Live-SWE-agent): SICA 50.0% (offline cost: "infinite loop"), DGM 53.3% (1,231 h), HGM 56.7% (512 h), Live-SWE-agent 65.0% (0 h offline). — [Live-SWE-agent](https://arxiv.org/html/2511.13646)
- **Live-SWE-agent** (Xia et al., arXiv 2511.13646, 2025-11). It starts from the bash-only mini-SWE-agent and creates or modifies its own tools at runtime, with no offline training. Full-Verified gains are +3.2 to +4.8 pts across four LLMs (Section 1). It reaches 77.4% with Gemini 3 Pro and 45.8% on SWE-bench Pro with Claude 4.5 Sonnet. — [Live-SWE-agent](https://arxiv.org/html/2511.13646)
- **ADAS / Meta Agent Search** (Hu, Lu, Clune; arXiv 2408.08435, 2024-08). A meta-agent writes new agent designs in code. The abstract claims the discovered agents "greatly outperform" hand-designed ones in coding, science, and math, and keep their advantage across domains and models. No numbers were retrieved. — [ADAS](https://arxiv.org/abs/2408.08435)
- **HarnessEvo, "Where Does Harness-Optimization Value Live?"** (Nguyen et al., arXiv 2609.02889; the listing says 25 Jun 2026, which is inconsistent with a 2609 ID). The setup is Qwen2.5-7B with four harness slots: role, strategy, tool/format rules, and reflection/control.
  - On ALFWorld (n=134) only the **reflection/control** slot was significant: leave-one-in +0.119 (p = 0.0046). Role (+0.030), strategy (+0.007), and format (+0.007) were not.
  - Optimizing all four slots together gave only +0.015 (not significant), well short of the +0.164 sum of single-slot gains. The paper calls this strongly sub-additive.
  - The cause is a **budget-splitting trap**: at 16 rollouts per slot the optimizer accepted no mutation. A control-only run with 32 rollouts reached 0.761 vs 0.642 stock.
  - WebShop: stock 0.518, full 0.545 (not significant).

  — [HarnessEvo](https://www.alphaxiv.org/abs/2609.02889.md)
- **HarnessOpt-Bench** (Ursekar et al., arXiv 2608.06301, 2026-08-06): 5 frontier LLMs as optimizers, 4 downstream tasks, 111 scored runs. "Optimizer models differ more than the coding harnesses they run through." Native harnesses are not consistently better than a shared coding harness. Gains vary substantially across tasks and seed regimes. — [HarnessOpt-Bench](https://arxiv.org/abs/2608.06301)
- **MoMHa** (NeurIPS 2026 poster) extends Meta-Harness-style search to multiple objectives (accuracy, safety, tokens), using Claude Code as the proposer. No numbers were retrieved. — **[secondary: search excerpt]** [NeurIPS 2026](https://neurips.cc/virtual/2026/poster/153336)

### Inferences
- Patterns that recur across automated optimizers and are directly applicable to TrackAI:
  - Snapshot the environment before the first model call (Meta-Harness).
  - Use a granular, line-range view plus str_replace edit (DGM, Anthropic, SWE-agent).
  - Generate several candidates and rank them with a separate model, which is TrackAI's best-of-N plus blind reviewer (DGM, Trae Agent).
  - Condition retries on prior failed attempts (DGM).
  - Add a reflection/control layer grounded in environment feedback (HarnessEvo: the only slot that mattered).
- For a TrackAI self-optimization loop, the evidence says: give the proposer raw traces, not summaries (+15 pts median in Meta-Harness's ablation); prefer additive changes; and do not spread a small evaluation budget across many harness components at once (HarnessEvo).
- Optimized harnesses transferred across models in DGM, Meta-Harness math, and Harness² (GLM-5). That suggests harness gains found with a stronger model may partly carry over to an open model.

### Gaps
- Harness²'s per-model breakdown (GLM-5 vs Gemini 3.5 Flash) and its base harnesses were not in the abstract. The full paper is needed to see which configuration produced which gain.
- No ADAS numbers retrieved. No AlphaEvolve-style scaffold search for coding agents was found in this pass.
- Meta-Harness on Terminal-Bench 2.0 did not report an ablation of raw traces vs summaries; that ablation was run on text classification only.

## 4. Are harness gains larger for weaker / open models?

### Takeaway
Mostly yes in relative terms, with an important exception. Epoch states that scaffolds matter "especially on weaker models". On Terminal-Bench 2.0, the same 24-pt absolute spread means 2.7x for Haiku 4.5 but only 1.4x for Opus 4.6. Meta-Harness gained more on Haiku than on Opus. Open-model spreads are 13-15 pts (Kimi K2 Thinking on SWE-bench Verified; GLM-5.2 across four harnesses). However, complex or self-modifying scaffolds can **hurt** weak models badly (GPT-5-Nano: −30 pts in Live-SWE-agent). Open models fine-tuned on one scaffold's trajectories can collapse in a different scaffold, often because of tool-call format mismatches.

### Cited Findings
- Epoch AI (2025-12-23): "scaffolds have a huge impact on agentic benchmarks, especially on weaker models". The scaffold effect on SWE-bench Verified is up to 15 pts for the open Kimi K2 Thinking vs up to 11 for GPT-5. Providers were worse at serving newer open models such as GLM-4.6, and "bugs and instabilities in the chosen API provider are the biggest source of evaluation errors", particularly for newer models. — [Epoch AI](https://epochai.substack.com/p/why-benchmarking-is-hard)
- Meta-Harness, Terminal-Bench 2.0: the improvement over the next-best agent was larger on the weaker Haiku 4.5 (+2.1 pts) than on Opus 4.6 (+1.7 over Terminus-KIRA). Absolute spreads across harnesses are similar (Haiku 13.9 → 37.6; Opus 58.0 → 81.8), so the relative effect is much larger for the weaker model. — [Meta-Harness](https://arxiv.org/html/2603.28052v1)
- Meta-Harness math transfer: the largest gain was on the weakest baseline, GPT-5.4-nano (+8.7 from a base of 23.0). The pattern is not monotone, since GPT-5.4-mini gained only +1.6. — [Meta-Harness](https://arxiv.org/html/2603.28052v1)
- Live-SWE-agent ablation (50-task SWE-bench Verified subset), mini-SWE-agent → Live-SWE-agent with runtime tool creation: GPT-5-Nano 44.0 → 14.0 (−30); GPT-5-Mini 60.0 → 58.0 (−2); Claude 3.7 Sonnet 46 → 50; Claude 4 Sonnet 58 → 64; GPT-5 60 → 68; Claude 4.5 Sonnet 62 → 76 (+14). The authors attribute the Nano collapse to the model failing "to understand the goal of creating custom tools". On the full 500 tasks, gains were flat across models (+3.2 to +4.8). — [Live-SWE-agent](https://arxiv.org/html/2511.13646)
- DGM transfer: the discovered scaffold gave Claude 3.7 Sonnet +40.5 pts (19.0 → 59.5) but o3-mini only +10 (23.0 → 33.0). Here the stronger model gained more. — [DGM](https://arxiv.org/html/2505.22954)
- Open-model harness spread: GLM-5.2 on Terminal-Bench 2.1 ranged from 59.8% to 72.6% across four harnesses. Kimchi claims context management matters more for open-weight models. — **[vendor]** [Kimchi](https://kimchi.dev/blog/same-model-different-harness-terminal-bench)
- Harness² improved two non-frontier models, GLM-5 (open) and Gemini 3.5 Flash, by up to 11.5-11.8 pts with harness-only changes. — [Harness²](https://arxiv.org/abs/2610.14224)
- **DCAS** (Thangarajah, Chen, Hassan; arXiv 2608.06113, 2026-08-06). Open models fine-tuned on OpenHands trajectories "score well under OpenHands but degrade substantially" in other scaffolds, while untrained base models do not show this drop. Planning structure is scaffold-specific. Fine-tuning on a small set of planning-aware trajectories collected through DCAS improves performance consistently across non-training scaffolds. — [DCAS abstract](https://arxiv.org/abs/2608.06113). The specific figures are SWE-Lego-Qwen3-32B at 52.6% Pass@1 on SWE-bench Verified under OpenHands vs 8.4% under OpenCode, attributed to a tool-call output format its parser cannot read, and every fine-tuned model tested degrades on at least one non-training scaffold. — **[secondary]** [Developers Digest on DCAS](https://www.developersdigest.tech/blog/dcas-cli-scaffold-planning-transfer)
- Self-reported vs independent numbers for open models diverge: GLM-5 Terminal-Bench 2.0 is self-reported at 56.2 (Claude Code harness; 60.7-61.1 on a fixed or verified dataset) vs 49.44% independently with Terminus 2 on Vals.ai. — **[secondary: search excerpts]** [Vals.ai](https://vals.ai/benchmarks/terminal-bench-2)
- Small open models: inference-time scaffolding roughly doubled task completion in multi-step environments, from 5.4% to 8.9% (FP16) and 3.0% to 5.9% (AWQ). — **[secondary: search excerpt, not verified]** [arXiv 2604.11465](https://arxiv.org/html/2604.11465v1). A blog reports that a small-model-specific scaffold reached 45.56% on Aider Polyglot vs 19.11% for a matched-model Aider baseline. — **[secondary, blog, not verified]** [Itay Inbar, "Honey, I Shrunk the Coding Agent"](https://itayinbarr.substack.com/p/honey-i-shrunk-the-coding-agent)

### Inferences
- For TrackAI on glm-5.3-flash, a "flash"-tier open model, the evidence favours robustness features over autonomy features. Robustness features include tolerant parsing of tool calls (DCAS: format mismatch alone can drop scores by about 44 pts), early compaction and pruning of stale messages, sanitizing dangling tool calls, loop guards on repeated edit-run-fail cycles, and an environment snapshot at startup. Autonomy features such as runtime tool creation or self-modification hurt the weakest model in Live-SWE-agent by 30 pts.
- GLM-family models may carry conventions from the scaffolds their trajectories were collected in (DCAS's finding for OpenHands-tuned models). Z.ai reports GLM results in Claude Code and Terminus 2, so TrackAI's tool names, schemas, and edit format may score better if they resemble those harnesses. This is untested for glm-5.3-flash.
- Provider instability is a first-order variance source for open models (Epoch). TrackAI evals on Ollama cloud should log provider errors separately from agent failures. Otherwise harness changes will be confounded with serving noise.
- The weak-vs-strong picture is mixed. Simple, structure-adding harness features (bootstrap context, constrained edit, ranking) show equal or larger relative gains on weaker models. Capability-demanding features (DGM's multi-step tooling; Live-SWE-agent's self-made tools) gain more on strong models and can backfire on weak ones.

### Gaps
- I found no controlled study that runs one fixed set of harnesses across a ladder of model strengths on a coding benchmark and reports the interaction explicitly. Han & Sun (ICML 2026) report heterogeneous harness × LLM effects, but the abstract has no direction or numbers.
- No harness-comparison data exists for glm-5.3-flash specifically, or for any GLM model served via Ollama cloud. The closest are GLM-5 (Vals.ai, Z.ai) and GLM-5.2 (vendor-run Kimchi study).
- I could not open DCAS's full tables, so per-model, per-scaffold numbers other than the 52.6 → 8.4 example remain unverified.
