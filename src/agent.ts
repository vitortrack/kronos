import fs from 'node:fs';
import path from 'node:path';
import type { AgentUI } from './agent-ui.js';
import type { CheckResult } from './contract.js';
import { formatErrors, typeDiagnostics, typeErrors } from './diagnostics.js';
import { isJudged, orderedChecks } from './gate.js';
import { agentJudge } from './judge.js';
import { announcesNextAction, closestNames, LOOP_WARNING, LoopGuard } from './loop-guard.js';
import { mcpHub, type McpHub } from './mcp.js';
import { systemPrompt, type Role } from './prompts.js';
import { changedFiles, nestedInstructions, workspaceDiff } from './scope.js';
import type { Session } from './session.js';
import { isReadOnlyCommand } from './shell.js';
import { activeSkillsBlock } from './skills.js';
import { allTools, cleanPath, describeInput, offload, permit, suggestPath, toolLoader, type Tool, type ToolContext } from './tools.js';
import type { ContextUse, Image, Provider, StepResult, ToolCall, ToolResult } from './types.js';
import { validateInput } from './validate.js';

export type EndReason = 'success' | 'max_steps' | 'budget' | 'loop' | 'refusal' | 'aborted';

const researchOnly = (t: Tool): boolean => t.readOnly && !['delegate', 'update_plan', 'skill'].includes(t.name);

const ROLE_TOOLS: Record<Role, (t: Tool) => boolean> = {
  main: () => true,
  worker: (t) => t.name !== 'delegate',
  explorer: researchOnly,
  critic: (t) => researchOnly(t) || t.name === 'bash',
};

const PAGED_TOOLS = ['read_file', 'skill'];
const toolKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '');
const MAX_STOP_BLOCKS = 8;
const MAX_EMPTY_RETRIES = 2;
const MAX_CONTINUES = 2;
const MAX_REVIEWS = 2;
const MAX_JUDGE_REJECTIONS = 2;
const IDLE_AFTER_VERIFIED = 6;
const BUDGET_WARNING_AT = 0.85;

const EMPTY_REPLY = '[System: your last reply had no text and no tool call. Call a tool now, or give your final answer.]';
const CONTINUE = 'Please continue.';
const VERIFY_NUDGE =
  '[verification] You changed code but have not run anything since your last edit. Run the narrowest type-check, test or build that covers the change, read the whole output and fix what fails. If nothing in this project can be run, say so in the final answer.';
const IDLE_NUDGE = (steps: number): string =>
  `[progress] Your last edit was verified ${steps} steps ago and nothing changed since. If every requested item is done, call finish with the final report now. If something is still missing, change it now.`;
export const budgetWarning = (left: number, unverified: boolean): string =>
  unverified
    ? `[budget] Only ${left} steps left. Stop adding new work: run the check that covers your changes, fix what fails, then give the final report and list every requested item that is not done.`
    : `[budget] Only ${left} steps left. Give your final report now and list every requested item that is not done.`;
const HANDOFF_REQUEST =
  '[handoff] This run is ending. The next run continues from a note only, without your context. Write that note now, without calling tools, with exactly these sections:\n## State (what is done and verified, with file paths)\n## Decisions (choices made and why, constraints learned)\n## Tried and failed (each approach that did not work, with the exact error)\n## Next steps (what remains, in order)\nKeep exact paths, identifiers, commands and error strings.';
const ENDED: Record<Exclude<EndReason, 'success'>, (max: number) => string> = {
  max_steps: (max) => `Limite de ${max} passos atingido antes de concluir. Peça para continuar ou aumente --max-steps.`,
  budget: () => 'Orçamento de tokens atingido; parei para não gastar além do limite.',
  loop: () => 'Parei: o agente repetiu as mesmas chamadas sem progresso, mesmo depois do aviso.',
  refusal: () => 'O modelo recusou esta solicitação.',
  aborted: () => 'Interrompido pelo usuário.',
};

const FINISH_TOOL: Tool = {
  name: 'finish',
  readOnly: true,
  description:
    'End the task and deliver your final report. Call it when every requested item is done and verified, or when you cannot go further (say what is missing and why). The first call on a task that changed files shows you the diff and a short checklist; review it, fix anything wrong, then call finish again. Do not call other tools in the same turn. Example: {"report": "Filtered the device list by operator in src/devices.service.ts:40 and required the edit permission in src/devices.controller.ts:18. Verified with npx tsc --noEmit (exit 0)."}',
  schema: { type: 'object', properties: { report: { type: 'string', description: 'Final report for the user, in their language: what changed (files), how it was verified, assumptions and anything left open' } }, required: ['report'] },
  run: async () => '',
};
const FINISH_CHECKLIST = (diff: string): string =>
  `[finish] Before the task ends, review your changes below.
1. Every requested item is implemented and the check that covers it was run after the last edit.
2. Remove scratch files and debug output you created; do not leave unrequested changes.
3. Existing tests were not edited or skipped to make them pass.
If something is wrong, fix it now. If everything is right, call finish again with the final report.

${diff}`;

const readIfExists = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const isDocFile = (f: string): boolean => /\.(md|mdx|txt|rst)$/i.test(f);
const gateList = (results: CheckResult[]): string =>
  results.map((r) => `- ${r.criterion.text}\n  $ ${r.criterion.check}${r.pass ? '' : `\n  ${r.output.trim().slice(-600).replace(/\n/g, '\n  ') || '(no output)'}`}`).join('\n');

type Run = {
  task: string;
  request: string;
  stopBlocks: number;
  emptyRetries: number;
  continues: number;
  reviews: number;
  verifyNudged: boolean;
  approvedDiff: string | null;
  budgetWarned: boolean;
  idleNudges: number;
  finishReviewed: boolean;
};

export class Agent {
  private readonly provider: Provider;
  private readonly tools: Tool[];
  private readonly deferred: Tool[];
  private mcp: McpHub | null = null;
  private systemCache: { key: string; text: string } | null = null;
  private readonly files = new Map<string, number>();
  private readonly touched = new Set<string>();
  private readonly instructionsSeen = new Set<string>();
  private loopGuard = new LoopGuard();
  private step = 0;
  private verifiedSinceEdit = true;
  private lastEditStep = 0;
  private verifiedAt: number | null = null;
  private judgeRejections = 0;

  constructor(
    private readonly session: Session,
    readonly role: Role,
    private readonly ui: AgentUI,
    model?: string,
  ) {
    this.provider = session.newProvider(model);
    const only = session.cfg.tools;
    const available = allTools.filter((t) => ROLE_TOOLS[role](t) && (!only || only.includes(t.name)) && (t.name !== 'skill' || session.skills.length > 0));
    this.deferred = only ? [] : available.filter((t) => t.group);
    this.tools = available.filter((t) => !this.deferred.includes(t));
    if (this.deferred.length) this.tools.push(toolLoader(this.deferred, (names) => this.enable(names)));
    this.tools.push(FINISH_TOOL);
  }

  get canCompact(): boolean {
    return Boolean(this.provider.compactNow);
  }

  compactNow(signal: AbortSignal, focus?: string): Promise<boolean> {
    return this.provider.compactNow?.(signal, focus) ?? Promise.resolve(false);
  }

  contextUse(): ContextUse | null {
    return this.provider.contextUse?.() ?? null;
  }

  snapshot(): unknown {
    return this.provider.snapshot();
  }

  restore(state: unknown): void {
    this.provider.restore(state);
  }

  async run(task: string, images: Image[] = []): Promise<string> {
    const { text } = await this.loop(task, images);
    const file = this.role === 'main' ? this.session.cfg.handoff : undefined;
    if (file && !this.session.signal.aborted) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await this.note(task));
      this.session.log({ agent: this.role, event: 'handoff-saved', file });
    }
    return text;
  }

  private enable(names: string[]): void {
    for (const t of this.deferred) if (names.includes(t.name) && !this.tools.includes(t)) this.tools.push(t);
  }

  private async attachMcp(): Promise<void> {
    if (this.session.cfg.tools) return;
    const hub = await mcpHub(this.session.cfg.root);
    if (hub === this.mcp) return;
    const stale = new Set(this.mcp?.tools ?? []);
    this.mcp = hub;
    const keep = (list: Tool[]) => list.splice(0, list.length, ...list.filter((t) => !stale.has(t) && t.name !== 'load_tools'));
    keep(this.deferred);
    keep(this.tools);
    this.deferred.push(...hub.tools.filter(ROLE_TOOLS[this.role]));
    if (this.deferred.length) this.tools.push(toolLoader(this.deferred, (names) => this.enable(names)));
  }

  private get system(): string {
    const { root, lang, interactive = false } = this.session.cfg;
    const key = `${lang}|${interactive}|${[...this.session.activeSkills].join(',')}`;
    if (this.systemCache?.key !== key) {
      const skills = this.tools.some((t) => t.name === 'skill') ? this.session.skills : [];
      this.systemCache = { key, text: [systemPrompt(this.role, root, lang, interactive, skills), activeSkillsBlock(this.session.skills, this.session.activeSkills)].filter(Boolean).join('\n\n') };
    }
    return this.systemCache.text;
  }

  private opening(task: string): string {
    const { handoff, gate, harness, maxSteps } = this.session.cfg;
    if (this.role !== 'main') return task;
    const previous = handoff ? readIfExists(handoff) : null;
    const head = previous ? `<previous_handoff>\nNote left by the previous run on this work. Trust it instead of exploring again what it covers; re-read a file only right before you edit it.\n${previous.trim()}\n</previous_handoff>\n\n` : '';
    const block = harness?.trim() ? `<task_harness>\n${harness.trim()}\n</task_harness>\n\n` : '';
    const checks = gate?.length
      ? `\n\nDone means every check below exits 0 when run from the repository root; they run automatically when you finish. Implement the behavior they describe; do not write code just to satisfy a command.\n${gate.map((c) => `- ${c.text}\n  $ ${c.check}`).join('\n')}`
      : '';
    const budget = maxSteps > 0 ? `\n\nYou have up to ${maxSteps} steps (model calls) for this task.` : '';
    return `${head}${block}${task}${checks}${budget}`;
  }

  private async loop(task: string, images: Image[]): Promise<{ text: string; reason: EndReason }> {
    const { cfg } = this.session;
    const ctx = this.session.context(this.ui, this.files, task);
    const run: Run = {
      task,
      request: this.role === 'main' ? [...this.session.turns.map((t) => t.task), task].join('\n\n') : task,
      stopBlocks: 0,
      emptyRetries: 0,
      continues: 0,
      reviews: 0,
      verifyNudged: false,
      approvedDiff: null,
      budgetWarned: false,
      idleNudges: 0,
      finishReviewed: false,
    };
    this.verifiedAt = null;
    this.verifiedSinceEdit = true;
    this.touched.clear();
    this.loopGuard = new LoopGuard();
    await this.attachMcp();
    this.provider.addUser(this.opening(task), images);
    this.session.log({ agent: this.role, event: 'task', task });

    const end = (reason: EndReason, text: string) => {
      this.session.log({ agent: this.role, event: 'end', reason, steps: this.step, text });
      return { text, reason };
    };

    try {
      for (let step = 1; cfg.maxSteps <= 0 || step <= cfg.maxSteps; step++) {
        this.step = step;
        this.takeQueued(run);
        if (this.session.overBudget()) return end('budget', ENDED.budget(cfg.maxSteps));
        this.warnBudget(run);
        const early = new Map<ToolCall, Promise<ToolResult>>();
        this.ui.thinking('');
        const r = await this.provider.step({
          system: this.system,
          task: run.task,
          changedFiles: [...this.touched],
          tools: this.tools,
          signal: this.session.signal,
          onText: this.ui.text,
          onThinking: this.ui.thinking,
          onToolCall: (c) => {
            if (this.isRead(c)) early.set(c, this.call(c, ctx));
          },
        });
        this.session.addUsage(r.usage);
        this.ui.stepUsage?.(r.usage);
        if (r.compacted) {
          this.ui.info('contexto compactado: histórico antigo resumido, pedido original mantido');
          this.session.log({ agent: this.role, event: 'compacted', step });
        }
        this.session.log({ agent: this.role, event: 'step', step, stop: r.stop, text: r.text, toolCalls: r.toolCalls });
        if (r.stop === 'refusal') return end('refusal', ENDED.refusal(cfg.maxSteps));

        if (r.toolCalls.length === 0) {
          const followUp = await this.followUp(r, run);
          if (followUp) {
            this.provider.addUser(followUp);
            continue;
          }
          return end('success', r.text);
        }

        const finish = r.toolCalls.find((c) => c.name === 'finish');
        const others = r.toolCalls.filter((c) => c.name !== 'finish');
        const results = await this.execute(others, ctx, early);
        if (finish) {
          const report = String(finish.input.report ?? r.text);
          const reply = others.length ? 'Not finished: call finish alone, after the results of your other tool calls.' : await this.finishReply(run);
          this.ui.tool('finish', '');
          if (reply === null) {
            this.provider.addToolResults([...results, { id: finish.id, name: 'finish', output: 'Task finished.', isError: false }]);
            this.ui.text(report);
            return end('success', report);
          }
          results.push({ id: finish.id, name: 'finish', output: reply, isError: false });
        }
        this.provider.addToolResults(results);
        if (this.session.signal.aborted) return end('aborted', ENDED.aborted(cfg.maxSteps));
        const inputs = new Map(r.toolCalls.map((c) => [c.id, c.input]));
        const guard = results.map((x) => this.loopGuard.record(x.name, inputs.get(x.id), x.output, x.isError)).find((g) => g !== 'ok');
        if (guard === 'stop') return end('loop', ENDED.loop(cfg.maxSteps));
        if (guard === 'warn') {
          this.ui.warn('laço detectado: o agente foi avisado para mudar de abordagem');
          this.provider.addUser(LOOP_WARNING);
          continue;
        }
        const idle = this.idleNudge(run);
        if (idle) this.provider.addUser(idle);
      }
      const files = this.touched.size ? `\nArquivos alterados até aqui: ${[...this.touched].join(', ')}.` : '';
      return end('max_steps', ENDED.max_steps(cfg.maxSteps) + files);
    } catch (e) {
      if (this.session.signal.aborted) return end('aborted', ENDED.aborted(cfg.maxSteps));
      throw e;
    }
  }

  private takeQueued(run: Run): void {
    if (this.role !== 'main') return;
    for (const message of this.session.takeQueued()) {
      this.provider.addUser(`[message from the user while you work: it adds to or changes the request; follow it from now on]\n${message}`);
      run.task += `\n\n${message}`;
      run.request += `\n\n${message}`;
      this.session.log({ agent: this.role, event: 'queued-message', message });
    }
  }

  private warnBudget(run: Run): void {
    const max = this.session.cfg.maxSteps;
    if (run.budgetWarned || max <= 0 || this.step < Math.ceil(max * BUDGET_WARNING_AT)) return;
    run.budgetWarned = true;
    this.provider.addUser(budgetWarning(max - this.step + 1, !this.verifiedSinceEdit));
  }

  private idleNudge(run: Run): string | null {
    if (this.role !== 'main' || !this.touched.size || this.verifiedAt === null || this.verifiedAt < this.lastEditStep) return null;
    const idle = this.step - this.verifiedAt;
    if (idle < IDLE_AFTER_VERIFIED * (run.idleNudges + 1)) return null;
    run.idleNudges++;
    this.session.log({ agent: this.role, event: 'idle-nudge', idle });
    return IDLE_NUDGE(idle);
  }

  private async followUp(r: StepResult, run: Run): Promise<string | null> {
    if (r.stop === 'max_tokens') return 'Your reply was cut off by the output limit. Continue exactly where you stopped.';
    if (!r.text.trim() && run.emptyRetries < MAX_EMPTY_RETRIES) {
      run.emptyRetries++;
      return EMPTY_REPLY;
    }
    if (announcesNextAction(r.text) && run.continues < MAX_CONTINUES) {
      run.continues++;
      this.session.log({ agent: this.role, event: 'continue' });
      return CONTINUE;
    }
    if (this.role !== 'main' || run.stopBlocks >= MAX_STOP_BLOCKS) return null;
    const block = await this.completionBlock(run);
    if (block) run.stopBlocks++;
    return block;
  }

  private async finishReply(run: Run): Promise<string | null> {
    if (this.role === 'main' && this.touched.size && !run.finishReviewed) {
      run.finishReviewed = true;
      const diff = await workspaceDiff(this.session.cfg.root);
      this.session.log({ agent: this.role, event: 'finish-review' });
      const files = `Files you changed: ${[...this.touched].join(', ')}`;
      return FINISH_CHECKLIST(diff ? `${files}\n\`\`\`diff\n${diff.slice(0, 12_000)}\n\`\`\`` : files);
    }
    if (this.role !== 'main' || run.stopBlocks >= MAX_STOP_BLOCKS) return null;
    const block = await this.completionBlock(run);
    if (block) run.stopBlocks++;
    return block;
  }

  private async completionBlock(run: Run): Promise<string | null> {
    const { cfg } = this.session;
    if (cfg.gate?.length) {
      const judged = this.judgeRejections < MAX_JUDGE_REJECTIONS ? { request: run.task, judge: agentJudge(this.session) } : undefined;
      const results = await orderedChecks(cfg.root, cfg.gate, judged);
      if (results.some((x) => !x.pass && isJudged(x.criterion))) this.judgeRejections++;
      const failing = results.filter((x) => !x.pass);
      if (failing.length) {
        this.ui.info(`portão: ${failing.length} checagem(ns) falhando; o agente continua`);
        this.session.log({ agent: this.role, event: 'gate', failed: failing.length });
        return `[gate] ${results.length - failing.length}/${results.length} checks pass. You cannot finish yet. Fix each failing check below (implement the behavior, not code that only satisfies the command), then finish:\n${gateList(failing)}`;
      }
    }
    const codeTouched = [...this.touched].some((f) => !isDocFile(f));
    if (codeTouched && !this.verifiedSinceEdit && !run.verifyNudged) {
      run.verifyNudged = true;
      this.ui.info('verificação: pedindo para rodar testes ou build antes de concluir');
      this.session.log({ agent: this.role, event: 'verify-nudge' });
      return VERIFY_NUDGE;
    }
    if (!cfg.review || !this.touched.size || run.reviews >= MAX_REVIEWS) return null;
    const diff = await workspaceDiff(cfg.root);
    if (diff !== null && diff === run.approvedDiff) return null;
    run.reviews++;
    const verdict = await this.session.review(run.request, this.ui);
    if (verdict.approved) {
      run.approvedDiff = diff;
      this.ui.info('revisor aprovou o trabalho');
      return null;
    }
    this.ui.warn('o revisor pediu correções');
    return `An independent reviewer inspected the workspace and requested changes:\n\n${verdict.feedback}\n\nFix every valid point (say briefly why if you disagree with one), verify again, then give the final report.`;
  }

  private async note(task: string): Promise<string> {
    this.provider.addUser(HANDOFF_REQUEST);
    const r = await this.provider.step({ system: this.system, task, changedFiles: [...this.touched], tools: this.tools, signal: this.session.signal, onText: () => undefined, onThinking: () => undefined });
    this.session.addUsage(r.usage);
    const plan = this.session.plan.map((p) => `- [${p.status}] ${p.step}`).join('\n');
    const files = [...new Set([...this.touched, ...(await changedFiles(this.session.cfg.root))])];
    return `# Handoff\n\n## Plan\n${plan || '(none)'}\n\n## Files changed\n${files.join('\n') || '(none)'}\n\n${r.text.trim()}\n`;
  }

  private isRead(c: ToolCall): boolean {
    return Boolean(this.tools.find((t) => t.name === c.name)?.readOnly) && !(c.name === 'delegate' && c.input.role === 'worker');
  }

  private async execute(calls: ToolCall[], ctx: ToolContext, early: Map<ToolCall, Promise<ToolResult>>): Promise<ToolResult[]> {
    const done = new Map<ToolCall, ToolResult>();
    const reads = calls.filter((c) => this.isRead(c));
    (await Promise.all(reads.map((c) => early.get(c) ?? this.call(c, ctx)))).forEach((r, i) => done.set(reads[i]!, r));
    for (const c of calls) if (!done.has(c)) done.set(c, await this.call(c, ctx));
    return calls.map((c) => done.get(c)!);
  }

  private async call(c: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    let savedAs: string | undefined;
    const finish = (output: string, isError: boolean): ToolResult => {
      this.ui.observation(!isError, output);
      this.session.log({ agent: this.role, event: 'tool', name: c.name, input: c.input, isError, output: output.slice(0, 4000) });
      return { id: c.id, name: c.name, output, isError, ...(savedAs ? { savedAs } : {}) };
    };
    const tool = this.tools.find((t) => t.name === c.name);
    this.ui.tool(c.name, describeInput(c.input));
    if (!tool) {
      const names = this.tools.map((t) => t.name);
      return finish(`Tool "${c.name}" not found. Did you mean one of: ${closestNames(c.name, names).map((n) => `"${n}"`).join(', ')}? Available tools: ${names.join(', ')}.`, true);
    }
    const { error: invalid, ignored } = validateInput(tool, c.input);
    if (invalid) return finish(`Invalid arguments: ${invalid}. Fix the arguments and call the tool again.`, true);
    const note = ignored.length ? `\n[ignored unknown argument(s): ${ignored.join(', ')}; this tool accepts: ${Object.keys(tool.schema.properties).join(', ')}]` : '';
    try {
      if (ctx.signal.aborted) return finish('Interrupted by the user.', true);
      const denied = await permit(tool, c.input, ctx);
      if (denied) return finish(denied, true);
      const writes = (c.name === 'edit_file' || c.name === 'write_file') && typeof c.input.path === 'string';
      const file = writes ? cleanPath(String(c.input.path)) : null;
      const previous = file === null ? null : readIfExists(path.resolve(ctx.root, file));
      const blockingBefore = new Set(file === null || previous === null ? [] : typeErrors(ctx.root, file).filter((e) => e.blocking).map((e) => e.key));
      let output = await tool.run(c.input, ctx);
      if (!PAGED_TOOLS.includes(c.name)) {
        const off = await offload(output, ctx.root, `outputs/${this.session.id}/${c.name}-${c.id.replace(/[^\w-]/g, '')}.txt`);
        output = off.text;
        savedAs = off.file;
      }
      if (c.name === 'skill') output += this.loadSkillTools(String(c.input.name));
      if (file !== null) {
        const reverted = this.revertIfBroken(ctx, file, previous, blockingBefore);
        if (reverted) return finish(reverted, true);
        this.verifiedSinceEdit = false;
        this.lastEditStep = this.step;
        const diagnostics = typeDiagnostics(ctx.root, file);
        if (diagnostics) output += `\n\n${diagnostics}`;
      } else if (c.name === 'bash' && !isReadOnlyCommand(String(c.input.command ?? ''))) {
        this.verifiedSinceEdit = true;
      }
      if (c.name === 'bash' && this.touched.size && /^Exit code: 0$/m.test(output)) this.verifiedAt = this.step;
      if (!tool.readOnly && typeof c.input.path === 'string') this.touched.add(cleanPath(c.input.path));
      if ((c.name === 'read_file' || writes) && typeof c.input.path === 'string') {
        const rules = await nestedInstructions(ctx.root, cleanPath(c.input.path), this.instructionsSeen);
        if (rules) output += `\n\n${rules}`;
      }
      return finish(output + note, false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const hint = /ENOENT/.test(message) && typeof c.input.path === 'string' ? await suggestPath(ctx.root, c.input.path) : '';
      return finish(`Error: ${hint ? `File not found: ${String(c.input.path)}.${hint}` : message}`, true);
    }
  }

  private loadSkillTools(name: string): string {
    const wanted = (this.session.skills.find((s) => s.name === name)?.tools ?? []).map(toolKey);
    const names = this.deferred.filter((t) => wanted.includes(toolKey(t.name)) || wanted.includes(toolKey(t.group ?? ''))).map((t) => t.name);
    this.enable(names);
    return names.length ? `\n\n[tools] Loaded for this skill: ${names.join(', ')}.` : '';
  }

  private revertIfBroken(ctx: ToolContext, file: string, previous: string | null, blockingBefore: Set<string>): string | null {
    const introduced = typeErrors(ctx.root, file).filter((e) => e.blocking && !blockingBefore.has(e.key));
    if (!introduced.length) return null;
    const target = path.resolve(ctx.root, file);
    if (previous === null) {
      fs.rmSync(target, { force: true });
      ctx.files.delete(target);
    } else {
      fs.writeFileSync(target, previous);
      ctx.files.set(target, fs.statSync(target).mtimeMs);
    }
    return `Edit rejected and reverted: it introduces ${introduced.length} error(s) the type checker can see in this file alone:\n${formatErrors(introduced)}\nThe file is unchanged. Fix the edit (declare or import the missing names, close the syntax) and apply it again.`;
  }
}
