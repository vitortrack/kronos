import type { Decision, PlanItem } from './tools.js';
import type { Usage } from './types.js';

export interface AgentUI {
  readonly text: (delta: string) => void;
  readonly thinking: (delta: string) => void;
  tool(name: string, args: string): void;
  observation(ok: boolean, output: string): void;
  stepUsage?(usage: Usage): void;
  plan(items: PlanItem[]): void;
  phase(title: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  final(text: string): void;
  confirm(question: string, signal: AbortSignal, alwaysLabel?: string): Promise<Decision>;
  child(label: string): AgentUI;
}
