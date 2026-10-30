// Android screens for apps built with XML Views (no Compose): route add,
// screen add (data) and screen add --form.
//
//   <Name>Activity.kt          a ComponentActivity (works with any app theme)
//   res/layout/activity_x.xml  progress, error with Retry, and the content
//   <Name>ViewModel.kt         the same ViewModel the Compose screens use: the API
//                              interface from Hilt, Koin or the service locator;
//                              route parameters arrive as Intent extras, which
//                              the SavedStateHandle reads
//   AndroidManifest.xml        an <activity> entry
//
// A data screen shows a spinner, the error with Retry, then a RecyclerView
// (lists) or the model's fields. A form screen has one input per request field
// and closes after saving. The libraries these need (RecyclerView, activity-ktx,
// lifecycle-runtime-ktx, lifecycle-viewmodel-ktx, core-ktx) are added to Gradle
// when the app does not have them.

import { packageOf } from '../adapters/android.ts';
import { ANDROID_VERSIONS, gradleBlockAdd, tomlAdd } from '../adapters/androidSetup.ts';
import { addKotlinImports, kotlinName } from '../adapters/kotlinGen.ts';
import { ToolError, type ChangeSet, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { kebab, snake } from '../input/naming.ts';
import { access, androidPrefill, apiRef, classOfFile, ktInitial, context, dataViewModel, ensureUiState, fileOf, finish, formViewModel, injection, names, routeOf, type Ctx } from './androidUi.ts';
import { responseShape, titleField } from './screen.ts';

interface Opts {
  name: string;
  path?: string;
  api?: string;
  form?: boolean;
  load?: string;
}

/** Libraries the generated Activities use, with versions known to work together. */
const VIEW_LIBS = [
  { key: 'androidx-core-ktx', coord: 'androidx.core:core-ktx', version: '1.15.0', vkey: 'core-ktx' },
  { key: 'androidx-activity-ktx', coord: 'androidx.activity:activity-ktx', version: '1.9.3', vkey: 'activity' },
  { key: 'androidx-lifecycle-runtime-ktx', coord: 'androidx.lifecycle:lifecycle-runtime-ktx', version: ANDROID_VERSIONS.lifecycle, vkey: 'lifecycle' },
  { key: 'androidx-lifecycle-viewmodel-ktx', coord: 'androidx.lifecycle:lifecycle-viewmodel-ktx', version: ANDROID_VERSIONS.lifecycle, vkey: 'lifecycle' },
  { key: 'androidx-recyclerview', coord: 'androidx.recyclerview:recyclerview', version: '1.3.2', vkey: 'recyclerview' },
];

function viewNames(name: string) {
  const n = names(name);
  return { ...n, activity: `${n.base}Activity`, layout: `activity_${snake(n.base)}` };
}

function views(root: string, map: ProjectMap): { x: Ctx; module: string; screensDir: string; layoutDir: string; manifest: string; rClass: string } {
  const x = context(root, map, 'views');
  const module = x.c.module || 'app';
  const screensDir = x.c.screensFolder || `${x.srcDir}/${x.c.namespace!.replace(/\./g, '/')}/ui/screens`;
  return { x, module, screensDir, layoutDir: `${module}/src/main/res/layout`, manifest: `${module}/src/main/AndroidManifest.xml`, rClass: `${x.c.namespace}.R` };
}

/** Adds the libraries the Activities need to the version catalog and build file, when missing. */
function ensureLibs(x: Ctx, module: string, needed: string[]): void {
  const buildFile = [`${module}/build.gradle.kts`, `${module}/build.gradle`].find((f) => x.read(f) !== null);
  if (!buildFile) return;
  const catalogPath = x.c.versionCatalog || '';
  let catalog = catalogPath ? x.read(catalogPath) : null;
  let build = x.read(buildFile)!;
  const have = `${build}\n${catalog ?? ''}`;
  const missing = VIEW_LIBS.filter((l) => needed.includes(l.coord) && !have.includes(l.coord) && !new RegExp(`group\\s*=\\s*"${l.coord.split(':')[0].replace(/\./g, '\\.')}"\\s*,\\s*name\\s*=\\s*"${l.coord.split(':')[1]}"`).test(have) && !have.includes(`module = "${l.coord}"`));
  if (!missing.length) return;
  if (!buildFile.endsWith('.kts')) {
    x.warnings.push(`${buildFile} is Groovy; add these dependencies yourself: ${missing.map((l) => `${l.coord}:${l.version}`).join(', ')}.`);
    return;
  }
  if (catalog !== null) {
    catalog = tomlAdd(catalog, 'versions', missing.map((l) => [l.vkey, `"${l.version}"`] as [string, string]));
    catalog = tomlAdd(catalog, 'libraries', missing.map((l) => [l.key, `{ group = "${l.coord.split(':')[0]}", name = "${l.coord.split(':')[1]}", version.ref = "${l.vkey}" }`] as [string, string]));
    x.files.set(catalogPath, catalog);
    build = gradleBlockAdd(build, 'dependencies', missing.map((l) => `implementation(libs.${l.key.replace(/-/g, '.')})`));
  } else {
    build = gradleBlockAdd(build, 'dependencies', missing.map((l) => `implementation("${l.coord}:${l.version}")`));
  }
  x.files.set(buildFile, build);
  x.summary.push(`Update ${buildFile}${catalog !== null ? ` and ${catalogPath}` : ''}: add ${missing.map((l) => l.coord.split(':')[1]).join(', ')}`);
}

/** <activity android:name=".ui.screens.OrdersActivity" android:exported="false" /> */
function registerActivity(x: Ctx, manifestPath: string, activityClass: string): void {
  const text = x.read(manifestPath);
  if (text === null) return void x.warnings.push(`${manifestPath} was not found; add <activity android:name="${activityClass}" /> to it.`);
  const ns = x.c.namespace!;
  const name = activityClass.startsWith(`${ns}.`) ? activityClass.slice(ns.length) : activityClass;
  if (text.includes(`android:name="${name}"`) || text.includes(`android:name="${activityClass}"`)) return;
  const close = text.lastIndexOf('</application>');
  if (close < 0) return void x.warnings.push(`${manifestPath} has no <application> element; add <activity android:name="${name}" /> to it.`);
  const lineStart = text.lastIndexOf('\n', close) + 1;
  const indent = /^([ \t]*)/.exec(text.slice(lineStart))![1];
  x.files.set(manifestPath, `${text.slice(0, lineStart)}${indent}    <activity android:name="${name}" android:exported="false" />\n${text.slice(lineStart)}`);
  x.summary.push(`Update ${manifestPath}: register ${name}`);
}

function hint(activity: string, params: string[]): string {
  return `Open it with: startActivity(Intent(this, ${activity}::class.java)${params.map((p) => `.putExtra("${p}", ${p})`).join('')})`;
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';
const NS = 'xmlns:android="http://schemas.android.com/apk/res/android"';

export function planViewsRoute(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  const v = views(root, map);
  const { x } = v;
  const n = viewNames(opts.name);
  const { params } = routeOf(opts.name, opts.path);
  const file = fileOf(v.screensDir, n.activity);
  const layout = `${v.layoutDir}/${n.layout}.xml`;
  for (const f of [file, layout]) if (x.read(f) !== null) throw new ToolError('route_exists', `${f} already exists.`);
  const pkg = packageOf(x.srcDir, v.screensDir);
  x.files.set(layout, [XML_HEAD, `<LinearLayout ${NS}`, '    android:layout_width="match_parent"', '    android:layout_height="match_parent"', '    android:orientation="vertical"', '    android:padding="16dp">', '', '    <TextView', '        android:id="@+id/title"', '        android:layout_width="wrap_content"', '        android:layout_height="wrap_content"', `        android:text="${n.title}"`, '        android:textSize="22sp" />', '', '</LinearLayout>', ''].join('\n'));
  const activity = [
    `package ${pkg}`,
    '',
    `class ${n.activity} : ComponentActivity() {`,
    '    override fun onCreate(savedInstanceState: Bundle?) {',
    '        super.onCreate(savedInstanceState)',
    `        setContentView(R.layout.${n.layout})`,
    ...(params.length ? [`        findViewById<TextView>(R.id.title).text = "${n.title} " + intent.getStringExtra("${params[0]}").orEmpty()`] : []),
    '    }',
    '}',
    '',
  ].join('\n');
  x.files.set(file, addKotlinImports(activity, ['android.os.Bundle', 'androidx.activity.ComponentActivity', v.rClass, ...(params.length ? ['android.widget.TextView'] : [])], pkg));
  x.summary.push(`Create ${file} and ${layout}: ${n.activity}`);
  ensureLibs(x, v.module, ['androidx.activity:activity-ktx']);
  registerActivity(x, v.manifest, `${pkg}.${n.activity}`);
  return finish(x, 'route add', hint(n.activity, params));
}

export function planViewsScreen(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  if (!opts.api) return planViewsRoute(root, map, opts);
  const v = views(root, map);
  const { x } = v;
  const a = apiRef(x, opts.api);
  if (opts.form) return planViewsForm(v, opts, a);
  if (a.ep.method !== 'GET') throw new ToolError('screen_needs_get', `${a.ep.name} is a ${a.ep.method} endpoint; a screen loads data with a GET.`, 'For a form that sends it, add --form.');
  const n = viewNames(opts.name);
  const { params } = routeOf(opts.name, opts.path);
  const required = a.params.filter((p) => !p.optional && p.annotation !== 'Body');
  const missing = required.filter((p) => !params.includes(p.name.replace(/`/g, '')));
  if (missing.length) throw new ToolError('screen_args', `${a.ep.name}() needs ${missing.map((p) => p.name).join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.base)}/:${missing[0].name}`);
  const file = fileOf(v.screensDir, n.activity);
  const vmFile = fileOf(v.screensDir, n.vm);
  const layout = `${v.layoutDir}/${n.layout}.xml`;
  for (const f of [file, vmFile, layout]) if (x.read(f) !== null) throw new ToolError('route_exists', `${f} already exists.`);
  const pkg = packageOf(x.srcDir, v.screensDir);
  const uiState = ensureUiState(x, v.screensDir);
  const T = a.returnType;
  const shape = responseShape(T, map);
  const model: ModelInfo | undefined = shape.model;
  const modelImports = model ? [classOfFile(x.srcDir, model.file)] : [];
  const inj = injection(x, a, n.vm, pkg, params.length > 0);
  const args = required.map((p) => {
    const name = p.name.replace(/`/g, '');
    return /^(Int|Long)$/.test(p.type) ? `${name}.to${p.type}()` : name;
  });
  x.files.set(vmFile, dataViewModel(x, a, n.vm, pkg, params, args, inj, uiState, T, modelImports));
  x.summary.push(`Create ${vmFile}: ${n.vm} loads ${a.iface}.${a.ep.name}()${params.length ? ` with ${params.join(', ')} from the Intent extras` : ''}`);

  // Layout.
  const content = shape.list
    ? ['        <androidx.recyclerview.widget.RecyclerView', '            android:id="@+id/list"', '            android:layout_width="match_parent"', '            android:layout_height="0dp"', '            android:layout_weight="1" />', '', '        <TextView', '            android:id="@+id/empty"', '            android:layout_width="wrap_content"', '            android:layout_height="wrap_content"', '            android:padding="16dp"', '            android:text="Nothing here yet."', '            android:visibility="gone" />']
    : ['        <ScrollView', '            android:layout_width="match_parent"', '            android:layout_height="0dp"', '            android:layout_weight="1">', '', '            <LinearLayout', '                android:id="@+id/details"', '                android:layout_width="match_parent"', '                android:layout_height="wrap_content"', '                android:orientation="vertical"', '                android:padding="16dp" />', '        </ScrollView>'];
  x.files.set(
    layout,
    [
      XML_HEAD,
      `<FrameLayout ${NS}`,
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent">',
      '',
      '    <LinearLayout',
      '        android:id="@+id/content"',
      '        android:layout_width="match_parent"',
      '        android:layout_height="match_parent"',
      '        android:orientation="vertical"',
      '        android:visibility="gone">',
      '',
      '        <TextView',
      '            android:id="@+id/title"',
      '            android:layout_width="wrap_content"',
      '            android:layout_height="wrap_content"',
      '            android:padding="16dp"',
      `            android:text="${n.title}"`,
      '            android:textSize="22sp" />',
      ...(shape.list ? ['', '        <Button', '            android:id="@+id/new_button"', '            android:layout_width="wrap_content"', '            android:layout_height="wrap_content"', '            android:layout_marginHorizontal="16dp"', '            android:text="New"', '            android:visibility="gone" />'] : []),
      '',
      ...content,
      '    </LinearLayout>',
      '',
      '    <ProgressBar',
      '        android:id="@+id/progress"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:layout_gravity="center" />',
      '',
      '    <LinearLayout',
      '        android:id="@+id/error"',
      '        android:layout_width="wrap_content"',
      '        android:layout_height="wrap_content"',
      '        android:layout_gravity="center"',
      '        android:gravity="center"',
      '        android:orientation="vertical"',
      '        android:padding="16dp"',
      '        android:visibility="gone">',
      '',
      '        <TextView',
      '            android:id="@+id/error_text"',
      '            android:layout_width="wrap_content"',
      '            android:layout_height="wrap_content" />',
      '',
      '        <Button',
      '            android:id="@+id/retry"',
      '            android:layout_width="wrap_content"',
      '            android:layout_height="wrap_content"',
      '            android:text="Retry" />',
      '    </LinearLayout>',
      '</FrameLayout>',
      '',
    ].join('\n'),
  );

  // Activity.
  const item = model?.name ?? 'Any';
  const tf = titleField(model);
  const success = shape.list
    ? ['            is UiState.Success -> {', '                adapter.submit(state.data)', '                findViewById<View>(R.id.empty).isVisible = state.data.isEmpty()', '            }']
    : [
        '            is UiState.Success -> {',
        '                val details = findViewById<LinearLayout>(R.id.details)',
        '                details.removeAllViews()',
        ...(model?.fields.length ? model.fields.map((f) => `                field(details, "${f.name}", ${access('state.data', f.name)}?.toString().orEmpty())`) : ['                field(details, "", state.data.toString())']),
        '            }',
      ];
  const activity = [
    `package ${pkg}`,
    '',
    ...inj.activity.annotations,
    `class ${n.activity} : ComponentActivity() {`,
    `    private val viewModel: ${n.vm} ${inj.activity.delegate}`,
    ...(shape.list ? ['    private val adapter = ItemAdapter { item -> openItem(item) }'] : []),
    '',
    '    override fun onCreate(savedInstanceState: Bundle?) {',
    '        super.onCreate(savedInstanceState)',
    `        setContentView(R.layout.${n.layout})`,
    ...(shape.list
      ? [
          '        val list = findViewById<RecyclerView>(R.id.list)',
          '        list.layoutManager = LinearLayoutManager(this)',
          '        list.addItemDecoration(DividerItemDecoration(this, DividerItemDecoration.VERTICAL))',
          '        list.adapter = adapter',
          '        findViewById<Button>(R.id.new_button).setOnClickListener { openNew() }',
        ]
      : []),
    '        findViewById<Button>(R.id.retry).setOnClickListener { viewModel.load() }',
    '        lifecycleScope.launch {',
    '            repeatOnLifecycle(Lifecycle.State.STARTED) {',
    '                viewModel.state.collect { render(it) }',
    '            }',
    '        }',
    '    }',
    ...(shape.list ? ['', '    /** Back from a screen this one opened: show what changed. */', '    override fun onRestart() {', '        super.onRestart()', '        viewModel.load()', '    }'] : []),
    '',
    `    private fun render(state: UiState<${T}>) {`,
    '        findViewById<View>(R.id.progress).isVisible = state is UiState.Loading',
    '        findViewById<View>(R.id.error).isVisible = state is UiState.Error',
    '        findViewById<View>(R.id.content).isVisible = state is UiState.Success',
    '        when (state) {',
    '            is UiState.Loading -> Unit',
    '            is UiState.Error -> findViewById<TextView>(R.id.error_text).text = state.message',
    ...success,
    '        }',
    '    }',
    ...(shape.list
      ? [
          '',
          `    private fun openItem(item: ${item}) {`,
          '        // codz: open item',
          '    }',
          '',
          '    private fun openNew() {',
          '        // codz: open new',
          '    }',
          '',
          `    private class ItemAdapter(private val onClick: (${item}) -> Unit) : RecyclerView.Adapter<ItemAdapter.Holder>() {`,
          `        private var items: List<${item}> = emptyList()`,
          '',
          '        class Holder(val text: TextView) : RecyclerView.ViewHolder(text)',
          '',
          '        @SuppressLint("NotifyDataSetChanged")',
          `        fun submit(data: List<${item}>) {`,
          '            items = data',
          '            notifyDataSetChanged()',
          '        }',
          '',
          '        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =',
          '            Holder(LayoutInflater.from(parent.context).inflate(android.R.layout.simple_list_item_1, parent, false) as TextView)',
          '',
          '        override fun getItemCount(): Int = items.size',
          '',
          '        override fun onBindViewHolder(holder: Holder, position: Int) {',
          '            val item = items[position]',
          `            holder.text.text = ${tf ? `${access('item', tf)}.toString()` : 'item.toString()'}`,
          '            holder.itemView.setOnClickListener { onClick(item) }',
          '        }',
          '    }',
        ]
      : [
          '',
          '    private fun field(parent: LinearLayout, label: String, value: String) {',
          '        parent.addView(TextView(this).apply { text = label; setTextAppearance(android.R.style.TextAppearance_Small) })',
          '        parent.addView(TextView(this).apply { text = value; setTextAppearance(android.R.style.TextAppearance_Medium); setPadding(0, 0, 0, 24) })',
          '    }',
        ]),
    '}',
    '',
  ].join('\n');
  const imports = [
    'android.os.Bundle',
    'android.view.View',
    'android.widget.Button',
    'android.widget.TextView',
    'androidx.activity.ComponentActivity',
    'androidx.core.view.isVisible',
    'androidx.lifecycle.Lifecycle',
    'androidx.lifecycle.lifecycleScope',
    'androidx.lifecycle.repeatOnLifecycle',
    'kotlinx.coroutines.launch',
    v.rClass,
    uiState,
    ...modelImports,
    ...inj.activity.imports,
    ...(shape.list ? ['android.annotation.SuppressLint', 'android.view.LayoutInflater', 'android.view.ViewGroup', 'androidx.recyclerview.widget.DividerItemDecoration', 'androidx.recyclerview.widget.LinearLayoutManager', 'androidx.recyclerview.widget.RecyclerView'] : ['android.widget.LinearLayout']),
  ];
  x.files.set(file, addKotlinImports(activity, imports, pkg));
  x.summary.push(`Create ${file} and ${layout}: ${n.activity} (loading, error with Retry, ${shape.list ? 'RecyclerView' : 'details'})`);
  ensureLibs(x, v.module, ['androidx.core:core-ktx', 'androidx.activity:activity-ktx', 'androidx.lifecycle:lifecycle-runtime-ktx', 'androidx.lifecycle:lifecycle-viewmodel-ktx', ...(shape.list ? ['androidx.recyclerview:recyclerview'] : [])]);
  registerActivity(x, v.manifest, `${pkg}.${n.activity}`);
  return finish(x, 'screen add', hint(n.activity, params));
}

function planViewsForm(v: ReturnType<typeof views>, opts: Opts, a: ReturnType<typeof apiRef>): ChangeSet {
  const { x } = v;
  if (!['POST', 'PUT', 'PATCH'].includes(a.ep.method)) throw new ToolError('form_needs_body', `${a.ep.name} is a ${a.ep.method} endpoint; a form sends a request body (POST, PUT or PATCH).`);
  const body = a.params.find((p) => p.annotation === 'Body');
  if (!body) throw new ToolError('form_needs_body', `${a.ep.name}() takes no @Body, so there is nothing for a form to send.`);
  const bodyModel = x.map.models.find((m) => m.name === body.type.replace(/\?$/, ''));
  if (!bodyModel) throw new ToolError('form_needs_body', `The request type ${body.type} was not found among the data classes.`);
  const n = viewNames(opts.name);
  const { params } = routeOf(opts.name, opts.path);
  const required = a.params.filter((p) => !p.optional && p.annotation !== 'Body');
  const missing = required.filter((p) => !params.includes(p.name.replace(/`/g, '')));
  if (missing.length) throw new ToolError('screen_args', `${a.ep.name}() needs ${missing.map((p) => p.name).join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.base)}/:${missing[0].name}`);
  const file = fileOf(v.screensDir, n.activity);
  const vmFile = fileOf(v.screensDir, n.vm);
  const layout = `${v.layoutDir}/${n.layout}.xml`;
  for (const f of [file, vmFile, layout]) if (x.read(f) !== null) throw new ToolError('route_exists', `${f} already exists.`);
  const pkg = packageOf(x.srcDir, v.screensDir);
  const uiState = ensureUiState(x, v.screensDir);
  const R = a.returnType;
  const inj = injection(x, a, n.vm, pkg, params.length > 0);
  const args = [...required.map((p) => (/^(Int|Long)$/.test(p.type) ? `${p.name}.to${p.type}()` : p.name)), 'body'];
  const bodyClass = classOfFile(x.srcDir, bodyModel.file);
  const result = responseShape(R, x.map).model;
  const prefill = androidPrefill(x, a, opts.load, bodyModel.fields.map((f) => f.name), params);
  x.files.set(vmFile, formViewModel(x, a, n.vm, pkg, params, args, inj, uiState, R, bodyModel.name, bodyClass, result ? [classOfFile(x.srcDir, result.file)] : [], prefill));
  x.summary.push(`Create ${vmFile}: ${n.vm}.submit() sends ${a.iface}.${a.ep.name}()${prefill ? `; the form starts with ${prefill.call.replace(/^api\./, `${a.iface}.`)}` : ''}`);

  const fields = bodyModel.fields.map((f) => {
    const t = f.type.replace(/\?$/, '');
    const prop = kotlinName(f.name);
    return { json: f.name, prop, v: `${prop.replace(/`/g, '')}Input`, t, nullable: f.nullable, bool: t === 'Boolean', num: /^(Int|Long|Double|Float)$/.test(t), text: t === 'String' };
  });
  const usable = fields.filter((f) => f.bool || f.num || f.text);
  const unsupported = fields.filter((f) => !f.bool && !f.num && !f.text);
  if (unsupported.some((f) => !f.nullable)) throw new ToolError('form_fields', `${bodyModel.name} has required fields a form cannot fill: ${unsupported.filter((f) => !f.nullable).map((f) => `${f.json} (${f.t})`).join(', ')}.`, `Write the form for ${a.ep.name} by hand, or make those fields optional.`);
  if (unsupported.length) x.warnings.push(`The form has no input for ${unsupported.map((f) => `${f.json} (${f.t})`).join(', ')}; they are sent as null.`);
  const zero = (t: string) => (t === 'Double' ? '0.0' : t === 'Float' ? '0f' : t === 'Long' ? '0L' : '0');
  const value = (f: (typeof fields)[number]) => {
    if (f.bool) return `${f.v}.isChecked`;
    const s = `${f.v}.text.toString().trim()`;
    if (f.text) return f.nullable ? `${s}.ifBlank { null }` : s;
    if (f.num) return `${s}.to${f.t}OrNull()${f.nullable ? '' : ` ?: ${zero(f.t)}`}`;
    return 'null';
  };
  const inputType = (f: (typeof fields)[number]) => (f.num ? (/Double|Float/.test(f.t) ? 'InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED' : 'InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_SIGNED') : /email/i.test(f.json) ? 'InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS' : 'InputType.TYPE_CLASS_TEXT');

  x.files.set(
    layout,
    [
      XML_HEAD,
      `<ScrollView ${NS}`,
      '    android:layout_width="match_parent"',
      '    android:layout_height="match_parent">',
      '',
      '    <LinearLayout',
      '        android:layout_width="match_parent"',
      '        android:layout_height="wrap_content"',
      '        android:orientation="vertical"',
      '        android:padding="16dp">',
      '',
      '        <TextView',
      '            android:layout_width="wrap_content"',
      '            android:layout_height="wrap_content"',
      '            android:paddingBottom="8dp"',
      `            android:text="${n.title}"`,
      '            android:textSize="22sp" />',
      '',
      '        <LinearLayout',
      '            android:id="@+id/fields"',
      '            android:layout_width="match_parent"',
      '            android:layout_height="wrap_content"',
      '            android:orientation="vertical" />',
      '',
      '        <TextView',
      '            android:id="@+id/error_text"',
      '            android:layout_width="wrap_content"',
      '            android:layout_height="wrap_content"',
      '            android:textColor="#B3261E"',
      '            android:visibility="gone" />',
      '',
      '        <Button',
      '            android:id="@+id/save"',
      '            android:layout_width="match_parent"',
      '            android:layout_height="wrap_content"',
      '            android:layout_marginTop="16dp"',
      '            android:text="Save" />',
      '    </LinearLayout>',
      '</ScrollView>',
      '',
    ].join('\n'),
  );

  const activity = [
    `package ${pkg}`,
    '',
    ...inj.activity.annotations,
    `class ${n.activity} : ComponentActivity() {`,
    `    private val viewModel: ${n.vm} ${inj.activity.delegate}`,
    ...usable.map((f) => `    private lateinit var ${f.v}: ${f.bool ? 'CheckBox' : 'EditText'}`),
    '',
    '    override fun onCreate(savedInstanceState: Bundle?) {',
    '        super.onCreate(savedInstanceState)',
    `        setContentView(R.layout.${n.layout})`,
    '        val fields = findViewById<LinearLayout>(R.id.fields)',
    ...usable.map((f) => (f.bool ? `        ${f.v} = CheckBox(this).apply { text = "${f.json}" }.also(fields::addView)` : `        ${f.v} = input(fields, "${f.json}${f.nullable ? '' : ' *'}", ${inputType(f)})`)),
    '        findViewById<Button>(R.id.save).setOnClickListener { save() }',
    ...(prefill
      ? [
          '        // Start with the current values (once they have loaded).',
          '        lifecycleScope.launch {',
          '            viewModel.initial.filterNotNull().first().let {',
          ...usable
            .filter((f) => (f.bool || f.num || f.text) && prefill.shared.has(f.json) && prefill.model.fields.find((m) => m.name === f.json)!.type.replace(/\?$/, '') === f.t)
            .map((f) => {
              const init = ktInitial(f.bool ? 'bool' : f.num ? 'num' : 'text', `it.${f.prop}`, prefill.model.fields.find((m) => m.name === f.json)!.nullable);
              return f.bool ? `                ${f.v}.isChecked = ${init}` : `                ${f.v}.setText(${init})`;
            }),
          '            }',
          '        }',
        ]
      : []),
    '        lifecycleScope.launch {',
    '            repeatOnLifecycle(Lifecycle.State.STARTED) {',
    '                viewModel.state.collect { state ->',
    '                    findViewById<Button>(R.id.save).isEnabled = state !is UiState.Loading',
    '                    findViewById<TextView>(R.id.error_text).apply {',
    '                        isVisible = state is UiState.Error',
    '                        text = (state as? UiState.Error)?.message',
    '                    }',
    '                    if (state is UiState.Success) {',
    '                        setResult(RESULT_OK)',
    '                        finish()',
    '                    }',
    '                }',
    '            }',
    '        }',
    '    }',
    '',
    '    private fun save() {',
    ...usable.filter((f) => !f.nullable && !f.bool).map((f) => `        if (${f.v}.text.isBlank()) return run { ${f.v}.error = "Required" }`),
    '        viewModel.submit(',
    `            ${bodyModel.name}(`,
    ...fields.map((f) => `                ${f.prop} = ${value(f)},`),
    '            ),',
    '        )',
    '    }',
    '',
    '    private fun input(parent: LinearLayout, label: String, type: Int): EditText =',
    '        EditText(this).apply {',
    '            hint = label',
    '            inputType = type',
    '        }.also(parent::addView)',
    '}',
    '',
  ].join('\n');
  const imports = [
    'android.os.Bundle',
    'android.text.InputType',
    'android.widget.Button',
    'android.widget.EditText',
    'android.widget.LinearLayout',
    'android.widget.TextView',
    'androidx.activity.ComponentActivity',
    'androidx.core.view.isVisible',
    'androidx.lifecycle.Lifecycle',
    'androidx.lifecycle.lifecycleScope',
    'androidx.lifecycle.repeatOnLifecycle',
    'kotlinx.coroutines.launch',
    v.rClass,
    uiState,
    bodyClass,
    ...(usable.some((f) => f.bool) ? ['android.widget.CheckBox'] : []),
    ...(prefill ? ['kotlinx.coroutines.flow.filterNotNull', 'kotlinx.coroutines.flow.first'] : []),
    ...inj.activity.imports,
  ];
  x.files.set(file, addKotlinImports(activity, imports, pkg));
  x.summary.push(`Create ${file} and ${layout}: ${n.activity}, a form with ${usable.length} field${usable.length === 1 ? '' : 's'} for ${bodyModel.name}; it closes after saving`);
  ensureLibs(x, v.module, ['androidx.core:core-ktx', 'androidx.activity:activity-ktx', 'androidx.lifecycle:lifecycle-runtime-ktx', 'androidx.lifecycle:lifecycle-viewmodel-ktx']);
  registerActivity(x, v.manifest, `${pkg}.${n.activity}`);
  return finish(x, 'screen add', hint(n.activity, params));
}

/** feature add: rows of the list Activity open the detail Activity; the New button opens the form. */
export function linkViewsList(text: string, pkg: string, t: { detail?: { activity: string; param: string }; create?: { activity: string; noun: string }; idField?: string }): string | null {
  let out = text;
  let changed = false;
  if (t.detail && t.idField && out.includes('        // codz: open item')) {
    out = out.replace('        // codz: open item', `        startActivity(Intent(this, ${t.detail.activity}::class.java).putExtra("${t.detail.param}", ${access('item', t.idField)}.toString()))`);
    changed = true;
  }
  if (t.create && out.includes('        // codz: open new')) {
    out = out.replace('        // codz: open new', `        startActivity(Intent(this, ${t.create.activity}::class.java))`);
    out = out.replace('        findViewById<Button>(R.id.new_button).setOnClickListener { openNew() }', `        findViewById<Button>(R.id.new_button).apply {\n            text = "New ${t.create.noun}"\n            isVisible = true\n            setOnClickListener { openNew() }\n        }`);
    changed = true;
  }
  if (!changed) return null;
  return addKotlinImports(out, ['android.content.Intent'], pkg);
}

