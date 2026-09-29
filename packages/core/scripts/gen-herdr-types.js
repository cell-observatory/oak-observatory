#!/usr/bin/env node
// The schema has no method -> result links. This table is the protocol-22 dispatch contract;
// payloads themselves always come from the schema. Unknown methods/results fail regeneration.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const resultMethods = {
  pong: 'ping',
  ok: 'server.stop server.live_handoff product_announcement.dismiss release_notes.dismiss command.invoke workspace.report_metadata workspace.close tab.close agent.send_keys pane.edit_scrollback pane.input.set pane.send_text pane.send_keys pane.send_input pane.graphics.set pane.graphics.clear pane.report_agent pane.report_agent_session pane.report_metadata pane.clear_agent_authority pane.release_agent pane.close popup.close',
  config_reload: 'server.reload_config',
  agent_manifest_status: 'server.agent_manifests',
  agent_manifest_reload: 'server.reload_agent_manifests',
  notification_show: 'notification.show',
  client_window_title: 'client.window_title.set client.window_title.clear',
  client_shell_surface_set: 'client_shell.surface.set',
  session_snapshot: 'session.snapshot',
  workspace_created: 'workspace.create',
  workspace_list: 'workspace.list workspace.move workspace.move_block',
  workspace_info: 'workspace.get workspace.focus workspace.rename',
  worktree_list: 'worktree.list',
  worktree_created: 'worktree.create',
  worktree_opened: 'worktree.open',
  worktree_removed: 'worktree.remove',
  tab_created: 'tab.create',
  tab_list: 'tab.list tab.move',
  tab_info: 'tab.get tab.focus tab.rename',
  agent_list: 'agent.list',
  agent_info: 'agent.get agent.rename agent.focus agent.wait',
  agent_explain: 'agent.explain',
  agent_view: 'agent.view.set agent.view.clear',
  agent_started: 'agent.start',
  agent_prompted: 'agent.prompt',
  pane_info: 'pane.split pane.get pane.focus pane.rename pane.scroll',
  pane_list: 'pane.list',
  pane_current: 'pane.current',
  pane_swap: 'pane.swap',
  pane_move: 'pane.move',
  pane_zoom: 'pane.zoom',
  pane_layout: 'pane.layout',
  pane_process_info: 'pane.process_info',
  layout_export: 'layout.export',
  layout_apply: 'layout.apply',
  layout_split_ratio_set: 'layout.set_split_ratio',
  pane_neighbor: 'pane.neighbor',
  pane_edges: 'pane.edges',
  pane_focus_direction: 'pane.focus_direction',
  pane_resize: 'pane.resize',
  pane_selection: 'pane.selection.read',
  pane_copy_motion: 'pane.copy_motion',
  pane_copy_search: 'pane.copy_search',
  pane_link_activated: 'pane.link.activate',
  pane_link_resolved: 'pane.link.resolve',
  pane_read: 'pane.read agent.read',
  pane_graphics_info: 'pane.graphics.info',
  subscription_started: 'events.subscribe',
  wait_matched: 'events.wait',
  output_matched: 'pane.wait_for_output',
  integration_list: 'integration.list',
  integration_install: 'integration.install',
  integration_uninstall: 'integration.uninstall',
  plugin_linked: 'plugin.link',
  plugin_list: 'plugin.list',
  plugin_unlinked: 'plugin.unlink',
  plugin_enabled: 'plugin.enable',
  plugin_disabled: 'plugin.disable',
  plugin_action_list: 'plugin.action.list',
  plugin_action_invoked: 'plugin.action.invoke',
  plugin_log_list: 'plugin.log.list',
  plugin_pane_opened: 'plugin.pane.open',
  plugin_pane_focused: 'plugin.pane.focus',
  plugin_pane_closed: 'plugin.pane.close',
};

function generate(schema, version) {
  const definitions = new Map();
  // References in otherwise identical definitions differ only by their enclosing schema.
  const normalize = value => JSON.stringify(value).replace(/#\/schemas\/[^/]+\/\$defs\//g, '#/$defs/');
  for (const part of Object.values(schema.schemas)) {
    for (const [name, value] of Object.entries(part.$defs || {})) {
      if (definitions.has(name) && normalize(definitions.get(name)) !== normalize(value)) {
        throw new Error(`Conflicting schema definition: ${name}`);
      }
      definitions.set(name, value);
    }
  }

  function emit(value, level = 0) {
    if (value === true) return 'unknown';
    if (value === false) return 'never';
    const pieces = [];
    if (value.$ref) {
      const name = value.$ref.split('/').pop();
      if (!definitions.has(name)) throw new Error(`Unknown reference: ${value.$ref}`);
      pieces.push(name);
    }
    if ('const' in value) pieces.push(JSON.stringify(value.const));
    else if (value.enum) pieces.push(value.enum.map(v => JSON.stringify(v)).join(' | '));
    else if (Array.isArray(value.type)) {
      pieces.push(value.type.map(type => emit({ ...value, type }, level)).join(' | '));
    } else if (value.type === 'object' || value.properties || value.additionalProperties) {
      const fields = Object.entries(value.properties || {}).map(([key, v]) =>
        `${'  '.repeat(level + 1)}${JSON.stringify(key)}${value.required?.includes(key) ? '' : '?'}: ${emit(v, level + 1)};`);
      if (value.additionalProperties && value.additionalProperties !== false) {
        fields.push(`${'  '.repeat(level + 1)}[key: string]: ${emit(value.additionalProperties, level + 1)};`);
      }
      // Rust empty parameter structs reject no fields, but callers should pass an object.
      pieces.push(fields.length ? `{\n${fields.join('\n')}\n${'  '.repeat(level)}}` : 'Record<string, unknown>');
    } else if (value.type === 'array') {
      pieces.push(`Array<${emit(value.items ?? true, level)}>`);
    } else if (value.type) {
      if (!['integer', 'number', 'string', 'boolean', 'null'].includes(value.type)) throw new Error(`Unknown type: ${value.type}`);
      pieces.push(value.type === 'integer' ? 'number' : value.type);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (value[key]) pieces.push(value[key].map(v => `(${emit(v, level)})`).join(key === 'allOf' ? ' & ' : ' | '));
    }
    if (['not', 'if', 'prefixItems', 'patternProperties'].some(k => k in value)) throw new Error('Unsupported schema construct');
    return pieces.length > 1 ? pieces.map(v => `(${v})`).join(' & ') : pieces[0] || 'unknown';
  }

  const methods = schema.schemas.request.oneOf.map(v => v.properties.method.const);
  const results = new Map();
  const tags = new Set(definitions.get('ResponseResult').oneOf.map(v => v.properties.type.const));
  for (const [result, group] of Object.entries(resultMethods)) {
    if (!tags.has(result)) throw new Error(`Missing result: ${result}`);
    for (const method of group.split(' ')) {
      if (!methods.includes(method) || results.has(method)) throw new Error(`Unknown/duplicate method: ${method}`);
      results.set(method, result);
    }
  }
  for (const method of methods) if (!results.has(method)) throw new Error(`Map the result of new method: ${method}`);

  const lines = [
    `// Generated by npm run gen:herdr (packages/core). DO NOT EDIT.`,
    `// herdr ${version}; protocol ${schema.protocol}; schema version ${schema.schema_version}; JSON Schema 2020-12.`,
    `export type Protocol = ${schema.protocol};`,
  ];
  for (const [name, value] of [...definitions].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    lines.push(`export type ${name} = ${emit(value)};`);
  }
  for (const part of Object.values(schema.schemas)) {
    if (!definitions.has(part.title)) lines.push(`export type ${part.title} = ${emit(part)};`);
  }
  lines.push('export interface MethodParams {');
  for (const v of schema.schemas.request.oneOf) lines.push(`  ${JSON.stringify(v.properties.method.const)}: ${emit(v.properties.params)};`);
  lines.push('}', 'export interface MethodResults {');
  for (const method of methods) lines.push(`  ${JSON.stringify(method)}: Extract<ResponseResult, { type: ${JSON.stringify(results.get(method))} }>;`);
  lines.push('}', 'export type Method = keyof MethodParams;',
    'export type Params<M extends Method> = MethodParams[M];',
    'export type Result<M extends Method> = MethodResults[M];',
    'export type HerdrEvent = EventEnvelope | SubscriptionEventEnvelope;', '');
  return lines.join('\n\n').replace(/\n\n  /g, '\n  ');
}

async function main() {
  const binary = process.env.HERDR_BIN || 'herdr';
  const run = async args => (await promisify(execFile)(binary, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;
  const schema = JSON.parse(await run(['api', 'schema', '--json']));
  const version = (await run(['--version'])).trim().replace(/^herdr\s+/, '');
  const output = path.resolve(__dirname, '../src/herdr-api.d.ts');
  fs.writeFileSync(output, generate(schema, version));
  console.log(`Generated ${path.basename(output)}: herdr ${version}, protocol ${schema.protocol}, ${schema.schemas.request.oneOf.length} methods.`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { generate };
