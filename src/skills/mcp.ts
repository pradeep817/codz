// codz mcp: a Model Context Protocol server on stdio, so AI agents and
// editors can call codz as tools.
//
// Every command in the command table becomes a tool (api add → api_add) whose
// input is its options plus the positional arguments. Tools run the codz
// CLI itself with --json, in the project folder, so they behave exactly like
// the command line. Commands that edit code never write: they return the diff
// and a plan id, and the `apply` tool applies that plan exactly as shown.
//
// Resources: codz://project (what codz knows about the project) and
// codz://commands (every command and option, as markdown).

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CHANGE_FLAGS, COMMAND_LIST, FLAGS, GLOBAL_FLAGS, renderMarkdown, type CommandSpec } from '../core/commands.ts';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** Commands that make no sense as tools: they need a terminal, or set up codz itself. */
const NOT_TOOLS = new Set(['completion', 'init', 'mcp', 'login', 'logout']);

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: false; required?: string[] };
  spec: CommandSpec;
}

export function toolName(spec: CommandSpec): string {
  return `${spec.cmd}${spec.sub ? `_${spec.sub}` : ''}`.replace(/-/g, '_');
}

export function mcpTools(): McpTool[] {
  const tools: McpTool[] = [];
  for (const spec of COMMAND_LIST) {
    if (NOT_TOOLS.has(spec.cmd)) continue;
    const properties: Record<string, unknown> = {};
    if (spec.usage.replace(/\[?--[^\]]*\]?/g, '').trim()) properties.args = { type: 'array', items: { type: 'string' }, description: `Positional arguments: ${spec.usage}` };
    for (const f of spec.flags) {
      if (CHANGE_FLAGS.includes(f) || GLOBAL_FLAGS.includes(f) || f.length === 1) continue;
      const def = FLAGS[f];
      const description = def.desc + (def.choices ? ` (${def.choices.join(', ')})` : '');
      properties[f] = def.value ? (def.repeat ? { type: 'array', items: { type: 'string' }, description } : { type: 'string', description }) : { type: 'boolean', description };
    }
    if (spec.cmd === 'apply') {
      properties['allow-dirty'] = { type: 'boolean', description: FLAGS['allow-dirty'].desc };
      properties['no-verify'] = { type: 'boolean', description: FLAGS['no-verify'].desc };
    }
    const writes = spec.change && !(spec.cmd === 'doctor');
    tools.push({
      name: toolName(spec),
      description: `${spec.summary}.${writes || spec.cmd === 'new' ? ' Returns the diff and a plan id; nothing is written until you call apply with that id.' : ''}${spec.cmd === 'new' ? ' Paid starters are never downloaded from here: the user downloads one once in a terminal (codz new or starters show), then it can be planned.' : ''}${spec.cmd === 'doctor' ? ' With fix: true it returns a plan to apply instead of reporting.' : ''}${spec.notes?.length ? ` ${spec.notes.join(' ')}` : ''}`,
      inputSchema: { type: 'object', properties, additionalProperties: false },
      spec,
    });
  }
  return tools;
}

/** The CLI arguments for a tool call. Change commands always get --plan, so a tool never writes by itself. */
export function cliArgs(tool: McpTool, input: Record<string, unknown>): string[] {
  const { spec } = tool;
  const out = [spec.cmd, ...(spec.sub ? [spec.sub] : [])];
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  // A positional argument that looks like an option (--cwd, --yes, --force, --root) would let a tool call widen what it
  // may do. Options only come through the schema's named properties, which are checked below.
  const flagLike = args.find((a) => a.startsWith('-'));
  if (flagLike) throw new Error(`Positional arguments cannot start with "-" (got "${flagLike.slice(0, 40)}"); pass options as named properties.`);
  out.push(...args);
  for (const [k, v] of Object.entries(input)) {
    if (k === 'args' || v === undefined || v === null || v === false) continue;
    if (!(k in (tool.inputSchema.properties as object))) throw new Error(`Unknown argument "${k}" for ${tool.name}.`);
    if (v === true) out.push(`--${k}`);
    else if (Array.isArray(v)) for (const x of v) out.push(`--${k}`, String(x));
    else out.push(`--${k}`, String(v));
  }
  // codz new only ever plans from an agent; a person applies (and a paid starter must already be downloaded).
  if (spec.cmd === 'new') out.push('--plan');
  if (spec.change && spec.cmd !== 'apply' && !(spec.cmd === 'doctor' && input.fix !== true) && !(spec.cmd === 'api' && spec.sub === 'sync' && input.check === true)) out.push('--plan');
  out.push('--json', '--no-color');
  return out;
}

const BIN = fileURLToPath(new URL('../../bin/codz.js', import.meta.url));

function runCli(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', input: '', env: { ...process.env, NO_COLOR: '1', CODZ_MCP: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface Request {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** Handles one message; returns the response, or null for notifications. */
export function handleMessage(msg: Request, cwd: string, version: string, tools = mcpTools()): object | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined) return null; // notifications (initialized, cancelled) need no answer
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'codz', version },
        instructions: 'codz understands this Next.js or Flutter project and changes it deterministically. Start with explain. Tools that edit code return a diff and a planId; review it, then call apply with the planId. Use dry runs freely: nothing is written until apply.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(msg.params?.name)}`);
      let args: string[];
      try {
        args = cliArgs(tool, (msg.params?.arguments as Record<string, unknown>) ?? {});
      } catch (e) {
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
      const r = runCli(args, cwd);
      let isError = r.code !== 0;
      let text = r.stdout.trim();
      try {
        const json = JSON.parse(text);
        // A failed check (exit 1) is still a useful answer; only {"ok": false} is an error.
        isError = json.ok === false;
        text = JSON.stringify(json, null, 2);
      } catch {
        text = [text, r.stderr.trim()].filter(Boolean).join('\n') || `codz exited with code ${r.code}`;
      }
      return reply({ content: [{ type: 'text', text }], isError });
    }
    case 'resources/list':
      return reply({
        resources: [
          { uri: 'codz://project', name: 'Project map', description: 'Framework, conventions, endpoints, models, routes and locales codz found', mimeType: 'application/json' },
          { uri: 'codz://commands', name: 'codz commands', description: 'Every command and option', mimeType: 'text/markdown' },
        ],
      });
    case 'resources/read': {
      const uri = String(msg.params?.uri ?? '');
      if (uri === 'codz://commands') return reply({ contents: [{ uri, mimeType: 'text/markdown', text: renderMarkdown(version) }] });
      if (uri === 'codz://project') {
        const r = runCli(['explain', '--json', '--no-color'], cwd);
        return reply({ contents: [{ uri, mimeType: 'application/json', text: r.stdout.trim() || r.stderr.trim() }] });
      }
      return fail(-32002, `Unknown resource: ${uri}`);
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Runs the server until stdin closes. Logs go to stderr; stdout carries only protocol messages. */
export function serveMcp(cwd: string, version: string): Promise<number> {
  const tools = mcpTools();
  process.stderr.write(`codz mcp: serving ${tools.length} tools for ${cwd}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Request;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = handleMessage(msg, cwd, version, tools);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  return new Promise((resolve) => rl.on('close', () => resolve(0)));
}
