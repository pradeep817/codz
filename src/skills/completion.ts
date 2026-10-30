// Shell completion. `codz completion bash|zsh|fish` prints a script that calls
// the hidden `codz __complete <words...>` command, so all three shells share
// one implementation, including endpoint names, plan ids and config keys.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadMap, setCacheWrites, TOOL_DIR } from '../core/cache.ts';
import { CONFIG_FILE, loadConfig } from '../core/config.ts';
import { exists } from '../core/fsutil.ts';
import type { Adapter } from '../core/types.ts';
import { ALLOWED, knownKeys } from '../core/validateConfig.ts';
import { CHANGE_FLAGS, COMMAND_LIST, FLAGS, GLOBAL_FLAGS } from '../core/commands.ts';
import { TEMPLATES } from '../core/templates.ts';

export const SHELLS = ['bash', 'zsh', 'fish'] as const;

/** Commands, their subcommands and the flags each takes, from the command table. */
export const COMMANDS: Record<string, { subs?: Record<string, string[]>; flags?: string[] }> = {};
for (const c of COMMAND_LIST) {
  const flags = [...c.flags, ...(c.change ? CHANGE_FLAGS : [])].filter((f) => f.length > 1).map((f) => `--${f}`);
  const entry = (COMMANDS[c.cmd] ??= {});
  if (c.sub) (entry.subs ??= {})[c.sub] = flags;
  else entry.flags = flags;
}
const GLOBAL = GLOBAL_FLAGS.filter((f) => f.length > 1).map((f) => `--${f}`);

/** Flags whose value is a file or folder (the shell completes paths). */
const PATH_FLAGS = new Set(Object.entries(FLAGS).filter(([, f]) => f.path).map(([n]) => `--${n}`));
const VALUE_FLAGS = new Set(Object.entries(FLAGS).filter(([, f]) => f.value).map(([n]) => `--${n}`));
export const FILES = '__files__';

function endpointNames(root: string, adapter: Adapter): Promise<string[]> {
  return loadMap(root, adapter, loadConfig(root).conventions)
    .then(({ map }) => map.endpoints.map((e) => e.name))
    .catch(() => []);
}

function planIds(root: string): string[] {
  try {
    return readdirSync(join(root, TOOL_DIR, 'plans')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Candidates for the last word. `words` are the words after "codz", the last
 * one being the word under the cursor (possibly empty).
 */
export async function complete(words: string[], root: string, adapter: Adapter): Promise<string[]> {
  setCacheWrites(false);
  const cur = words[words.length - 1] ?? '';
  const prev = words[words.length - 2];
  const positional = words.slice(0, -1).filter((w, i, a) => !w.startsWith('-') && !(i > 0 && VALUE_FLAGS.has(a[i - 1])));
  const [cmd, sub] = positional;
  const spec = cmd ? COMMANDS[cmd] : undefined;
  const hasProject = exists(join(root, CONFIG_FILE));

  if (prev && VALUE_FLAGS.has(prev)) {
    if (PATH_FLAGS.has(prev)) return [FILES];
    const choices = FLAGS[prev.slice(2)]?.choices;
    if (choices) return choices;
    if (prev === '--architecture') return adapter.id === 'flutter' ? ['getx', 'riverpod', 'get_it'] : ['fetch-helper', 'plain-fetch'];
    if (prev === '--only' && cmd === 'doctor') return ['locales', 'api', 'urls', 'models'];
    if (prev === '--api' && hasProject) return endpointNames(root, adapter);
    return [];
  }
  if (cur.startsWith('-')) {
    const own = spec?.subs ? (sub ? spec.subs[sub] ?? [] : []) : spec?.flags ?? [];
    return [...new Set([...own, ...GLOBAL])];
  }
  if (!cmd) return Object.keys(COMMANDS);
  if (spec?.subs && !sub) return Object.keys(spec.subs);

  const argIndex = positional.length - (spec?.subs ? 2 : 1); // 0 = first argument after the (sub)command
  const kind = COMMAND_LIST.find((c) => c.cmd === cmd && c.sub === (spec?.subs ? sub : undefined))?.args;
  if (kind === 'template') return TEMPLATES.map((t) => t.id);
  if (kind === 'shell') return argIndex === 0 ? ['bash', 'zsh', 'fish'] : [];
  if (kind === 'endpoints' && hasProject) return endpointNames(root, adapter);
  if (cmd === 'api' && ['show', 'remove', 'rename', 'update', 'wire'].includes(sub) && argIndex === 0 && hasProject) return endpointNames(root, adapter);
  if (cmd === 'api' && (sub === 'import' || sub === 'sync') && argIndex === 0) return [FILES];
  if (cmd === 'mock' && sub === 'add' && hasProject) return endpointNames(root, adapter);
  if ((cmd === 'plans' && sub === 'show') || cmd === 'apply') return argIndex === 0 ? planIds(root) : [];
  if (cmd === 'config' && (sub === 'get' || sub === 'set') && argIndex === 0) return Object.keys(knownKeys(adapter.id));
  if (cmd === 'config' && sub === 'set' && argIndex === 1) return ALLOWED[adapter.id]?.[positional[2]] ?? [];
  if (cmd === 'theme' && sub === 'set' && argIndex % 2 === 0) return ['primary', 'secondary', 'accent', 'background', 'surface', 'error', 'radius', 'spacing', 'font'];
  return [];
}

export function completionScript(shell: string): string {
  if (shell === 'bash') {
    return `# codz completion for bash. Add to ~/.bashrc:  eval "$(codz completion bash)"
_codz() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" out
  out=$(codz __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
  if [ "$out" = "${FILES}" ]; then
    COMPREPLY=($(compgen -f -- "$cur"))
  else
    local IFS=$'\\n'
    COMPREPLY=($(compgen -W "$out" -- "$cur"))
  fi
}
complete -o default -F _codz codz
`;
  }
  if (shell === 'zsh') {
    return `#compdef codz
# codz completion for zsh. Add to ~/.zshrc (after compinit):  source <(codz completion zsh)
_codz() {
  local -a out
  out=("\${(@f)$(codz __complete "\${words[@]:1:$((CURRENT-1))}" 2>/dev/null)}")
  if [[ "\${out[1]}" == "${FILES}" ]]; then
    _files
  else
    compadd -a out
  fi
}
compdef _codz codz
`;
  }
  return `# codz completion for fish. Save as ~/.config/fish/completions/codz.fish:
#   codz completion fish > ~/.config/fish/completions/codz.fish
function __codz_complete
  set -l out (codz __complete (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)
  if test "$out" = "${FILES}"
    __fish_complete_path (commandline -ct)
  else
    printf '%s\\n' $out
  end
end
complete -c codz -f -a '(__codz_complete)'
`;
}
