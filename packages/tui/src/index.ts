/**
 * The terminal app — the observatory's third front end, beside the VS Code and JetBrains extensions.
 *
 * Everything here is about DRAWING and DRIVING a terminal: the frame, the layout, the glyph sets, the
 * key decoder, the options screen and the two runtime halves (`runTui`, and the backend that spawns
 * the CLI for its data). Nothing here knows how to read a store or parse a transcript — that is
 * `@oak-observatory/core`, which this package consumes exactly as the two editors do.
 *
 * It lives apart from `oak` (the CLI) so the product's four surfaces are visible at a
 * glance in `packages/`: core, cli, tui, vscode, jetbrains.
 */
export * from './textwidth';
export * from './glyphs';
export * from './input';
export * from './writer';
export * from './layout';
export * from './tree';
export * from './native';
export * from './pointer';
export * from './changemap';
export * from './richdiff';
export * from './statusline';
export * from './syntax';
export * from './options';
export * from './frame';
export { runTui, helpLines, COMMANDS } from './app';
export { createBackend } from './backend';
export * from './server';

export * from './observatory';
export * from './observatory-rows';
export * from './observatory-runtime';
