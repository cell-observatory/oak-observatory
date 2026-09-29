/**
 * The oak CLI's own entry script, registered by the CLI once at startup. A detached refresh
 * (`oak titles --refresh --if-due`) is started only through this entry: a process that is not the oak
 * CLI — a test harness or probe that runs the terminal app on core directly, an editor host that loads
 * core — registers nothing, so it never relaunches ITSELF with refresh arguments it would ignore (one
 * such relaunch reran a test probe that kicked again, forever). No imports, so the CLI registers it at
 * startup without loading the rest of core on the capture hook's hot path.
 */
let entry: string | undefined;

export function setOakCliEntry(file: string | undefined): void {
  entry = file || undefined;
}

export function oakCliEntry(): string | undefined {
  return entry;
}
