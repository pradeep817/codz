// codz for VS Code. Runs the codz CLI (--json) in the workspace folder:
// every change is previewed as a diff and applied only when you click Apply,
// and doctor findings show up in the Problems panel.
//
// No dependencies besides VS Code itself; codz must be on PATH or set in
// the "codz.path" setting.

'use strict';

const vscode = require('vscode');
const { execFile } = require('node:child_process');
const path = require('node:path');

const SCHEME = 'codz-plan';
const plans = new Map(); // uri path → diff text

/** Runs codz with --json in `cwd`; resolves with the parsed JSON (or rejects with its message). */
function runCodz(args, cwd, bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args, '--json', '--no-color'], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        if (err && err.code === 'ENOENT') return reject(new Error(`codz was not found ("${bin}"). Install it, or set "codz.path" in your settings.`));
        return reject(new Error((stderr || stdout || String(err)).trim()));
      }
      if (json.ok === false) return reject(new Error(`${json.error.message}${json.error.hint ? `\n${json.error.hint}` : ''}`));
      resolve(json);
    });
  });
}

/** Doctor findings → { file, line, severity, message } for diagnostics (line is 0-based). */
function findingsToProblems(findings) {
  return (findings || [])
    .filter((f) => f.file)
    .map((f) => ({ file: f.file, line: Math.max(0, (f.line || 1) - 1), severity: f.severity, message: `${f.message}${f.fix ? `\nFix: ${f.fix}` : ''}`, source: `codz (${f.check})` }));
}

/** The whole change as one diff document. */
function planText(changeSet) {
  const head = [`# ${changeSet.skill}: plan ${changeSet.id}`, ...changeSet.summary.map((s) => `# • ${s}`), ...changeSet.warnings.map((w) => `# ! ${w.split('\n').join('\n#   ')}`), ''];
  return [...head, ...changeSet.files.map((f) => f.diff || '')].join('\n');
}

function activate(context) {
  const out = vscode.window.createOutputChannel('codz');
  const problems = vscode.languages.createDiagnosticCollection('codz');
  context.subscriptions.push(out, problems);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: (uri) => plans.get(uri.path) || '' }),
  );

  const folder = () => {
    const f = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
    return (f || (vscode.workspace.workspaceFolders || [])[0])?.uri.fsPath;
  };
  const bin = () => vscode.workspace.getConfiguration('codz').get('path') || 'codz';
  const run = async (args) => {
    const cwd = folder();
    if (!cwd) throw new Error('Open a folder first.');
    out.appendLine(`$ codz ${args.join(' ')}`);
    return runCodz(args, cwd, bin());
  };

  /** Plans a change, shows its diff, and applies it when the user agrees. */
  const change = async (args) => {
    const r = await run([...args, '--plan']);
    if (!r.planId) {
      vscode.window.showInformationMessage((r.changeSet && r.changeSet.summary.join(' ')) || 'Nothing to change.');
      return;
    }
    const uri = vscode.Uri.parse(`${SCHEME}:/${r.planId}.diff`);
    plans.set(uri.path, planText(r.changeSet));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    await vscode.window.showTextDocument(doc, { preview: true });
    const files = r.changeSet.files.length;
    const pick = await vscode.window.showInformationMessage(`Apply ${r.changeSet.skill} (${files} file${files === 1 ? '' : 's'})?`, { modal: true }, 'Apply');
    if (pick !== 'Apply') {
      vscode.window.showInformationMessage(`Not applied. Plan ${r.planId} is saved; apply it later with: codz apply ${r.planId}`);
      return;
    }
    const applied = await run(['apply', r.planId, '--allow-dirty']);
    vscode.window.showInformationMessage(`Applied ${r.changeSet.skill}: ${(applied.files || []).length || files} file(s). Undo with "codz: Undo".`);
  };

  const guard = (fn) => async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      out.appendLine(String(e.message || e));
      vscode.window.showErrorMessage(`codz: ${e.message || e}`);
    }
  };
  const pickEndpoint = async (placeHolder) => {
    const l = await run(['api', 'list']);
    const item = await vscode.window.showQuickPick(
      l.endpoints.map((e) => ({ label: e.name, description: `${e.method} ${e.path}`, detail: e.file })),
      { placeHolder },
    );
    return item && item.label;
  };
  const pickFile = async (title, filters) => {
    const f = await vscode.window.showOpenDialog({ title, canSelectMany: false, filters, defaultUri: folder() ? vscode.Uri.file(folder()) : undefined });
    return f && f[0] ? f[0].fsPath : undefined;
  };

  const commands = {
    'codz.explain': async () => {
      const r = await run(['explain']);
      out.clear();
      out.appendLine(JSON.stringify(r, null, 2));
      out.show(true);
    },
    'codz.addEndpoint': async () => {
      const clip = (await vscode.env.clipboard.readText()).trim();
      const input = await vscode.window.showInputBox({ title: 'Add an endpoint', prompt: 'A cURL command or a URL ("POST https://..." for other methods)', value: /^curl\s|^https?:\/\/|^(GET|POST|PUT|PATCH|DELETE)\s/i.test(clip) ? clip : '' });
      if (!input) return;
      const args = ['api', 'add', ...(/^curl\s/i.test(input) ? ['--curl', input] : ['--url', input])];
      const sample = await vscode.window.showQuickPick(['Pick a response sample (recommended)', 'No sample'], { title: 'Response sample' });
      if (sample && sample.startsWith('Pick')) {
        const f = await pickFile('Response sample (JSON)', { JSON: ['json'] });
        if (f) args.push('--sample', f);
      }
      await change(args);
    },
    'codz.syncSpec': async () => {
      const f = await pickFile('OpenAPI, Swagger, Postman or HAR file', { 'API spec': ['yaml', 'yml', 'json', 'har'] });
      if (f) await change(['api', 'sync', f, '--add']);
    },
    'codz.showEndpoint': async () => {
      const name = await pickEndpoint('Which endpoint?');
      if (!name) return;
      const r = await run(['api', 'show', name]);
      const items = [{ label: `$(symbol-function) ${r.endpoint.name}`, description: r.signature || '', file: r.endpoint.file, line: r.declLine }, ...(r.uses || []).map((u) => ({ label: `${u.file}:${u.line}`, description: u.text, file: u.file, line: u.line }))];
      const pick = await vscode.window.showQuickPick(items, { title: `${r.endpoint.method} ${r.endpoint.path}`, placeHolder: `${(r.uses || []).length} use(s)` });
      if (pick && pick.file) {
        const doc = await vscode.workspace.openTextDocument(path.join(folder(), pick.file));
        const pos = new vscode.Position(Math.max(0, (pick.line || 1) - 1), 0);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
      }
    },
    'codz.renameEndpoint': async () => {
      const name = await pickEndpoint('Rename which endpoint?');
      if (!name) return;
      const to = await vscode.window.showInputBox({ title: `Rename ${name}`, value: name });
      if (to && to !== name) await change(['api', 'rename', name, to]);
    },
    'codz.mockAll': () => change(['mock', 'add', '--all']),
    'codz.testAll': () => change(['test', 'add', '--all']),
    'codz.doctor': async () => {
      const r = await run(['doctor']);
      problems.clear();
      const byFile = new Map();
      for (const p of findingsToProblems(r.findings)) {
        const sev = p.severity === 'error' ? vscode.DiagnosticSeverity.Error : p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
        const d = new vscode.Diagnostic(new vscode.Range(p.line, 0, p.line, 200), p.message, sev);
        d.source = p.source;
        const uri = vscode.Uri.file(path.join(folder(), p.file));
        byFile.set(uri.toString(), [...(byFile.get(uri.toString()) || [uri]), d]);
      }
      for (const [, [uri, ...ds]] of byFile) problems.set(uri, ds);
      const c = r.counts || {};
      vscode.window.showInformationMessage(`codz doctor: ${c.error || 0} errors, ${c.warning || 0} warnings, ${c.info || 0} notes (see Problems).`);
    },
    'codz.doctorFix': () => change(['doctor', '--fix']),
    'codz.undo': async () => {
      const pick = await vscode.window.showWarningMessage('Undo the last change codz applied?', { modal: true }, 'Undo');
      if (pick !== 'Undo') return;
      await run(['undo']);
      vscode.window.showInformationMessage('Undone.');
    },
  };
  for (const [id, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));
}

function deactivate() {}

module.exports = { activate, deactivate, findingsToProblems, planText, runCodz };
