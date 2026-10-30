// Connects the screens feature add made: tapping a row of the list opens the
// detail screen, and a "New" button opens the create form. Each function edits
// the list screen screen add wrote (a known shape) and returns null when the
// shape is not there, so a project with its own templates is left alone.

import { posix } from 'node:path';
import type { Conventions } from '../core/types.ts';

export interface LinkTargets {
  /** Route of the detail screen, for example /users/:userId; only one parameter is supported. */
  detail?: { route: string; param: string; screen: string; widget?: string; dartImport?: string; routeConst?: string };
  create?: { route: string; screen: string; routeConst?: string };
  /** GetX: import of the file that holds Routes (app_pages.dart, with app_routes.dart as its part). */
  routesImport?: string;
  /** The list item's id field (id, userId, ...). */
  idField?: string;
  /** "user" for the button label "New user". */
  noun: string;
}

const goPath = (route: string, param: string, expr: string) => route.replace(`:${param}`, expr);

/** Next.js server page: rows become links, a "New" link under the heading. */
export function linkNextList(text: string, t: LinkTargets): string | null {
  let out = text;
  let changed = false;
  if (t.detail && t.idField) {
    const re = /<li key=\{([^}]+)\}>(\{[^<]+\})<\/li>/;
    if (re.test(out)) {
      out = out.replace(re, (_m, key: string, body: string) => `<li key={${key}}><Link href={\`${goPath(t.detail!.route, t.detail!.param, `\${item.${t.idField}}`)}\`}>${body}</Link></li>`);
      changed = true;
    }
  }
  if (t.create) {
    const re = /(\n(\s*)<h1>[^<]*<\/h1>)/;
    if (re.test(out)) {
      out = out.replace(re, (_m, h: string, indent: string) => `${h}\n${indent}<p>\n${indent}  <Link href="${t.create!.route}">New ${t.noun}</Link>\n${indent}</p>`);
      changed = true;
    }
  }
  if (!changed) return null;
  if (!/from ['"]next\/link['"]/.test(out)) out = `import Link from 'next/link';\n${out}`;
  return out;
}

/** React web (React Router): rows become links, a "New" link under the heading. */
export function linkReactList(text: string, t: LinkTargets): string | null {
  const out = linkNextList(text, t);
  if (!out) return null;
  return out.replace(/import Link from 'next\/link';\n/, '').replace(/^/, (s) => (/from 'react-router-dom'/.test(out) ? s : `import { Link } from 'react-router-dom';\n`)).replace(/<Link href=/g, '<Link to=');
}

/** React Native (React Navigation or Expo Router): rows open the detail screen, a header button opens the form. */
export function linkRnList(text: string, t: LinkTargets, c: Conventions, screenFile: string): string | null {
  const expoRouter = c.router === 'expo-router';
  let out = text;
  let changed = false;
  const go = (route: string, screen: string, params?: string) => (expoRouter ? `router.push(${params ? `\`${route}\`` : `'${route}'`})` : `navigation.navigate('${screen}'${params ? `, ${params}` : ''})`);
  if (t.detail && t.idField) {
    const re = /renderItem=\{\(\{ item \}\) => <Text style=\{styles\.row\}>(\{[^<]+\})<\/Text>\}/;
    if (re.test(out)) {
      const call = expoRouter ? go(goPath(t.detail.route, t.detail.param, `\${item.${t.idField}}`), t.detail.screen, 'x') : go('', t.detail.screen, `{ ${t.detail.param}: String(item.${t.idField}) }`);
      out = out.replace(re, (_m, body: string) => `renderItem={({ item }) => (\n        <Pressable accessibilityRole="button" onPress={() => ${call}}>\n          <Text style={styles.row}>${body}</Text>\n        </Pressable>\n      )}`);
      changed = true;
    }
  }
  if (t.create) {
    const re = /(\n(\s*)ListEmptyComponent=)/;
    if (re.test(out)) {
      out = out.replace(re, (_m, all: string, indent: string) => `\n${indent}ListHeaderComponent={<Button title="New ${t.noun}" onPress={() => ${go(t.create!.route, t.create!.screen)}} />}${all}`);
      changed = true;
    }
  }
  if (!changed) return null;
  // Imports and the navigation hook.
  out = out.replace(/import \{ ([^}]*) \} from 'react-native';/, (_m, names: string) => {
    const set = new Set(names.split(',').map((s) => s.trim()).filter(Boolean));
    set.add('Pressable');
    set.add('Button');
    return `import { ${[...set].sort().join(', ')} } from 'react-native';`;
  });
  if (expoRouter) {
    if (!/from 'expo-router'/.test(out)) out = out.replace(/(import [^\n]+ from 'react-native';\n)/, `$1import { router } from 'expo-router';\n`);
  } else {
    const nav = c.navigatorFile ? posix.relative(posix.dirname(screenFile), c.navigatorFile.replace(/\.(tsx?|jsx?)$/, '')) : '../navigation/RootNavigator';
    const navImport = nav.startsWith('.') ? nav : `./${nav}`;
    out = out.replace(/(import [^\n]+ from 'react-native';\n)/, `$1import { useNavigation } from '@react-navigation/native';\nimport type { NativeStackNavigationProp } from '@react-navigation/native-stack';\nimport type { RootStackParamList } from '${navImport}';\n`);
    out = out.replace(/(export default function \w+\(\) \{\n)/, `$1  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();\n`);
  }
  return out;
}

/** Flutter (go_router, GetX routes or Navigator): rows open the detail page, a floating button opens the form; the list reloads after the form. */
export function linkFlutterList(text: string, t: LinkTargets, c: Conventions): string | null {
  const router = c.router;
  // A GetX app navigates by GetX routes even when the router convention still says navigator.
  if (router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx') return linkGetxList(text, t);
  if (router !== 'go_router' && router !== 'navigator') return null;
  // Navigator named routes cannot carry a path parameter, so the detail page is pushed with its constructor.
  if (router === 'navigator' && t.detail && !(t.detail.widget && t.detail.dartImport)) t = { ...t, detail: undefined };
  const push = (path: string) => (router === 'go_router' ? `context.push(${path})` : `Navigator.pushNamed(context, ${path})`);
  const open = (d: NonNullable<LinkTargets['detail']>, id: string) => (router === 'navigator' ? `Navigator.push(context, MaterialPageRoute(builder: (_) => ${d.widget}(${d.param}: '\${${id}}')))` : push(`'${goPath(d.route, d.param, `\${${id}}`)}'`));
  let out = text;
  let changed = false;
  const reload = /void _reload\(\)/.test(out) ? '.then((_) => _reload())' : '';
  if (t.detail && t.idField) {
    const re = /ListTile\(title: (Text\([^\n]*?\))\)(?=,?\n)/;
    if (re.test(out)) {
      const call = open(t.detail, `items[index].${t.idField}`);
      out = out.replace(re, (_m, title: string) => `ListTile(\n                title: ${title},\n                onTap: () => ${call}${reload},\n              )`);
      changed = true;
    }
  }
  if (t.create) {
    const re = /(\n(\s*)appBar: AppBar\([^\n]*\),)/;
    if (re.test(out)) {
      out = out.replace(re, (_m, all: string, indent: string) => `${all}\n${indent}floatingActionButton: FloatingActionButton(\n${indent}  tooltip: 'New ${t.noun}',\n${indent}  onPressed: () => ${push(`'${t.create!.route}'`)}${reload},\n${indent}  child: const Icon(Icons.add),\n${indent}),`);
      changed = true;
    }
  }
  if (!changed) return null;
  if (router === 'go_router' && !/package:go_router\/go_router\.dart/.test(out)) out = out.replace(/(import 'package:flutter\/material\.dart';\n)/, `$1import 'package:go_router/go_router.dart';\n`);
  if (router === 'navigator' && t.detail?.dartImport && !out.includes(`'${t.detail.dartImport}'`)) out = out.replace(/(import 'package:flutter\/material\.dart';\n)/, `$1import '${t.detail.dartImport}';\n`);
  return out;
}

/**
 * GetX module view: rows open the detail module with its id in Get.parameters, a floating button opens
 * the create module; the list reloads when they come back. Modules keep their own route names
 * (Routes.PRODUCT_DETAIL = /product-detail), so navigation goes by the route constant.
 */
function linkGetxList(text: string, t: LinkTargets): string | null {
  let out = text;
  let changed = false;
  const loader = /onRefresh: controller\.(\w+),/.exec(out)?.[1];
  // Get.toNamed returns a nullable Future.
  const reload = loader ? `?.then((_) => controller.${loader}())` : '';
  if (t.detail?.routeConst && t.idField) {
    const re = /return ListTile\(title: (Text\([^\n]*?\))\);/;
    if (re.test(out)) {
      const call = `Get.toNamed(Routes.${t.detail.routeConst}, parameters: {'${t.detail.param}': '\${item.${t.idField}}'})`;
      out = out.replace(re, (_m, title: string) => `return ListTile(\n                title: ${title},\n                onTap: () => ${call}${reload},\n              );`);
      changed = true;
    }
  }
  if (t.create?.routeConst) {
    const re = /(\n(\s*)appBar: AppBar\([^\n]*\),)/;
    if (re.test(out)) {
      out = out.replace(re, (_m, all: string, indent: string) => `${all}\n${indent}floatingActionButton: FloatingActionButton(\n${indent}  tooltip: 'New ${t.noun}',\n${indent}  onPressed: () => Get.toNamed(Routes.${t.create!.routeConst})${reload},\n${indent}  child: const Icon(Icons.add),\n${indent}),`);
      changed = true;
    }
  }
  if (!changed) return null;
  if (!/package:get\/get\.dart/.test(out)) out = out.replace(/(import 'package:flutter\/material\.dart';\n)/, `$1import 'package:get/get.dart';\n`);
  if (t.routesImport && !out.includes(t.routesImport)) out = out.replace(/(import 'package:get\/get\.dart';\n)/, `$1\nimport '${t.routesImport}';\n`);
  return out;
}

/** Android Compose: the list screen takes onOpen/onNew callbacks; the NavHost passes navigation into them. */
export function linkAndroidList(screen: string, navHost: string, listName: string, t: LinkTargets): { screen: string; navHost: string } | null {
  let s = screen;
  const sig = new RegExp(`fun ${listName}\\(viewModel: `);
  if (!sig.test(s)) return null;
  const params = [t.detail && t.idField ? 'onOpen: (String) -> Unit = {}' : '', t.create ? 'onNew: () -> Unit = {}' : ''].filter(Boolean);
  if (!params.length) return null;
  s = s.replace(sig, `fun ${listName}(${params.join(', ')}, viewModel: `);
  if (t.detail && t.idField) {
    s = s.replace(/Text\(item\.(\w+)\.toString\(\), Modifier\.fillMaxWidth\(\)\.padding\(16\.dp\)\)/, `Text(item.$1.toString(), Modifier.fillMaxWidth().clickable { onOpen(item.${t.idField}.toString()) }.padding(16.dp))`);
    if (!/import androidx\.compose\.foundation\.clickable/.test(s)) s = s.replace(/(import androidx\.compose\.foundation\.layout\.Box\n)/, `import androidx.compose.foundation.clickable\n$1`);
  }
  if (t.create) {
    s = s.replace(/Scaffold \{ padding ->/, `Scaffold(\n        floatingActionButton = { FloatingActionButton(onClick = onNew) { Text("+") } },\n    ) { padding ->`);
    if (!/import androidx\.compose\.material3\.FloatingActionButton/.test(s)) s = s.replace(/(import androidx\.compose\.material3\.HorizontalDivider\n)/, `import androidx.compose.material3.FloatingActionButton\n$1`);
  }
  const call = new RegExp(`(\\n\\s*)${listName}\\(\\)`);
  if (!call.test(navHost)) return null;
  const args = [t.detail && t.idField ? `onOpen = { id -> navController.navigate("${t.detail.route.replace(/^\//, '').replace(`:${t.detail.param}`, '$id')}") }` : '', t.create ? `onNew = { navController.navigate("${t.create.route.replace(/^\//, '')}") }` : ''].filter(Boolean);
  const nav = navHost.replace(call, `$1${listName}(${args.join(', ')})`);
  return { screen: s, navHost: nav };
}
