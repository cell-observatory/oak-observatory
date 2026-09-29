/**
 * The one gate between the runtime and the terminal.
 *
 * While the terminal is handed to a child process — `$EDITOR`, F1's `claude --resume`, ^Z — the
 * dashboard's async work keeps completing: a views payload lands, the debounced diff fetch resolves,
 * the window emits a resize. Every one of those used to paint a full frame straight over the child's
 * screen; the child repainted on its next event, and the two UIs interleaved into visible corruption.
 *
 * The runtime cannot stop the completions, and should not — the state they carry is wanted the
 * moment the child exits. So the BYTES stop here instead: while suspended, state may update, output
 * may not. `resume` opens the gate again and the caller paints exactly one fresh frame.
 *
 * The exit path (`restore`) deliberately does NOT go through this gate: it writes with
 * `fs.writeSync(1, …)` because handing the user back a working terminal outranks everything,
 * including a suspension in progress.
 */
export interface GatedWriter {
  /** Write a sequence to the terminal. Refused — no bytes, returns false — while suspended. */
  write(seq: string): boolean;
  /** Close the gate: the terminal now belongs to a child process. */
  suspend(): void;
  /** Open the gate: the terminal is ours again. */
  resume(): void;
  /** Whether the gate is closed right now. */
  suspended(): boolean;
}

export function createGatedWriter(sink: (seq: string) => void): GatedWriter {
  let closed = false;
  return {
    write(seq: string): boolean {
      if (closed) return false;
      sink(seq);
      return true;
    },
    suspend(): void {
      closed = true;
    },
    resume(): void {
      closed = false;
    },
    suspended(): boolean {
      return closed;
    },
  };
}
