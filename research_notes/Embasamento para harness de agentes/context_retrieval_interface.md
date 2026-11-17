# Measured effects of context management, retrieval, repository maps and tool-interface design in coding agents

Research date: 2026-11-09. Every number has its date, setup and URL. "pp" means percentage points. "Lite" means SWE-bench Lite (300 instances) and "Verified" means SWE-bench Verified (500 instances).

## Repository maps and code graphs (Aider repo map, RepoGraph, LocAgent, CodeCompass, Moatless): measured effects, and evidence that more repository context hurts

### Takeaway
Structural repo context helps when it is small and targeted at the task. RepoGraph's 1-hop subgraph (~2.3k tokens) added +2 to +2.7 pp on Lite. LocAgent's graph tools gave the best localization. Graph navigation gave +23 pp on hidden-dependency tasks. In every controlled study that varied the amount of context, more context made results worse. RepoGraph's 2-hop flattened view fell below the no-graph baseline. Raising SWE-bench's BM25 budget raised recall but lowered resolve rate. "Repository overviews" in AGENTS.md files did not help and raised cost by over 20%. This matches TrackAI's finding that the repo map caused scope creep on a realistic task.

### Cited Findings
**Aider repo map (how it works; Aider has published no ablation of it)**
- The map comes from a tree-sitter parse of definitions and references, ranked on a file-dependency graph. It lists only the most-referenced identifiers. Default budget `--map-tokens` = 1k tokens (post dated 2023-10-22). Aider reports no measured accuracy or token effect of the map — [Aider blog, Oct 2023](https://aider.chat/2023/10/22/repomap.html); [Aider docs](https://aider.chat/docs/repomap.html)
- The source code uses `networkx.pagerank` with personalization toward files in the chat, files mentioned in the request and path components that match mentioned identifiers. Edge weights:
  - mentioned identifiers ×10
  - long snake/camel/kebab identifiers (≥8 chars) ×10
  - `_private` identifiers ×0.1
  - identifiers defined in more than 5 files ×0.1
  - references coming from files in the chat ×50

  With no files in the chat, the budget grows up to 8× `map_tokens` (`map_mul_no_files=8`), capped at the context window minus 4096 — [aider/repomap.py (main branch, read 2026-11)](https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py)
- Aider scored 26.3% (79/300) on Lite on 2024-05-22 using the repo map, with no RAG, vector search or agentic tools. It alternated GPT-4o and Opus over up to 6 attempts, with lint and test checks. The file it chose to edit matched the gold patch in 70.3% of tasks. GPT-4o's first attempt alone resolved 20.3%; GPT-4o with the retry harness reached 25.0% — [Aider blog, May 2024](https://aider.chat/2024/05/22/swe-bench-lite.html)

**RepoGraph (arXiv 2410.14684, Oct 2024, revised Mar 2025): a line-level code graph added as a plug-in. Lite results**

| Base framework | Model | Resolve rate | Cost/instance | Tokens/instance | Relative gain |
|---|---|---|---|---|---|
| RAG | GPT-4 | 2.67% → 5.33% | $0.13 → $0.17 | — | +99.6% |
| Agentless | GPT-4o | 27.33% → 29.67% | $0.34 → $0.39 | 42.4k → 47.3k | +8.6% |
| AutoCodeRover | GPT-4 | 19.00% → 21.33% | $0.45 → $0.58 | — | +12.3% |
| SWE-agent | GPT-4o | 18.33% → 20.33% | $2.53 → $2.69 | 498k → 519k | +10.9% |
| Agentless | Claude-3.5-Sonnet | 27.67% → 30.33% | — | — | — |
| SWE-agent | Claude-3.5-Sonnet | 23.00% → 25.33% | — | — | — |

  The average relative gain across the four GPT frameworks is 32.8%. The Claude-3.5-Sonnet rows are from the paper's appendix. Source: [RepoGraph HTML v2](https://arxiv.org/html/2410.14684v2)
- **RepoGraph "too much context" ablation** (Agentless + GPT-4o; baseline without the graph = 27.33%). The full graph averages 1,419 nodes and 26,392 edges, so it is not usable directly. Source: [RepoGraph HTML v2](https://arxiv.org/html/2410.14684v2)

| Variant | Tokens | Resolve rate | vs baseline |
|---|---|---|---|
| 1-hop flattened | ~2,311 | 29.67% | best |
| 1-hop summarized | ~718 | 28.33% | below 1-hop flattened (information loss) |
| 2-hop flattened | ~10,505 | 26.00% | below baseline |
| 2-hop summarized | ~1,229 | 28.67% | partly recovers |

**LocAgent (arXiv 2503.09089, Mar 2025, revised Apr 2025): agent with a heterogeneous code graph and graph-search tools. Lite localization (file Acc@5 / function Acc@10)**

| Method | File Acc@5 | Function Acc@10 | Cost/instance |
|---|---|---|---|
| BM25 | 61.68% | 36.86% | — |
| E5-base-v2 | 80.29% | 51.09% | — |
| Jina-Code-v2 | 80.29% | 52.19% | — |
| CodeRankEmbed | 84.67% | 58.76% | — |
| Agentless (GPT-4o) | 74.45% | 55.47% | — |
| Agentless (Claude-3.5) | 79.56% | 58.76% | — |
| MoatlessTools (GPT-4o) | 85.04% | 59.49% | $0.46 |
| MoatlessTools (Claude-3.5) | 86.13% | 64.96% | $0.46 |
| SWE-agent (GPT-4o) | 68.98% | 46.35% | $0.56 |
| SWE-agent (Claude-3.5) | 90.15% | 64.60% | $0.67 |
| OpenHands (GPT-4o) | 73.72% | 50.36% | $0.83 |
| OpenHands (Claude-3.5) | 90.15% | 70.07% | $0.79 |
| LocAgent (Claude-3.5) | 94.16% | 77.37% | $0.66 |
| LocAgent (fine-tuned Qwen2.5-32B) | 92.70% | 77.01% | $0.09 |
| LocAgent (fine-tuned Qwen2.5-7B) | 88.32% | 71.53% | $0.05 |

  Source: [LocAgent HTML v2](https://arxiv.org/html/2503.09089v2)
- **LocAgent downstream resolution** (Lite): LocAgent (Claude-3.5) localization gives Pass@1 27.92% and Pass@10 37.59%, against Agentless 26.31% / 33.58%. The abstract claims a ~86% cost reduction against proprietary models and +12% Pass@10 — [LocAgent abs](https://arxiv.org/abs/2503.09089)

**CodeCompass (arXiv 2602.20048, Feb 2026; single author, not peer-reviewed)**
- Setup: a Neo4j dependency-graph MCP server (IMPORTS / INHERITS / INSTANTIATES edges) added to Claude Code. 30 tasks on the FastAPI RealWorld app; 258 of 270 trials completed.
- On hidden-dependency tasks (G3), CodeCompass reached 99.4% ACS (the paper's coverage metric), against 76.2% for vanilla Claude Code and 78.2% for BM25-augmented prompts.
- On keyword-findable tasks (G1), BM25 was best (100% vs 90% vanilla) and the graph added nothing.
- Per secondary summaries, 58% of trials that had graph access made zero graph-tool calls. The authors conclude that agents need explicit prompting to use graph tools.
- Sources: [arXiv 2602.20048](https://arxiv.org/abs/2602.20048v1); [HTML](https://arxiv.org/html/2602.20048v1) (the 58% figure came from search-result summaries and was not checked in the paper)

**Evidence that more context hurts**
- SWE-bench paper (ICLR 2024; arXiv Oct 2023). Claude 2 resolve rate with BM25 retrieval fell as the context budget grew, even though BM25 recall of the oracle files rose (Avg 29.58% → 44.41% → 51.06%):

| BM25 budget | Claude 2 resolve rate |
|---|---|
| 13k | 1.96% |
| 27k | 1.87% |
| 50k | 1.22% |

  The authors: "models become distracted by additional context and may be sensitive to the relative location of target sequences". Claude 2's performance "drops considerably" as total input length grows — [SWE-bench paper PDF](https://arxiv.org/pdf/2310.06770)
- SWE-bench, same paper. Claude 2 gets 4.80% with whole oracle files. "Oracle-collapsed" keeps the oracle files but shows only edited lines ±15. With that less-but-targeted view, Claude 2 rises to 5.93%; Claude 3 Opus gets 9.39% — [SWE-bench paper PDF](https://arxiv.org/pdf/2310.06770)
- "Evaluating AGENTS.md" (arXiv 2602.11988, Feb 2026, revised Sep 2026; ICLR 2026 listing):
  - Context files "do not generally improve task success rates", both LLM-generated and developer-committed.
  - They increase inference cost "by over 20% on average".
  - Agents do follow the instructions in them.
  - "Repository overviews are not helpful" even though model providers recommend them. Context files are useful only for non-standard practices. Source: [arXiv abs](https://arxiv.org/abs/2602.11988)
  - Secondary summaries report the mechanism: more exploration, testing and reasoning. LLM-generated files cost ~0.5 pp on SWE-bench Lite and ~2 pp on AgentBench; developer-written files slightly improve results. Agents tested: Claude Code (Sonnet 4.5), Codex (GPT-5.2, GPT-5.1 mini), Qwen Code (Qwen3-30B-Coder) — [ICLR listing](https://iclr.cc/virtual/2026/10021235); [HTML](https://arxiv.org/html/2602.11988v1)
- Contrasting efficiency result. "On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents" (arXiv 2601.20404, Jan 2026; 5-page ICSE JAWs workshop paper; 10 repos, 124 PRs):
  - Median runtime was 28.64% lower with an AGENTS.md file.
  - Median output tokens fell from 2,925 to 2,440 (−16.58%, Wilcoxon p<0.05).
  - Completion behavior stayed comparable.
  - [arXiv 2601.20404](https://arxiv.org/abs/2601.20404)

### Inferences
- TrackAI's result fits the published pattern. The pre-injected map helped small tasks (−20% steps) but caused scope creep on a realistic task. The same pattern appears in:
  - RepoGraph: 2-hop flattened (~10.5k tokens) fell below baseline; 1-hop (~2.3k tokens) helped.
  - SWE-bench: higher BM25 recall at a larger budget gave a lower resolve rate.
  - AGENTS.md study: repository overviews did not help, raised cost by >20% and drove more exploration.

  Agents treat injected context as something to act on, which fits "agents follow instructions in context files" in the AGENTS.md study.
- Lowest-risk direction for TrackAI, consistent with the evidence:
  1. Do not inject a global map in the first message. Offer it as an on-demand tool, which is how LocAgent and CodeCompass expose their graphs.
  2. Make it task-personalized, as Aider's PageRank does: ×10 for identifiers named in the request, ×50 for files already touched.
  3. Limit it to a 1-hop neighbourhood of files the request names or the agent has already opened, within about 1–2.5k tokens. That matches the RepoGraph 1-hop sweet spot and Aider's 1k default.
  4. Because ~58% of CodeCompass trials never called the graph tool, the tool description or prompt must say when to use it, for example "before editing a symbol, check who imports it".
- The "who-imports-whom" part of the map is the piece with measured value. The CodeCompass hidden-dependency result (+23 pp ACS) supports it. A ranked file list with exported symbols looks more like a "repository overview", which the AGENTS.md study found unhelpful. If the map stays, keep the dependency edges for files in scope and drop the global ranking.
- The SWE-bench results support restricting what the agent sees to edited regions ±15 lines. Oracle-collapsed beat whole oracle files (5.93% vs 4.80%). Paginated or windowed reads are the agent-side version of this.

### Gaps
- No controlled study was found that compares "repo map injected upfront" with "repo map as an on-demand tool" on scope creep (files touched outside the gold patch). TrackAI's internal experiment appears to be novel evidence.
- CodeRAG (graph-based retrieval) numbers were not collected in this session.
- Moatless Tools' own SWE-bench resolve numbers were not checked; only its localization accuracy and cost from the LocAgent table are given.
- Aider has published no ablation of map on vs off or of map size.
- No study measured these effects on GLM-family models specifically.

## Context engineering and compaction (Anthropic guidance, context rot, observation masking vs LLM summarization, memory for long-horizon agents)

### Takeaway
Long context degrades accuracy even when retrieval is perfect: 13.9–85% drops with irrelevant tokens masked out, and degradation on all 18 models in Chroma's tests. On SWE-bench Verified, simple observation masking (keep the last 10 observations, replace older ones with placeholders) roughly halves cost. Its solve rate matches LLM summarization. Summarization lengthens trajectories by about 13–15%. A hybrid (masking first, rare summaries) saves a further 7–11%.

### Cited Findings
**"The Complexity Trap" (JetBrains Research; arXiv 2508.21433)**
- Dates: v1 2025-08-29, v3 2025-10-27; NeurIPS'25 DL4C workshop.
- Setup: SWE-agent on Verified (n=500), turn limit 250.
  - Observation masking: rolling window M=10.
  - LLM summary: summarize N=21 turns, keep the last M=10.
  - Observation tokens make up ~84% of an average turn.
  - Source: [HTML v3](https://arxiv.org/html/2508.21433v3)
- Results by model (solve rate, cost/instance) — [HTML v3](https://arxiv.org/html/2508.21433v3):

| Model | Raw agent | Observation masking | LLM summary |
|---|---|---|---|
| Qwen3-Coder 480B | 53.4%, $1.29 | 54.8%, $0.61 (−52.7%) | 53.8%, $0.64 (−50.4%) |
| Gemini 2.5 Flash | 32.8%, $0.41 | 35.6%, $0.18 (−56.1%) | 36.0%, $0.24 (−41.5%) |
| Qwen3-32B | 17.0%, $1.12 | 15.0%, $0.55 (−50.9%) | 16.0%, $0.50 (−55.4%) |
| Qwen3-32B thinking | 23.0%, $0.51 | 24.6%, $0.46 (−9.8%) | 24.8%, $0.51 (0%) |
| Gemini 2.5 Flash thinking | 40.4% | 36.4% (−4.0 pp) | 31.4% (−9.0 pp) |

  - Gemini 2.5 Flash thinking is the only case where both strategies significantly lowered the solve rate.
  - Paired bootstrap (B=10,000): cost reductions are significant for every model except Qwen3-32B thinking. Solve-rate differences are not significant for Qwen3-32B, Qwen3-Coder or Gemini Flash without thinking.
- Trajectory elongation from summarization:
  - Gemini 2.5 Flash: mean 52 turns with LLM summary, vs 44 with masking and 50 raw.
  - Qwen3-Coder 480B: LLM summary is 15% longer than raw and 13% longer than masking.
  - The authors attribute this to summaries hiding signals that the agent should stop.
  - Summary calls cost 0.65–7.2% of total instance cost.
  - Source: [HTML v3](https://arxiv.org/html/2508.21433v3)
- Hybrid (Qwen3-Coder 480B, Verified-50; masking window W=10, summarize N=43 turns):
  - +2.6 pp solve rate over raw.
  - 7% cheaper than masking alone and 11% cheaper than LLM summary.
  - Reusing N=21 made the hybrid less cost-efficient.
  - On OpenHands, the masking window had to be retuned (M=58 is mentioned). Reusing the SWE-agent window degraded performance.
  - Source: [HTML v3](https://arxiv.org/html/2508.21433v3); [abs](https://arxiv.org/abs/2508.21433)

**Context degradation**
- Chroma "Context Rot" (published 2025-07-14): 18 LLMs (Anthropic, OpenAI, Google, Alibaba), 194,480 calls, 8 input lengths × 11 needle positions.
  - Performance becomes "increasingly unreliable as input length grows".
  - Lower needle-question similarity degrades faster.
  - 1 or 4 distractors lower accuracy, with 4 compounding the drop.
  - Shuffled haystacks beat coherent ones on all 18 models.
  - LongMemEval: focused prompts (~300 tokens) scored significantly higher than full prompts (~113k tokens) for every model. Exact accuracies appear only in charts.
  - Repeated-words task (25–10,000 words): degradation on all models.
  - Source: [Chroma Research](https://www.trychroma.com/research/context-rot)
- "Context Length Alone Hurts LLM Performance Despite Perfect Retrieval" (arXiv 2510.05381, 2025-10-06; Findings of EMNLP 2025). Five LLMs on math, QA and coding.
  - Performance drops 13.9–85% as input length grows, within the models' claimed context limits.
  - The drop persists when irrelevant tokens are replaced with whitespace, and even when they are fully masked.
  - "Recite-then-solve" (re-state the evidence first) improved GPT-4o by up to 4% on RULER.
  - Source: [arXiv abs](https://arxiv.org/abs/2510.05381)
- SWE-agent ablation (Lite, GPT-4 Turbo, 2024): keeping full history instead of collapsing observations older than the last 5 to one line lowered the resolve rate from 18.0% to 15.0% — [SWE-agent paper](https://arxiv.org/pdf/2405.15793)

**Guidance and memory**
- Anthropic, "Effective context engineering for AI agents" (2025-09-29). Recommendations:
  - Aim for "the smallest set of high-signal tokens".
  - Prefer just-in-time retrieval (paths and queries in context, content loaded by tools).
  - Claude Code's hybrid: CLAUDE.md loaded upfront, glob/grep on demand.
  - Compaction keeps architectural decisions and unresolved bugs and drops redundant tool outputs. Claude Code keeps the 5 most recently accessed files. Tune compaction for recall first, then precision. Tool-result clearing is the lightest form of compaction.
  - Structured note-taking (NOTES.md, to-do lists) for long tasks.
  - Sub-agents return condensed summaries of 1,000–2,000 tokens.
  - Keep tool sets small and non-overlapping.
  - The article publishes no controlled numbers.
  - Source: [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- ACON (arXiv 2510.00615, v1 2025-10-01, v3 2026-06; ICML 2026 listing). Learned context compression for long-horizon agents on AppWorld, OfficeBench and multi-objective QA:
  - Peak tokens −26–54% while improving task success over other compression baselines.
  - The compressor is distilled into smaller models. Smaller LMs gain up to +46% "by mitigating context distraction".
  - Source: [arXiv abs](https://arxiv.org/abs/2510.00615)

### Inferences
- For TrackAI, the evidence favors this order of operations:
  1. Observation masking/elision first, with a window of about 10 recent observations. It is cheap and preserved or beat summarization on 4 of 5 model configurations.
  2. Structured LLM compaction at 75% only as a rare fallback, which is the hybrid that saved another 7–11%.
  3. Treat summarization as the riskier step. It lengthened trajectories by 13–15%, and on a thinking model it cost 9 pp.

  The window must be tuned to TrackAI's own scaffold: the OpenHands window did not transfer from SWE-agent.
- glm-5.3-flash is a "flash"-class model. Smaller and flash models showed the largest sensitivity to context length (ACON's smaller-LM gains; 13.9–85% length-only drops), so keeping the context short is likely worth more for TrackAI than for frontier models. This is an inference; no GLM-specific measurement was found.
- The compaction prompt should explicitly keep "files touched + decisions + open bugs" (Anthropic). Keeping the agent's own task list or notes outside the window is a cheap complement.

### Gaps
- Chroma's exact focused vs full accuracy numbers are given only in charts, not in text.
- No study isolated "nested AGENTS.md loaded when a file is touched" (lazy loading). Evidence covers only upfront context files.
- No numbers were found for Cognition, Sourcegraph or Factory compaction designs.
- No published measurement was found for the 75% compaction threshold itself.

## Agent-computer interface design (SWE-agent ACI ablations, edit formats, CodeAct)

### Takeaway
Interface design has measured effects of several points on the same model.
- In SWE-agent (GPT-4 Turbo, Lite):
  - A 100-line windowed viewer beat both 30 lines and the full file by 3.7–5.3 pp.
  - Lint-gated edits added +3 pp; no edit command cost −7.7 pp.
  - A summarized search tool beat an iterative one by 6 pp.
  - The custom interface gave +64% relative over a shell-only agent.
- Edit format matters a lot: unified diffs reduced GPT-4 Turbo "laziness" 3× and scored 61% vs 20%. Disabling flexible patch application raised edit errors 9×.
- CodeAct reports up to +20% success over JSON/text actions.

### Cited Findings
**SWE-agent (arXiv 2405.15793, May 2024; NeurIPS 2024)**
- Main results ([paper PDF](https://arxiv.org/pdf/2405.15793)):
  - GPT-4 Turbo resolved 12.47% (286/2,294) of the full SWE-bench test set and 18.00% (54/300) of Lite, at ~$1.59–1.67/instance.
  - A RAG baseline on Lite scored 2.67%: SWE-agent costs 8–13× more and resolves 6.7× more.
  - A shell-only agent scored 11.00% on Lite (7.33% without a demonstration), so the custom interface gives +64% relative.
- Ablations: Lite, GPT-4 Turbo, full configuration = 18.0% — [paper PDF, Table 3](https://arxiv.org/pdf/2405.15793)

| Area | Variant | Resolve rate |
|---|---|---|
| Edit | edit with linting gate | 18.0% |
| Edit | edit without linting | 15.0% (−3.0) |
| Edit | no edit command | 10.3% (−7.7) |
| Search | summarized (list of matching files and counts) | 18.0% |
| Search | iterative (next/prev through matches) | 12.0% (−6.0) |
| Search | no search tool | 15.7% (−2.3) |
| File viewer | 30 lines | 14.3% (−3.7) |
| File viewer | 100 lines | 18.0% |
| File viewer | whole file | 12.7% (−5.3) |
| Context | last 5 observations kept, older ones collapsed | 18.0% |
| Context | full history | 15.0% (−3.0) |
| Prompt | without demonstration | 16.3% (−1.7) |

  Iterative search did worse than no search tool: agents page through every match "exhaustively", which exhausts the budget or context.
- Hyperparameter sweep on a SWE-bench dev subset:
  - GPT-4 Turbo, T=0: window 100 → 15.1%, window 200 → 10.8%.
  - Claude 3 Opus: window 100 → 8.1%, window 200 → 7.1%.
  - Source: [paper PDF, Table 5](https://arxiv.org/pdf/2405.15793)
- Edit recovery: 51.7% (1,185/2,294) of GPT-4 Turbo trajectories had at least one failed edit. An edit attempt eventually succeeds 90.5% of the time, but only 57.2% after one failed edit. The lint gate exists to stop cascading syntax errors — [paper PDF](https://arxiv.org/pdf/2405.15793)

**Edit formats**
- Aider "unified diffs" laziness benchmark (89 Python refactoring tasks; late 2023, gpt-4-1106-preview era) — [Aider docs](https://aider.chat/docs/unified-diffs.html):

| Model | SEARCH/REPLACE | Unified diff | Note |
|---|---|---|---|
| GPT-4 Turbo (gpt-4-1106-preview) | 20%, lazy comments on 12 tasks | 61%, lazy comments on 4 tasks | 3× less laziness |
| GPT-4 (gpt-4-0613) | 26% | 59% | 72% is the maximum possible given its 8k window |

  - Removing the "high-level diff" prompting: +30–50% editing errors.
  - Disabling flexible patching (tolerant application of imperfect hunks): 9× more editing errors (on the Exercism benchmark).
  - GPT is "terrible" with line numbers, so hunk line numbers are ignored.
- Diff-XYZ (JetBrains Research, arXiv 2510.12487, Oct 2025): 1,000 real edits from CommitPackFT; apply, anti-apply and diff-generation tasks. Formats: udiff, udiff-h (relaxed headers), udiff-l (explicit ADD/DEL/CON markers) and search-replace.
  - In v2, search-replace is the most effective format, especially for larger models and for generation.
  - The v1 abstract had found udiff formats better for apply/anti-apply.
  - Verbose udiff-l helps smaller models.
  - The best format depends on model size and task.
  - Sources: [arXiv v2 HTML](https://arxiv.org/html/2510.12487v2); [HF dataset](https://huggingface.co/datasets/JetBrains-Research/diff-xyz/blob/main/README.md)

**Code actions vs JSON**
- CodeAct (arXiv 2402.01030, Feb 2024, rev. Jun 2024; ICML 2024): across 17 LLMs on API-Bank and a new benchmark, Python code actions beat JSON/text tool calls by "up to 20% higher success rate" — [arXiv abs](https://arxiv.org/abs/2402.01030)

**Tool design guidance (Anthropic, qualitative)**
- Keep tools few and non-overlapping, with token-efficient outputs. "If a human can't tell which tool to use, the agent likely can't either" — [Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic's SWE-bench agent work: the team "spent more time optimizing tools than the overall prompt". Requiring absolute file paths removed relative-path errors. This is recalled from the appendix of [Building effective agents, Dec 2024](https://www.anthropic.com/engineering/building-effective-agents) and was not re-fetched in this session.

### Inferences
- TrackAI's edit tool already follows the pieces with measured value:
  - tolerant matching ≈ Aider's flexible patching (9× fewer errors)
  - syntax gate ≈ SWE-agent's lint gate (+3 pp)
  - search/replace-style edits ≈ the best format for larger models in Diff-XYZ v2

  The steep recovery drop after a failed edit (90.5% → 57.2%) supports making the "did you mean" hint show the nearest actual text with line numbers. A bare failure gives the agent nothing to recover with.
- Paginated `read_file`: a page of about 100 lines was best in 2024 (GPT-4T/Opus). 30 lines, 200 lines and the whole file were all worse. For TrackAI, a default page of about 100–200 lines with an explicit "N more lines" footer is the evidence-backed choice. Newer long-context models may tolerate larger pages; that is not measured.
- Search tools should return a compact summary: files and match counts, capped and paginated by explicit request. Avoid an interface that walks the agent through matches one by one (−6 pp in SWE-agent).
- CodeAct-style actions could help an open model with multi-step tool composition. The evidence is from 2024 general tool-use benchmarks, not repo editing.

### Gaps
- Aider's whole-file vs diff format numbers per model (from its older code-editing benchmark and the polyglot leaderboard) were not fetched.
- The CodeAct turn-reduction figure was not shown on the abstract page, so it is not cited.
- No recent (2025–2026) re-run of the SWE-agent ablations was found. The window and lint numbers are from GPT-4 Turbo and Claude 3 Opus.

## Retrieval for code agents: BM25 vs embeddings vs agentic grep-based search

### Takeaway
There is no clean winner. In LocAgent's head-to-head on Lite localization, embeddings beat BM25 by a wide margin: CodeRankEmbed 84.7% file Acc@5 vs BM25 61.7%. Agentic or graph-based navigation beat both (up to 94.2%). Cursor's A/B data shows semantic search combined with grep beats grep alone (+12.5% average accuracy). Anthropic's claim that agentic search beats RAG in Claude Code rests on internal evidence, not published tests. BM25 still wins on keyword-findable tasks (CodeCompass G1). Single-shot RAG with no agent loop is far behind (2.67% vs 18% Lite in 2024).

### Cited Findings
- Cursor, "Improving agent with semantic search" (2025-11-06). Offline evals: adding semantic search to grep raised answer accuracy by 12.5% on average (6.5–23.5% depending on the model).
  - Online A/B: +0.3% code retention; +2.6% on codebases with 1,000+ files. Without semantic search, dissatisfied follow-up requests rose 2.2%.
  - The embedding model was custom-trained on agent sessions, with LLM-ranked "most helpful content" as the training target.
  - Conclusion: grep and semantic search together give the best results.
  - Source: [Cursor blog](https://cursor.com/blog/semsearch)
- LocAgent comparison on Lite, file Acc@5 / function Acc@10 (Mar 2025): BM25 61.68% / 36.86%; E5-base-v2 80.29% / 51.09%; CodeRankEmbed 84.67% / 58.76%. Agentic: MoatlessTools (Claude-3.5) 86.13% / 64.96%; OpenHands (Claude-3.5) 90.15% / 70.07%; LocAgent 94.16% / 77.37% — [LocAgent HTML v2](https://arxiv.org/html/2503.09089v2)
- Anthropic / Claude Code: per secondary reports of Boris Cherny's statements (Latent Space podcast, May 2025, and X posts), early Claude Code used RAG with a local vector DB. Agentic search (glob/grep) "generally works better" and is simpler, with fewer security, staleness and reliability problems.
  - This is based on internal usage and benchmarks; no public controlled numbers exist.
  - Critics note that agentic search costs more tokens and latency.
  - Sources: secondary, [SmartScope summary](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/); [dev.to analysis](https://dev.to/chen115y/the-representation-problem-why-rag-vs-agentic-search-is-the-wrong-debate-4j8f)
- Anthropic's official position: "just-in-time" retrieval through tools is preferred for agents, and pre-inference embedding retrieval is "less suited". Claude Code uses a hybrid of CLAUDE.md upfront plus grep/glob — [Anthropic, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- CodeCompass (Feb 2026, 30 tasks, Claude Code): BM25-augmented prompting was best on keyword-findable tasks (100% vs 90% vanilla). It gave no gain on hidden-dependency tasks (78.2% vs 76.2%), where graph navigation reached 99.4% — [arXiv 2602.20048](https://arxiv.org/abs/2602.20048v1)
- Non-agentic BM25 RAG baseline: 2.67% (GPT-4 Turbo) and 4.33% (Claude 3 Opus) on Lite, vs SWE-agent's 18.00% (2024). BM25 at a 27k budget recalls only ~44% of the oracle files on average — [SWE-agent paper](https://arxiv.org/pdf/2405.15793); [SWE-bench paper](https://arxiv.org/pdf/2310.06770)
- An Amazon-affiliated study on general QA found agentic keyword search reaching ~94.5% of RAG's faithfulness. This is a general-QA result, not code, and was reported only in search summaries; it is not attributable to Anthropic — [SmartScope summary](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)

### Inferences
- TrackAI's design (hybrid BM25 + qwen3-embedding exposed as a tool, alongside grep) matches the best-supported setup: semantic search as an agent-callable tool that complements grep, as in Cursor's results. It should not be pre-injected RAG. Expected gain is modest and model-dependent (+6.5–23.5% in Cursor's evals). Cursor's gain partly comes from an embedding model trained on agent traces; an off-the-shelf qwen3-embedding may get less.
- Keep BM25 in the hybrid. It wins on exact identifiers and keywords. Embeddings win on conceptual localization (+23 pp file Acc@5 over BM25 in LocAgent). Graph or "who-imports-whom" navigation wins on hidden dependencies. Each fits a different query type, so the tool descriptions should say which to use when.

### Gaps
- There is no public controlled benchmark of Claude Code agentic search vs RAG. The claim rests on internal evidence reported second-hand.
- No measurement of qwen3-embedding specifically on code-agent retrieval was found.
- No measurement was found of combined BM25 + embedding (hybrid) vs either alone inside an agent loop. Cursor compares semantic + grep vs grep only.
- Sourcegraph and Cognition published no comparable numbers that could be found in this session.
