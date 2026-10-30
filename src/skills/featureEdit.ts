// Connects the detail screen feature add made to its edit form: an Edit button
// on the detail screen opens the form for the same item, and the detail screen
// shows the saved values when it comes back. Like featureLinks, each function
// edits the screen screen add wrote (a known shape) and returns null when that
// shape is not there.

import { addKotlinImports } from '../adapters/kotlinGen.ts';
import type { Conventions } from '../core/types.ts';

export interface EditTarget {
  /** Route of the edit form, for example /products/:productId/edit. */
  route: string;
  /** The one route parameter shared with the detail screen (productId). */
  param: string;
  /** Screen name of the form (EditProduct). */
  screen: string;
  /** Flutter Navigator: the form's widget class and its import. */
  widget?: string;
  dartImport?: string;
  /** GetX: Routes constant of the form module, and the import of the routes file. */
  routeConst?: string;
  routesImport?: string;
}

const fill = (route: string, param: string, expr: string) => route.replace(`:${param}`, expr);

/** Next.js server page: an Edit link under the heading. */
export function editNextDetail(text: string, e: EditTarget): string | null {
  if (!new RegExp(`const \\{ ${e.param} \\} = await params`).test(text)) return null;
  const re = /(\n([ \t]*)<h1>[^<]*<\/h1>)/;
  if (!re.test(text)) return null;
  let out = text.replace(re, (_m, h: string, indent: string) => `${h}\n${indent}<p>\n${indent}  <Link href={\`${fill(e.route, e.param, `\${${e.param}}`)}\`}>Edit</Link>\n${indent}</p>`);
  if (!/from ['"]next\/link['"]/.test(out)) out = `import Link from 'next/link';\n${out}`;
  return out;
}

/** React Router page: an Edit link under the heading (the page loads again when it is opened again). */
export function editReactDetail(text: string, e: EditTarget): string | null {
  if (!new RegExp(`const \\{ ${e.param}(?: = '')? \\} = useParams\\(\\)`).test(text)) return null;
  const re = /(\n([ \t]*)<h1>[^<]*<\/h1>)/;
  if (!re.test(text)) return null;
  let out = text.replace(re, (_m, h: string, indent: string) => `${h}\n${indent}<p>\n${indent}  <Link to={\`${fill(e.route, e.param, `\${${e.param}}`)}\`}>Edit</Link>\n${indent}</p>`);
  out = out.replace(/import \{ ([^}]*) \} from 'react-router-dom';/, (m, names: string) => {
    const set = new Set(names.split(',').map((s) => s.trim()).filter(Boolean));
    if (set.has('Link')) return m;
    set.add('Link');
    return `import { ${[...set].sort().join(', ')} } from 'react-router-dom';`;
  });
  if (!/\bLink\b[^\n]*from 'react-router-dom'/.test(out)) out = `import { Link } from 'react-router-dom';\n${out}`;
  return out;
}

const LOAD_EFFECT = '  useEffect(() => {\n    load();\n  }, [load]);';

/**
 * React Native: an Edit button at the top of the details; the screen loads again
 * whenever it comes back into focus (React Navigation keeps it mounted under the form).
 */
export function editRnDetail(text: string, e: EditTarget, c: Conventions): string | null {
  const expoRouter = c.router === 'expo-router';
  if (!text.includes(LOAD_EFFECT)) return null;
  const re = /(\n([ \t]*)<ScrollView contentContainerStyle=\{styles\.details\}>)/;
  if (!re.test(text)) return null;
  let out = text;
  if (expoRouter) {
    if (!new RegExp(`const \\{ ${e.param} \\} = useLocalSearchParams`).test(out)) return null;
    out = out.replace(re, (_m, all: string, indent: string) => `${all}\n${indent}  <Button title="Edit" onPress={() => router.push(\`${fill(e.route, e.param, `\${${e.param}}`)}\`)} />`);
    out = out.replace(LOAD_EFFECT, '  // Load when the screen opens and again when coming back to it (for example from Edit).\n  useFocusEffect(\n    useCallback(() => {\n      load();\n    }, [load]),\n  );');
    out = out.replace(/import \{ ([^}]*) \} from 'expo-router';/, (_m, names: string) => {
      const set = new Set(names.split(',').map((s) => s.trim()).filter(Boolean));
      set.add('router');
      set.add('useFocusEffect');
      return `import { ${[...set].sort().join(', ')} } from 'expo-router';`;
    });
  } else {
    const sig = /\(\{ route \}: NativeStackScreenProps</;
    if (!sig.test(out)) return null;
    out = out.replace(sig, '({ navigation, route }: NativeStackScreenProps<');
    out = out.replace(re, (_m, all: string, indent: string) => `${all}\n${indent}  <Button title="Edit" onPress={() => navigation.navigate('${e.screen}', { ${e.param} })} />`);
    out = out.replace(LOAD_EFFECT, "  // Load when the screen opens and again when coming back to it (for example from Edit).\n  useEffect(\n    () =>\n      navigation.addListener('focus', () => {\n        load();\n      }),\n    [navigation, load],\n  );");
  }
  // useEffect may no longer be used (Expo Router).
  if (!/\buseEffect\(/.test(out)) out = out.replace(/import \{ ([^}]*) \} from 'react';/, (_m, names: string) => `import { ${names.split(',').map((s) => s.trim()).filter((s) => s && s !== 'useEffect').join(', ')} } from 'react';`);
  return out;
}

/** Flutter: an Edit action in the app bar; the page loads again when the form closes. */
export function editFlutterDetail(text: string, e: EditTarget, c: Conventions, controllerText?: string): string | null {
  const getx = c.router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx';
  const re = /\n([ \t]*)appBar: AppBar\(title: (const Text\([^\n]*?\))\),/;
  if (!re.test(text)) return null;
  let onPressed: string;
  let wrap = (b: string) => b;
  if (getx) {
    if (!e.routeConst) return null;
    // The controller loads in onInit: if (productId != null) loadProduct(int.parse(productId));
    const load = controllerText ? new RegExp(`if \\(${e.param} != null\\) (\\w+\\([^;\\n]*\\));`).exec(controllerText)?.[1] : undefined;
    const reload = load ? `?.then((_) => controller.${load.replace(new RegExp(`\\b${e.param}\\b`, 'g'), 'id')})` : '';
    onPressed = `() {\n  final id = Get.parameters['${e.param}'] ?? '';\n  Get.toNamed(Routes.${e.routeConst}, parameters: {'${e.param}': id})${reload};\n}`;
  } else {
    const router = c.router;
    if (router !== 'go_router' && router !== 'navigator') return null;
    const stateless = /extends StatelessWidget/.test(text);
    const id = stateless ? e.param : `widget.${e.param}`;
    let open: string;
    if (router === 'go_router') open = `context.push('${fill(e.route, e.param, stateless ? `$${id}` : `\${${id}}`)}')`;
    else if (e.widget) open = `Navigator.push(context, MaterialPageRoute(builder: (_) => ${e.widget}(${e.param}: ${id})))`;
    else return null;
    let reload = '';
    if (/void _reload\(\)/.test(text)) reload = '.then((_) => _reload())';
    else {
      // Bloc: the page's cubit loads again (the action needs a context below the BlocProvider).
      const cubit = /BlocBuilder<(\w+), \w+>/.exec(text)?.[1];
      if (cubit && text.includes(`context.read<${cubit}>().load()`)) {
        reload = `.then((_) => context.read<${cubit}>().load())`;
        wrap = (b) => `Builder(\n  builder: (context) => ${b.replace(/\n/g, '\n  ')},\n)`;
      }
    }
    onPressed = `() => ${open}${reload}`;
  }
  const button = wrap(`IconButton(\n  tooltip: 'Edit',\n  icon: const Icon(Icons.edit),\n  onPressed: ${onPressed.replace(/\n/g, '\n  ')},\n)`);
  let out = text.replace(re, (_m, indent: string, title: string) => {
    const b = button.replace(/\n/g, `\n${indent}    `);
    return `\n${indent}appBar: AppBar(\n${indent}  title: ${title},\n${indent}  actions: [\n${indent}    ${b},\n${indent}  ],\n${indent}),`;
  });
  if (getx) {
    if (!/package:get\/get\.dart/.test(out)) out = out.replace(/(import 'package:flutter\/material\.dart';\n)/, `$1import 'package:get/get.dart';\n`);
    if (e.routesImport && !out.includes(e.routesImport)) out = out.replace(/(import 'package:get\/get\.dart';\n)/, `$1\nimport '${e.routesImport}';\n`);
  } else if (c.router === 'go_router') {
    if (!/package:go_router\/go_router\.dart/.test(out)) out = out.replace(/(import 'package:flutter\/material\.dart';\n)/, `$1import 'package:go_router/go_router.dart';\n`);
  } else if (e.dartImport && !out.includes(`'${e.dartImport}'`)) {
    out = out.replace(/(import 'package:flutter\/material\.dart';\n)/, `$1import '${e.dartImport}';\n`);
  }
  return out;
}

/**
 * Android Compose: the detail screen takes onEdit and reloads when it is resumed again;
 * the NavHost opens the form from it, and both forms go back when they are saved.
 */
export function editComposeDetail(screen: string, navHost: string, detailName: string, forms: string[], e: EditTarget | undefined, pkg: string): { screen: string; navHost: string } | null {
  let s = screen;
  let nav = navHost;
  let changed = false;
  if (e) {
    const sig = new RegExp(`fun ${detailName}\\(viewModel: `);
    const state = /\n([ \t]*)val state by viewModel\.state\.collectAsState\(\)\n/;
    if (sig.test(s) && state.test(s) && /Scaffold \{ padding ->/.test(s)) {
      s = s.replace(sig, `fun ${detailName}(onEdit: () -> Unit = {}, viewModel: `);
      s = s.replace(state, (m, i: string) =>
        [
          m.replace(/\n$/, ''),
          `${i}// Load again when coming back to this screen (for example after Edit).`,
          `${i}val owner = LocalLifecycleOwner.current`,
          `${i}DisposableEffect(owner) {`,
          `${i}    var first = true`,
          `${i}    val observer = LifecycleEventObserver { _, event ->`,
          `${i}        if (event == Lifecycle.Event.ON_RESUME) {`,
          `${i}            if (!first) viewModel.load()`,
          `${i}            first = false`,
          `${i}        }`,
          `${i}    }`,
          `${i}    owner.lifecycle.addObserver(observer)`,
          `${i}    onDispose { owner.lifecycle.removeObserver(observer) }`,
          `${i}}`,
          '',
        ].join('\n'),
      );
      s = s.replace(/Scaffold \{ padding ->/, 'Scaffold(\n        floatingActionButton = { FloatingActionButton(onClick = onEdit) { Text("Edit") } },\n    ) { padding ->');
      s = addKotlinImports(s, ['androidx.compose.material3.FloatingActionButton', 'androidx.compose.runtime.DisposableEffect', 'androidx.compose.ui.platform.LocalLifecycleOwner', 'androidx.lifecycle.Lifecycle', 'androidx.lifecycle.LifecycleEventObserver'], pkg);
      const call = new RegExp(`(\\{\\s*\\n\\s*)${detailName}\\(\\)`);
      const target = fill(e.route.replace(/^\//, ''), e.param, `\${it.arguments?.getString("${e.param}")}`);
      if (call.test(nav)) {
        nav = nav.replace(call, `$1${detailName}(onEdit = { navController.navigate("${target}") })`);
        changed = true;
      } else s = screen;
    }
  }
  // Forms: go back to the previous screen once saved.
  for (const f of forms) {
    const call = new RegExp(`(\\n\\s*)${f}\\(\\)`);
    if (call.test(nav)) {
      nav = nav.replace(call, `$1${f}(onDone = { navController.popBackStack() })`);
      changed = true;
    }
  }
  return changed ? { screen: s, navHost: nav } : null;
}

/** Android Views: an Edit button above the details; the Activity loads again when it is shown again. */
export function editViewsDetail(text: string, pkg: string, e: { activity: string; param: string }): string | null {
  const anchor = '        findViewById<Button>(R.id.retry).setOnClickListener { viewModel.load() }';
  if (!text.includes(anchor)) return null;
  const cls = /class (\w+) : \w*Activity\(\)/.exec(text)?.[1];
  if (!cls) return null;
  let out = text.replace(
    anchor,
    [
      anchor,
      '        findViewById<LinearLayout>(R.id.content).addView(',
      '            Button(this).apply {',
      '                text = "Edit"',
      `                setOnClickListener { startActivity(Intent(this@${cls}, ${e.activity}::class.java).putExtra("${e.param}", intent.getStringExtra("${e.param}"))) }`,
      '            },',
      '            1,',
      '        )',
    ].join('\n'),
  );
  out = out.replace(/\n([ \t]*)private fun render\(/, (m, i: string) => `\n${i}// Back from another screen (for example Edit): show the saved values.\n${i}override fun onRestart() {\n${i}    super.onRestart()\n${i}    viewModel.load()\n${i}}\n${m}`);
  return addKotlinImports(out, ['android.content.Intent', 'android.widget.Button', 'android.widget.LinearLayout'], pkg);
}

/** SwiftUI: an Edit link in the toolbar (the detail view loads again when it appears again). */
export function editIosDetail(text: string, e: { view: string; param: string; type: string }, I: string): string | null {
  const init = new RegExp(`\\n([ \\t]*)init\\(${e.param}: ${e.type.replace(/[?[\]]/g, '\\$&')}\\) \\{\\n`);
  const title = /\n([ \t]*)\.navigationTitle\("[^"\n]*"\)\n/;
  if (!init.test(text) || !title.test(text)) return null;
  const model = /(\n([ \t]*)@StateObject private var model: \w+\n)/;
  if (!model.test(text)) return null;
  let out = text.replace(model, (m, _a: string, i: string) => `${m}${i}private let ${e.param}: ${e.type}\n`);
  out = out.replace(init, (m, i: string) => `${m}${i}${I}self.${e.param} = ${e.param}\n`);
  out = out.replace(title, (m, i: string) => `${m}${i}.toolbar {\n${i}${I}NavigationLink("Edit") {\n${i}${I}${I}${e.view}(${e.param}: ${e.param})\n${i}${I}}\n${i}}\n`);
  return out;
}
