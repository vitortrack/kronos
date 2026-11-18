const HISTORY = 25;
const MAX_PERIOD = 5;
const REPEATS_SAME = 4;
const REPEATS_SAME_ERROR = 3;
const REPEATS_CYCLE = 3;

type Seen = { key: string; error: boolean };

export class LoopGuard {
  private readonly seen: Seen[] = [];
  private warned = false;

  record(name: string, input: unknown, output: string, isError: boolean): 'ok' | 'warn' | 'stop' {
    this.seen.push({ key: `${name}:${JSON.stringify(input)}\n${output.replace(/^Wall time: .*$/m, '')}`, error: isError });
    if (this.seen.length > HISTORY) this.seen.shift();
    if (!this.stuck()) return 'ok';
    this.seen.length = 0;
    if (this.warned) return 'stop';
    this.warned = true;
    return 'warn';
  }

  private stuck(): boolean {
    const n = this.seen.length;
    const last = this.seen[n - 1]!;
    for (let period = 1; period <= MAX_PERIOD; period++) {
      const repeats = period > 1 ? REPEATS_CYCLE : last.error ? REPEATS_SAME_ERROR : REPEATS_SAME;
      if (n < period * repeats) continue;
      const tail = this.seen.slice(n - period * repeats);
      if (tail.every((s, i) => s.key === tail[i % period]!.key)) return true;
    }
    return false;
  }
}

export const LOOP_WARNING =
  '[loop] The same tool calls returned the same results several times in a row. Repeating them will not change the outcome. Step back: say in one sentence what you are trying to learn or change, then take a different action, or call finish if the work is done. Repeating the cycle again ends the task.';

export function closestNames(name: string, names: string[], max = 3): string[] {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = row[j]!;
        row[j] = next;
      }
    }
    return row[b.length]!;
  };
  const score = (candidate: string): number => distance(name, candidate) - (candidate.includes(name) || name.includes(candidate) ? 100 : 0);
  return [...names].sort((a, b) => score(a) - score(b)).slice(0, max);
}

const ANNOUNCES_ACTION =
  /\b(next|now),? i('ll| will)\b|\bi('ll| will) (now )?(edit|update|change|fix|add|create|run|check|implement|apply|write)\b|\b(agora|em seguida|a seguir),? vou\b|\bvou (agora )?(editar|alterar|corrigir|adicionar|criar|rodar|executar|implementar|aplicar|escrever)\b/i;

export const announcesNextAction = (text: string): boolean => ANNOUNCES_ACTION.test(text.trim().slice(-240));
