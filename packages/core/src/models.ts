/**
 * Local-model onboarding: what is served here, what the harness is wired to, and the one-command
 * switch between them.
 *
 * The observatory observes AGENTS; models are the agent's own concern — which is why "a user pulls
 * a new model" needs nothing reinstalled: hooks and capture are model-independent, and the listing
 * below reads ollama LIVE, so a model pulled five seconds ago is already in it. What DOES need a
 * hand is the wiring: codex names its model in `~/.codex/config.toml`, and editing another agent's
 * config is done with the Orca manners (surgical line replacement, a `.bak`, everything else
 * byte-for-byte) — the same rules the hooks installer follows (no
 * API keys exist here; open-weight models over local ollama are the whole test bed, so switching
 * between them must be one command).
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { codexConfigTomlPath, codexHome } from './codex';

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  modifiedTs: number;
}

/** Parse ollama's /api/tags body. Split from the fetch so a unit test needs no server. */
export function parseOllamaTags(body: string): OllamaModel[] {
  try {
    const doc = JSON.parse(body) as { models?: { name?: unknown; size?: unknown; modified_at?: unknown }[] };
    return (Array.isArray(doc.models) ? doc.models : [])
      .filter((m) => typeof m.name === 'string')
      .map((m) => ({
        name: m.name as string,
        sizeBytes: Number(m.size ?? 0) || 0,
        modifiedTs: m.modified_at ? Date.parse(String(m.modified_at)) || 0 : 0,
      }))
      .sort((a, b) => b.modifiedTs - a.modifiedTs);
  } catch {
    return [];
  }
}

export const OLLAMA_URL = 'http://127.0.0.1:11434';

/** The machine's served models, newest pull first — or null when ollama is not answering (which is
 *  an ANSWER, not an error: the caller says "ollama is not running" instead of "no models"). */
export function listOllamaModels(timeoutMs = 2500): Promise<OllamaModel[] | null> {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_URL}/api/tags`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(parseOllamaTags(body)));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** What codex is wired to right now, read straight off its config (line-scan — no TOML dependency,
 *  and no rewrite risk on the read path). */
export function codexConfiguredModel(): { model: string | null; provider: string | null } {
  try {
    const text = fs.readFileSync(codexConfigTomlPath(), 'utf8');
    const top = text.split(/^\s*\[/m)[0]; // top-level keys only — a [profile.x] model is not the default
    const model = /^\s*model\s*=\s*"([^"]*)"/m.exec(top)?.[1] ?? null;
    const provider = /^\s*model_provider\s*=\s*"([^"]*)"/m.exec(top)?.[1] ?? null;
    return { model, provider };
  } catch {
    return { model: null, provider: null };
  }
}

/**
 * What already chooses codex's model, or null when nothing does — the only case plain `oak init`
 * wires a local model. A choice is any top-level `model`, `model_provider` or `profile` key, a
 * `[profiles.*]` table, or a profile file `<name>.config.toml` beside config.toml (codex 0.156 reads
 * profiles there). Top-level keys also apply under `--profile`, so wiring `model_provider = "ollama"`
 * next to a profile's model sends that model to ollama (executed with codex 0.156.1).
 */
export function codexModelChoice(): string | null {
  let text = '';
  try {
    text = fs.readFileSync(codexConfigTomlPath(), 'utf8');
  } catch {
    /* no config yet */
  }
  const top = text.split(/^\s*\[/m)[0];
  const key = /^\s*(model|model_provider|profile)\s*=\s*(.*?)\s*(?:#.*)?$/m.exec(top);
  if (key) return key[1] === 'model' ? key[2].replace(/^"(.+)"$/, '$1') : `set by ${key[1]} = ${key[2]}`;
  if (/^\s*\[\s*profiles\b/m.test(text) || /^\s*profiles\s*\./m.test(top)) return 'set by a [profiles] table';
  let files: string[] = [];
  try {
    files = fs.readdirSync(codexHome());
  } catch {
    /* no codex home yet */
  }
  const profile = files.find((f) => f !== 'config.toml' && f.endsWith('.config.toml'));
  return profile ? `set by the profile file ${profile}` : null;
}

/** Trails the two lines plain `oak init` writes, so `oak uninstall` can find and remove exactly
 *  them. A later `oak models use` rewrites both lines without it: the choice is then the user's. */
export const CODEX_MODEL_MARKER = '# added by oak init; oak uninstall removes it';

/**
 * Pure config surgery for `wireCodexModel`, exported for tests: replace the top-level `model` /
 * `model_provider` lines in place when present, append them when absent, and touch NOTHING else —
 * comments, foreign tables and ordering survive byte-for-byte.
 */
export function rewireCodexConfigText(text: string, model: string, marker = ''): string {
  const tail = marker ? ` ${marker}` : '';
  const lines = text.length ? text.split('\n') : [];
  let inTable = false;
  let sawModel = false;
  let sawProvider = false;
  const out = lines.map((line) => {
    if (/^\s*\[/.test(line)) inTable = true; // top-level keys end at the first table header
    if (inTable) return line;
    if (/^\s*model\s*=/.test(line)) {
      sawModel = true;
      return `model = "${model}"${tail}`;
    }
    if (/^\s*model_provider\s*=/.test(line)) {
      sawProvider = true;
      return `model_provider = "ollama"${tail}`;
    }
    return line;
  });
  const missing: string[] = [];
  if (!sawModel) missing.push(`model = "${model}"${tail}`);
  if (!sawProvider) missing.push(`model_provider = "ollama"${tail}`);
  if (missing.length) {
    // Appended keys must stay TOP-LEVEL: splice them in before the first table header, never after
    // it (a `model =` under `[hooks.state.…]` would be that table's key, silently ignored).
    const firstTable = out.findIndex((l) => /^\s*\[/.test(l));
    const at = firstTable === -1 ? out.length : firstTable;
    out.splice(at, 0, ...missing);
  }
  return oneFinalNewline(out.join('\n'));
}

/** `text` ending in exactly one newline. A loop: `.replace(/\n*$/, '\n')` retried the end-of-text
 *  test from every newline of a run, quadratic in a long run of blank lines. */
function oneFinalNewline(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end--;
  return text.slice(0, end) + '\n';
}

export interface WireResult {
  changed: boolean;
  previous: string | null;
  backupPath?: string;
}

/** Point codex at a local model (provider: ollama's built-in). The Orca manners, as everywhere.
 *  `byInit` marks the lines as plain `oak init`'s, for `oak uninstall`. The backup has its own name:
 *  the hook installer's `config.toml.bak`, written earlier in the same `oak init`, must survive. */
export function wireCodexModel(model: string, byInit = false): WireResult {
  const p = codexConfigTomlPath();
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    /* a fresh codex home — created below */
  }
  const previous = codexConfiguredModel().model;
  const next = rewireCodexConfigText(text, model, byInit ? CODEX_MODEL_MARKER : '');
  if (next === text) return { changed: false, previous };
  let backupPath: string | undefined;
  if (text.length) {
    backupPath = `${p}.oak-model.bak`;
    fs.copyFileSync(p, backupPath);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, next);
  return { changed: true, previous, backupPath };
}

/** `oak uninstall`: remove the top-level lines plain `oak init` wired (see CODEX_MODEL_MARKER) and
 *  return the model they named, or null when none are left. */
export function unwireCodexModel(): string | null {
  const p = codexConfigTomlPath();
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  let inTable = false;
  let removed = false;
  let model: string | null = null;
  const kept = text.split('\n').filter((line) => {
    if (/^\s*\[/.test(line)) inTable = true;
    if (inTable || !line.endsWith(` ${CODEX_MODEL_MARKER}`)) return true;
    model = /^\s*model\s*=\s*"([^"]*)"/.exec(line)?.[1] ?? model;
    removed = true;
    return false;
  });
  if (!removed) return null;
  // Trailing blank lines collapse to one newline, as the wiring wrote the file.
  fs.writeFileSync(p, oneFinalNewline(kept.join('\n')));
  return model ?? 'ollama';
}
