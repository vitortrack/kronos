export type JsonSchemaProp = {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: object;
};

export interface ToolSpec {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, JsonSchemaProp>;
    required: string[];
  };
}

export type Input = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  input: Input;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError: boolean;
  savedAs?: string;
}

export interface Usage {
  input: number;
  output: number;
  cost?: number;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal';

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage: Usage;
  compacted?: boolean;
}

export interface StepRequest {
  system: string;
  task?: string;
  changedFiles?: string[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText(delta: string): void;
  onThinking(delta: string): void;
  onToolCall?(call: ToolCall): void;
}

export interface Image {
  mime: string;
  data: string;
}

export interface ContextUse {
  used: number;
  limit: number;
  compactAt: number;
}

export interface Provider {
  addUser(text: string, images?: Image[]): void;
  addToolResults(results: ToolResult[]): void;
  step(req: StepRequest): Promise<StepResult>;
  snapshot(): unknown;
  restore(state: unknown): void;
  compactNow?(signal: AbortSignal, focus?: string): Promise<boolean>;
  contextUse?(): ContextUse | null;
}

export interface UsageBar {
  label: string;
  percent: number;
  detail: string;
  note: string;
}

export interface UsageReport {
  bars: UsageBar[];
  error?: string;
}
