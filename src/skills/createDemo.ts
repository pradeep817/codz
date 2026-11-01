// The first screen of a project made by `codz create`: a small task list that
// loads sample data and lets you tick tasks off, written in the architecture
// that was picked (a Riverpod AsyncNotifier, a GetX controller, a Cubit, a
// Hilt/Koin ViewModel, a TanStack Query hook...), so the app opens on a working
// example of its own pattern instead of the platform template (a setState
// counter). The data comes from a stand-in class, not the network; codz api add
// and feature add replace it with real endpoints.

import { join } from 'node:path';
import { addKotlinImports } from '../adapters/kotlinGen.ts';
import { readText } from '../core/fsutil.ts';
import { matchBrace } from '../adapters/source.ts';

export interface DemoPlan {
  files: Map<string, string>;
  /** Existing files replaced on purpose (the template's main.dart, page or home screen). */
  rewrites: string[];
  summary: string[];
}

interface DemoInput {
  dir: string;
  type: 'flutter' | 'nextjs' | 'react-native' | 'android';
  architecture: string;
  name: string;
  /** Android: the app's package (com.example.shop). */
  androidPackage?: string;
}

const TASKS = [
  { id: 1, title: 'Read the codz guide', done: true },
  { id: 2, title: 'Add your API with codz feature add', done: false },
  { id: 3, title: 'Ship the first screen', done: false },
];

const flutterTitle = (name: string) => name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** The demo screen for a new project, or null when the architecture has none (none, or not known). */
export function planDemo(d: DemoInput): DemoPlan | null {
  if (d.architecture === 'none') return null;
  const read = (p: string) => readText(join(d.dir, p));
  const plan: DemoPlan = { files: new Map(), rewrites: [], summary: [] };
  const write = (path: string, content: string) => {
    if (read(path) !== null) plan.rewrites.push(path);
    plan.files.set(path, content);
  };
  if (d.type === 'flutter') return flutterDemo(d, read, write, plan);
  if (d.type === 'nextjs') return nextDemo(d, read, write, plan);
  if (d.type === 'react-native') return reactNativeDemo(d, read, write, plan);
  if (d.type === 'android') return androidDemo(d, read, write, plan);
  return null;
}

type Read = (p: string) => string | null;
type Write = (p: string, content: string) => void;

// ---------------------------------------------------------------- Flutter

function dartTasksSource(): string {
  return [
    '/// One row of the demo list.',
    'class DemoTask {',
    '  const DemoTask({required this.id, required this.title, this.done = false});',
    '',
    '  final int id;',
    '  final String title;',
    '  final bool done;',
    '',
    '  DemoTask copyWith({bool? done}) => DemoTask(id: id, title: title, done: done ?? this.done);',
    '}',
    '',
    '/// Stands in for an API: returns sample tasks after a short delay.',
    '/// Replace it with real endpoints: codz api add, or codz feature add <name> --spec api.yaml.',
    'class DemoTaskSource {',
    '  Future<List<DemoTask>> load() async {',
    '    await Future<void>.delayed(const Duration(milliseconds: 400));',
    '    return const [',
    ...TASKS.map((t) => `      DemoTask(id: ${t.id}, title: '${t.title}'${t.done ? ', done: true' : ''}),`),
    '    ];',
    '  }',
    '}',
    '',
  ].join('\n');
}

const dartIntro = (text: string) => [`          const Padding(`, `            padding: EdgeInsets.fromLTRB(16, 16, 16, 8),`, `            child: Text('${text}'),`, '          ),'];

function flutterMain(d: DemoInput, arch: string): string {
  const title = flutterTitle(d.name);
  const pkg = `package:${d.name}`;
  const theme = ['      theme: ThemeData(', '        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),', '        useMaterial3: true,', '      ),'];
  if (arch === 'getx') {
    return [
      `import '${pkg}/app/bindings/initial_binding.dart';`,
      `import '${pkg}/app/routes/app_pages.dart';`,
      "import 'package:flutter/material.dart';",
      "import 'package:get/get.dart';",
      '',
      'void main() {',
      '  runApp(const MyApp());',
      '}',
      '',
      'class MyApp extends StatelessWidget {',
      '  const MyApp({super.key});',
      '',
      '  @override',
      '  Widget build(BuildContext context) {',
      '    return GetMaterialApp(',
      '      initialBinding: InitialBinding(),',
      '      initialRoute: AppPages.initial,',
      '      getPages: AppPages.routes,',
      `      title: '${title}',`,
      ...theme,
      '    );',
      '  }',
      '}',
      '',
    ].join('\n');
  }
  const di = arch === 'bloc' || arch === 'get_it';
  return [
    ...(di ? [`import '${pkg}/core/di/injection.dart';`] : []),
    `import '${pkg}/features/home/home_page.dart';`,
    "import 'package:flutter/material.dart';",
    ...(arch === 'riverpod' ? ["import 'package:flutter_riverpod/flutter_riverpod.dart';"] : []),
    '',
    'void main() {',
    ...(di ? ['  setupDependencies();'] : []),
    `  runApp(${arch === 'riverpod' ? 'const ProviderScope(child: MyApp())' : 'const MyApp()'});`,
    '}',
    '',
    'class MyApp extends StatelessWidget {',
    '  const MyApp({super.key});',
    '',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    return MaterialApp(',
    `      title: '${title}',`,
    ...theme,
    '      home: const HomePage(),',
    '    );',
    '  }',
    '}',
    '',
  ]
    .join('\n')
    .replace(/^(import [^\n]+\n)+/, (block) => block.split('\n').filter(Boolean).sort().join('\n') + '\n');
}

function flutterTest(d: DemoInput, arch: string): string {
  const di = arch === 'bloc' || arch === 'get_it';
  return [
    ...(di ? [`import 'package:${d.name}/core/di/injection.dart';`] : []),
    `import 'package:${d.name}/main.dart';`,
    ...(arch === 'riverpod' ? ["import 'package:flutter_riverpod/flutter_riverpod.dart';"] : []),
    "import 'package:flutter_test/flutter_test.dart';",
    '',
    'void main() {',
    "  testWidgets('the home page lists the demo tasks', (WidgetTester tester) async {",
    ...(di ? ['    setupDependencies();'] : []),
    `    await tester.pumpWidget(${arch === 'riverpod' ? 'const ProviderScope(child: MyApp())' : 'const MyApp()'});`,
    '    await tester.pump(const Duration(seconds: 1));',
    '    await tester.pump();',
    `    expect(find.text('${TASKS[2].title}'), findsOneWidget);`,
    '  });',
    '}',
    '',
  ].join('\n');
}

const checkboxRow = (task: string, onChanged: string) => [
  `            CheckboxListTile(`,
  `              value: ${task}.done,`,
  `              title: Text(${task}.title),`,
  `              onChanged: (_) => ${onChanged},`,
  '            ),',
];

function flutterDemo(d: DemoInput, read: Read, write: Write, plan: DemoPlan): DemoPlan | null {
  const arch = d.architecture;
  const pkg = `package:${d.name}`;
  const title = flutterTitle(d.name);
  if (arch === 'riverpod') {
    write('lib/features/home/demo_tasks.dart', dartTasksSource());
    write(
      'lib/features/home/home_controller.dart',
      [
        "import 'package:flutter_riverpod/flutter_riverpod.dart';",
        `import '${pkg}/features/home/demo_tasks.dart';`,
        '',
        'final demoTaskSourceProvider = Provider<DemoTaskSource>((ref) => DemoTaskSource());',
        '',
        '/// Holds the task list: loading, then the tasks (or the error).',
        'final homeControllerProvider = AsyncNotifierProvider<HomeController, List<DemoTask>>(HomeController.new);',
        '',
        'class HomeController extends AsyncNotifier<List<DemoTask>> {',
        '  @override',
        '  Future<List<DemoTask>> build() => ref.read(demoTaskSourceProvider).load();',
        '',
        '  Future<void> reload() async {',
        '    state = const AsyncLoading();',
        '    state = await AsyncValue.guard(() => ref.read(demoTaskSourceProvider).load());',
        '  }',
        '',
        '  void toggle(int id) {',
        '    final tasks = state.valueOrNull;',
        '    if (tasks == null) return;',
        '    state = AsyncData([for (final t in tasks) t.id == id ? t.copyWith(done: !t.done) : t]);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    write(
      'lib/features/home/home_page.dart',
      [
        "import 'package:flutter/material.dart';",
        "import 'package:flutter_riverpod/flutter_riverpod.dart';",
        `import '${pkg}/features/home/home_controller.dart';`,
        '',
        'class HomePage extends ConsumerWidget {',
        '  const HomePage({super.key});',
        '',
        '  @override',
        '  Widget build(BuildContext context, WidgetRef ref) {',
        '    final tasks = ref.watch(homeControllerProvider);',
        '    final controller = ref.read(homeControllerProvider.notifier);',
        '    return Scaffold(',
        `      appBar: AppBar(title: const Text('${title}')),`,
        '      body: tasks.when(',
        '        loading: () => const Center(child: CircularProgressIndicator()),',
        "        error: (error, _) => Center(child: Text('$error')),",
        '        data: (items) => RefreshIndicator(',
        '          onRefresh: controller.reload,',
        '          child: ListView(',
        '            children: [',
        ...dartIntro('Riverpod: HomeController (an AsyncNotifier) holds the list; this page watches it.').map((l) => `    ${l}`),
        '              for (final task in items)',
        ...checkboxRow('task', 'controller.toggle(task.id)').map((l) => `    ${l}`),
        '            ],',
        '          ),',
        '        ),',
        '      ),',
        '    );',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  } else if (arch === 'bloc') {
    write('lib/features/home/demo_tasks.dart', dartTasksSource());
    write(
      'lib/features/home/home_cubit.dart',
      [
        "import 'package:flutter_bloc/flutter_bloc.dart';",
        `import '${pkg}/features/home/demo_tasks.dart';`,
        '',
        'sealed class HomeState {',
        '  const HomeState();',
        '}',
        '',
        'final class HomeLoading extends HomeState {',
        '  const HomeLoading();',
        '}',
        '',
        'final class HomeLoaded extends HomeState {',
        '  const HomeLoaded(this.tasks);',
        '',
        '  final List<DemoTask> tasks;',
        '}',
        '',
        'final class HomeFailure extends HomeState {',
        '  const HomeFailure(this.message);',
        '',
        '  final String message;',
        '}',
        '',
        'class HomeCubit extends Cubit<HomeState> {',
        '  HomeCubit(this._source) : super(const HomeLoading());',
        '',
        '  final DemoTaskSource _source;',
        '',
        '  Future<void> load() async {',
        '    emit(const HomeLoading());',
        '    try {',
        '      emit(HomeLoaded(await _source.load()));',
        '    } catch (e) {',
        '      emit(HomeFailure(e.toString()));',
        '    }',
        '  }',
        '',
        '  void toggle(int id) {',
        '    final s = state;',
        '    if (s is! HomeLoaded) return;',
        '    emit(HomeLoaded([for (final t in s.tasks) t.id == id ? t.copyWith(done: !t.done) : t]));',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    write(
      'lib/features/home/home_page.dart',
      [
        "import 'package:flutter/material.dart';",
        "import 'package:flutter_bloc/flutter_bloc.dart';",
        `import '${pkg}/core/di/injection.dart';`,
        `import '${pkg}/features/home/demo_tasks.dart';`,
        `import '${pkg}/features/home/home_cubit.dart';`,
        '',
        'class HomePage extends StatelessWidget {',
        '  const HomePage({super.key});',
        '',
        '  @override',
        '  Widget build(BuildContext context) {',
        '    return BlocProvider(',
        '      create: (_) => HomeCubit(getIt<DemoTaskSource>())..load(),',
        '      child: Scaffold(',
        `        appBar: AppBar(title: const Text('${title}')),`,
        '        body: BlocBuilder<HomeCubit, HomeState>(',
        '          builder: (context, state) => switch (state) {',
        '            HomeLoading() => const Center(child: CircularProgressIndicator()),',
        '            HomeFailure(:final message) => Center(child: Text(message)),',
        '            HomeLoaded(:final tasks) => RefreshIndicator(',
        '                onRefresh: context.read<HomeCubit>().load,',
        '                child: ListView(',
        '                  children: [',
        ...dartIntro('Bloc: HomeCubit holds the list; BlocBuilder shows each state.').map((l) => `          ${l}`),
        '                    for (final task in tasks)',
        ...checkboxRow('task', 'context.read<HomeCubit>().toggle(task.id)').map((l) => `          ${l}`),
        '                  ],',
        '                ),',
        '              ),',
        '          },',
        '        ),',
        '      ),',
        '    );',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    registerGetIt(read, write, pkg);
  } else if (arch === 'get_it') {
    write('lib/features/home/demo_tasks.dart', dartTasksSource());
    write(
      'lib/features/home/home_page.dart',
      [
        "import 'package:flutter/material.dart';",
        `import '${pkg}/core/di/injection.dart';`,
        `import '${pkg}/features/home/demo_tasks.dart';`,
        '',
        'class HomePage extends StatefulWidget {',
        '  const HomePage({super.key});',
        '',
        '  @override',
        '  State<HomePage> createState() => _HomePageState();',
        '}',
        '',
        'class _HomePageState extends State<HomePage> {',
        '  final _source = getIt<DemoTaskSource>();',
        '  List<DemoTask>? _tasks;',
        '',
        '  @override',
        '  void initState() {',
        '    super.initState();',
        '    _load();',
        '  }',
        '',
        '  Future<void> _load() async {',
        '    final tasks = await _source.load();',
        '    if (mounted) setState(() => _tasks = tasks);',
        '  }',
        '',
        '  void _toggle(int id) {',
        '    setState(() => _tasks = [for (final t in _tasks!) t.id == id ? t.copyWith(done: !t.done) : t]);',
        '  }',
        '',
        '  @override',
        '  Widget build(BuildContext context) {',
        '    final tasks = _tasks;',
        '    return Scaffold(',
        `      appBar: AppBar(title: const Text('${title}')),`,
        '      body: tasks == null',
        '          ? const Center(child: CircularProgressIndicator())',
        '          : RefreshIndicator(',
        '              onRefresh: _load,',
        '              child: ListView(',
        '                children: [',
        ...dartIntro('get_it: the page takes DemoTaskSource from the service locator.').map((l) => `        ${l}`),
        '                  for (final task in tasks)',
        ...checkboxRow('task', '_toggle(task.id)').map((l) => `        ${l}`),
        '                ],',
        '              ),',
        '            ),',
        '    );',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    registerGetIt(read, write, pkg);
  } else if (arch === 'getx') {
    // The module itself (binding, controller, view, route) comes from module add; these are its contents.
    write('lib/app/data/demo_tasks.dart', dartTasksSource());
    write(
      'lib/app/modules/home/bindings/home_binding.dart',
      [
        `import '${pkg}/app/data/demo_tasks.dart';`,
        `import '${pkg}/app/modules/home/controllers/home_controller.dart';`,
        "import 'package:get/get.dart';",
        '',
        'class HomeBinding extends Bindings {',
        '  @override',
        '  void dependencies() {',
        '    Get.lazyPut<DemoTaskSource>(() => DemoTaskSource());',
        '    Get.lazyPut<HomeController>(() => HomeController());',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    write(
      'lib/app/modules/home/controllers/home_controller.dart',
      [
        `import '${pkg}/app/data/demo_tasks.dart';`,
        "import 'package:get/get.dart';",
        '',
        'class HomeController extends GetxController {',
        '  final DemoTaskSource _source = Get.find<DemoTaskSource>();',
        '',
        '  final tasks = <DemoTask>[].obs;',
        '  final isLoading = false.obs;',
        '',
        '  @override',
        '  void onInit() {',
        '    super.onInit();',
        '    load();',
        '  }',
        '',
        '  Future<void> load() async {',
        '    isLoading.value = true;',
        '    tasks.assignAll(await _source.load());',
        '    isLoading.value = false;',
        '  }',
        '',
        '  void toggle(int id) {',
        '    final i = tasks.indexWhere((t) => t.id == id);',
        '    if (i >= 0) tasks[i] = tasks[i].copyWith(done: !tasks[i].done);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    write(
      'lib/app/modules/home/views/home_view.dart',
      [
        `import '${pkg}/app/modules/home/controllers/home_controller.dart';`,
        "import 'package:flutter/material.dart';",
        "import 'package:get/get.dart';",
        '',
        'class HomeView extends GetView<HomeController> {',
        '  const HomeView({super.key});',
        '',
        '  @override',
        '  Widget build(BuildContext context) {',
        '    return Scaffold(',
        `      appBar: AppBar(title: const Text('${title}')),`,
        '      body: Obx(() {',
        '        if (controller.isLoading.value) return const Center(child: CircularProgressIndicator());',
        '        return RefreshIndicator(',
        '          onRefresh: controller.load,',
        '          child: ListView(',
        '            children: [',
        ...dartIntro('GetX: HomeController holds the list as an RxList; Obx rebuilds this view.'),
        '              for (final task in controller.tasks)',
        ...checkboxRow('task', 'controller.toggle(task.id)').map((l) => `  ${l}`),
        '            ],',
        '          ),',
        '        );',
        '      }),',
        '    );',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  } else return null;
  write('lib/main.dart', flutterMain(d, arch));
  write('test/widget_test.dart', flutterTest(d, arch));
  const label = { riverpod: 'a Riverpod AsyncNotifier', bloc: 'a Cubit with BlocBuilder', get_it: 'a page that takes its data source from get_it', getx: 'a GetX module (binding, controller with an RxList, Obx view)' }[arch];
  plan.summary.push(`First screen: a demo task list built with ${label}, on sample data (no network)`);
  return plan;
}

function registerGetIt(read: Read, write: Write, pkg: string): void {
  const file = 'lib/core/di/injection.dart';
  const text = read(file);
  if (text === null || text.includes('DemoTaskSource')) return;
  const m = /void setupDependencies\(\)\s*\{/.exec(text);
  if (!m) return;
  const close = matchBrace(text, m.index + m[0].length - 1, 'dart');
  let t = `${text.slice(0, close).replace(/\s*$/, '')}\n  getIt.registerLazySingleton<DemoTaskSource>(DemoTaskSource.new);\n${text.slice(close)}`;
  const imp = `import '${pkg}/features/home/demo_tasks.dart';`;
  const imports = [...t.matchAll(/^import [^\n]+;$/gm)].map((x) => x[0]);
  const sorted = [...imports, imp].sort();
  t = t.replace(imports.join('\n'), sorted.join('\n'));
  write(file, t);
}

// ---------------------------------------------------------------- Next.js

function nextDemo(d: DemoInput, read: Read, write: Write, plan: DemoPlan): DemoPlan {
  const helper = d.architecture === 'fetch-helper';
  write(
    'lib/demo-tasks.ts',
    [
      'export interface DemoTask {',
      '  id: number;',
      '  title: string;',
      '  done: boolean;',
      '}',
      '',
      '/**',
      ' * Stands in for an API: returns sample tasks after a short delay.',
      ` * Replace it with real endpoints (codz api add, or codz feature add <name> --spec api.yaml), for example ${helper ? "apiFetch<DemoTask[]>('/tasks')" : "fetch(`${process.env.NEXT_PUBLIC_API_URL}/tasks`)"}.`,
      ' */',
      'export async function getDemoTasks(): Promise<DemoTask[]> {',
      '  await new Promise((resolve) => setTimeout(resolve, 200));',
      '  return [',
      ...TASKS.map((t) => `    { id: ${t.id}, title: '${t.title}', done: ${t.done} },`),
      '  ];',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'app/demo-task-list.tsx',
    [
      "'use client';",
      '',
      "import { useState } from 'react';",
      "import type { DemoTask } from '../lib/demo-tasks';",
      '',
      '/** The list in the browser: ticking a task is client state. */',
      'export default function DemoTaskList({ initial }: { initial: DemoTask[] }) {',
      '  const [tasks, setTasks] = useState(initial);',
      '  const toggle = (id: number) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));',
      '  return (',
      "    <ul style={{ listStyle: 'none', padding: 0 }}>",
      '      {tasks.map((task) => (',
      '        <li key={task.id}>',
      '          <label>',
      '            <input type="checkbox" checked={task.done} onChange={() => toggle(task.id)} /> {task.title}',
      '          </label>',
      '        </li>',
      '      ))}',
      '    </ul>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'app/page.tsx',
    [
      "import { getDemoTasks } from '../lib/demo-tasks';",
      "import DemoTaskList from './demo-task-list';",
      '',
      '/** A server component loads the data; the client component handles the clicks. */',
      'export default async function Home() {',
      '  const tasks = await getDemoTasks();',
      '  return (',
      "    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>",
      `      <h1>${d.name}</h1>`,
      `      <p>The page loads tasks on the server (${helper ? 'API functions in lib/api call apiFetch' : 'API functions in lib/api call fetch'}); ticking one is client state.</p>`,
      '      <DemoTaskList initial={tasks} />',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  void read;
  plan.summary.push('First screen: a demo task list (server component loads it, a client component ticks tasks off), on sample data (no network)');
  return plan;
}

// ---------------------------------------------------------------- React Native

function reactNativeDemo(d: DemoInput, read: Read, write: Write, plan: DemoPlan): DemoPlan | null {
  const query = d.architecture === 'axios-react-query';
  if (read('src/screens/HomeScreen.tsx') === null) return null;
  write(
    'src/demo/demoTasks.ts',
    [
      'export interface DemoTask {',
      '  id: number;',
      '  title: string;',
      '  done: boolean;',
      '}',
      '',
      '/**',
      ' * Stands in for an API: returns sample tasks after a short delay.',
      ` * Replace it with real endpoints (codz api add, or codz feature add <name> --spec api.yaml), for example ${d.architecture === 'fetch-helper' ? "apiFetch<DemoTask[]>('/tasks')" : "(await api.get<DemoTask[]>('/tasks')).data"}.`,
      ' */',
      'export async function getDemoTasks(): Promise<DemoTask[]> {',
      '  await new Promise((resolve) => setTimeout(resolve, 400));',
      '  return [',
      ...TASKS.map((t) => `    { id: ${t.id}, title: '${t.title}', done: ${t.done} },`),
      '  ];',
      '}',
      '',
    ].join('\n'),
  );
  const intro = query ? 'TanStack Query loads the tasks (useQuery); ticking one is local state.' : 'The screen loads the tasks in an effect and keeps them in state.';
  const body = query
    ? [
        "import { useQuery } from '@tanstack/react-query';",
        "import { useState } from 'react';",
        "import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';",
        "import { getDemoTasks } from '../demo/demoTasks';",
        '',
        'export default function HomeScreen() {',
        "  const { data, isLoading, error, refetch, isRefetching } = useQuery({ queryKey: ['demo-tasks'], queryFn: getDemoTasks });",
        '  const [flipped, setFlipped] = useState<Record<number, boolean>>({});',
        '  if (isLoading) {',
        '    return (',
        '      <View style={styles.center}>',
        '        <ActivityIndicator />',
        '      </View>',
        '    );',
        '  }',
        '  if (error || !data) {',
        '    return (',
        '      <View style={styles.center}>',
        '        <Text>{error instanceof Error ? error.message : String(error)}</Text>',
        '      </View>',
        '    );',
        '  }',
        '  return (',
        '    <FlatList',
        '      data={data}',
        '      keyExtractor={(task) => String(task.id)}',
        '      refreshing={isRefetching}',
        '      onRefresh={() => refetch()}',
        `      ListHeaderComponent={<Text style={styles.intro}>${intro}</Text>}`,
        '      renderItem={({ item }) => {',
        '        const done = flipped[item.id] ? !item.done : item.done;',
        '        return (',
        '          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: done }} style={styles.row} onPress={() => setFlipped((f) => ({ ...f, [item.id]: !f[item.id] }))}>',
        "            <Text style={styles.text}>{done ? '☑' : '☐'} {item.title}</Text>",
        '          </Pressable>',
        '        );',
        '      }}',
        '    />',
        '  );',
        '}',
      ]
    : [
        "import { useCallback, useEffect, useState } from 'react';",
        "import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';",
        "import { getDemoTasks, type DemoTask } from '../demo/demoTasks';",
        '',
        'export default function HomeScreen() {',
        '  const [tasks, setTasks] = useState<DemoTask[] | null>(null);',
        '  const [refreshing, setRefreshing] = useState(false);',
        '  const load = useCallback(async () => {',
        '    setTasks(await getDemoTasks());',
        '  }, []);',
        '',
        '  useEffect(() => {',
        '    load();',
        '  }, [load]);',
        '',
        '  const toggle = (id: number) => setTasks((ts) => ts && ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));',
        '  if (!tasks) {',
        '    return (',
        '      <View style={styles.center}>',
        '        <ActivityIndicator />',
        '      </View>',
        '    );',
        '  }',
        '  return (',
        '    <FlatList',
        '      data={tasks}',
        '      keyExtractor={(task) => String(task.id)}',
        '      refreshing={refreshing}',
        '      onRefresh={async () => {',
        '        setRefreshing(true);',
        '        await load();',
        '        setRefreshing(false);',
        '      }}',
        `      ListHeaderComponent={<Text style={styles.intro}>${intro}</Text>}`,
        '      renderItem={({ item }) => (',
        '        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: item.done }} style={styles.row} onPress={() => toggle(item.id)}>',
        "          <Text style={styles.text}>{item.done ? '☑' : '☐'} {item.title}</Text>",
        '        </Pressable>',
        '      )}',
        '    />',
        '  );',
        '}',
      ];
  write(
    'src/screens/HomeScreen.tsx',
    [
      ...body,
      '',
      'const styles = StyleSheet.create({',
      "  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },",
      '  intro: { padding: 16, color: \'#555\' },',
      "  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },",
      '  text: { fontSize: 16 },',
      '});',
      '',
    ].join('\n'),
  );
  plan.summary.push(`First screen: a demo task list ${query ? 'loaded with TanStack Query (useQuery)' : 'loaded in an effect and kept in state'}, on sample data (no network)`);
  return plan;
}

// ---------------------------------------------------------------- Android

function androidDemo(d: DemoInput, read: Read, write: Write, plan: DemoPlan): DemoPlan | null {
  const pkg = d.androidPackage;
  if (!pkg) return null;
  const base = `app/src/main/java/${pkg.replace(/\./g, '/')}`;
  if (read(`${base}/ui/screens/HomeScreen.kt`) === null) return null;
  const arch = d.architecture;
  const hilt = arch === 'retrofit-hilt';
  const koin = arch === 'retrofit-koin';
  const title = flutterTitle(d.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase());
  if (read(`${base}/ui/UiState.kt`) === null) {
    write(`${base}/ui/UiState.kt`, `package ${pkg}.ui\n\n/** What a screen shows while it loads data, when it has it, and when loading failed. */\nsealed interface UiState<out T> {\n    data object Loading : UiState<Nothing>\n\n    data class Success<T>(val data: T) : UiState<T>\n\n    data class Error(val message: String) : UiState<Nothing>\n}\n`);
  }
  write(
    `${base}/data/demo/DemoTaskSource.kt`,
    [
      `package ${pkg}.data.demo`,
      '',
      ...(hilt ? ['import javax.inject.Inject'] : []),
      'import kotlinx.coroutines.delay',
      '',
      '/** One row of the demo list. */',
      'data class DemoTask(val id: Int, val title: String, val done: Boolean = false)',
      '',
      '/**',
      ' * Stands in for an API: returns sample tasks after a short delay.',
      ' * Replace it with real endpoints: codz api add, or codz feature add <name> --spec api.yaml.',
      ' */',
      `class DemoTaskSource${hilt ? ' @Inject constructor()' : ''} {`,
      '    suspend fun load(): List<DemoTask> {',
      '        delay(400)',
      '        return listOf(',
      ...TASKS.map((t) => `            DemoTask(${t.id}, "${t.title}"${t.done ? ', done = true' : ''}),`),
      '        )',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  const vmHeader = hilt ? ['@HiltViewModel', 'class HomeViewModel @Inject constructor(private val source: DemoTaskSource) : ViewModel() {'] : ['class HomeViewModel(private val source: DemoTaskSource) : ViewModel() {'];
  const vm = [
    `package ${pkg}.ui.screens`,
    '',
    ...vmHeader,
    '    private val _state = MutableStateFlow<UiState<List<DemoTask>>>(UiState.Loading)',
    '    val state: StateFlow<UiState<List<DemoTask>>> = _state.asStateFlow()',
    '',
    '    init {',
    '        load()',
    '    }',
    '',
    '    fun load() {',
    '        viewModelScope.launch {',
    '            _state.value = UiState.Loading',
    '            _state.value = try {',
    '                UiState.Success(source.load())',
    '            } catch (e: Exception) {',
    '                UiState.Error(e.message ?: "Something went wrong")',
    '            }',
    '        }',
    '    }',
    '',
    '    fun toggle(id: Int) {',
    '        val current = _state.value as? UiState.Success ?: return',
    '        _state.value = UiState.Success(current.data.map { if (it.id == id) it.copy(done = !it.done) else it })',
    '    }',
    ...(!hilt && !koin ? ['', '    companion object {', '        val Factory: ViewModelProvider.Factory = viewModelFactory {', '            initializer { HomeViewModel(DemoTaskSource()) }', '        }', '    }'] : []),
    '}',
    '',
  ].join('\n');
  write(
    `${base}/ui/screens/HomeViewModel.kt`,
    addKotlinImports(
      vm,
      [
        'androidx.lifecycle.ViewModel',
        'androidx.lifecycle.viewModelScope',
        'kotlinx.coroutines.flow.MutableStateFlow',
        'kotlinx.coroutines.flow.StateFlow',
        'kotlinx.coroutines.flow.asStateFlow',
        'kotlinx.coroutines.launch',
        `${pkg}.data.demo.DemoTask`,
        `${pkg}.data.demo.DemoTaskSource`,
        `${pkg}.ui.UiState`,
        ...(hilt ? ['dagger.hilt.android.lifecycle.HiltViewModel', 'javax.inject.Inject'] : []),
        ...(!hilt && !koin ? ['androidx.lifecycle.ViewModelProvider', 'androidx.lifecycle.viewmodel.initializer', 'androidx.lifecycle.viewmodel.viewModelFactory'] : []),
      ],
      `${pkg}.ui.screens`,
    ),
  );
  const vmDefault = hilt ? 'hiltViewModel()' : koin ? 'koinViewModel()' : 'viewModel(factory = HomeViewModel.Factory)';
  const intro = hilt ? 'Hilt injects HomeViewModel; the screen collects its StateFlow.' : koin ? 'Koin provides HomeViewModel; the screen collects its StateFlow.' : 'HomeViewModel comes from its Factory; the screen collects its StateFlow.';
  const screen = [
    `package ${pkg}.ui.screens`,
    '',
    '@OptIn(ExperimentalMaterial3Api::class)',
    '@Composable',
    `fun HomeScreen(viewModel: HomeViewModel = ${vmDefault}) {`,
    '    val state by viewModel.state.collectAsState()',
    `    Scaffold(topBar = { TopAppBar(title = { Text("${title}") }) }) { padding ->`,
    '        Box(Modifier.fillMaxSize().padding(padding)) {',
    '            when (val s = state) {',
    '                is UiState.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))',
    '                is UiState.Error -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {',
    '                    Text(s.message, color = MaterialTheme.colorScheme.error)',
    '                    Button(onClick = viewModel::load) { Text("Retry") }',
    '                }',
    '                is UiState.Success -> LazyColumn(Modifier.fillMaxSize()) {',
    `                    item { Text("${intro}", Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium) }`,
    '                    items(s.data, key = { it.id }) { task ->',
    '                        Row(',
    '                            Modifier.fillMaxWidth().clickable { viewModel.toggle(task.id) }.padding(horizontal = 16.dp, vertical = 8.dp),',
    '                            verticalAlignment = Alignment.CenterVertically,',
    '                        ) {',
    '                            Checkbox(checked = task.done, onCheckedChange = { viewModel.toggle(task.id) })',
    '                            Text(task.title)',
    '                        }',
    '                    }',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  write(
    `${base}/ui/screens/HomeScreen.kt`,
    addKotlinImports(
      screen,
      [
        'androidx.compose.foundation.clickable',
        'androidx.compose.foundation.layout.Box',
        'androidx.compose.foundation.layout.Column',
        'androidx.compose.foundation.layout.Row',
        'androidx.compose.foundation.layout.fillMaxSize',
        'androidx.compose.foundation.layout.fillMaxWidth',
        'androidx.compose.foundation.layout.padding',
        'androidx.compose.foundation.lazy.LazyColumn',
        'androidx.compose.foundation.lazy.items',
        'androidx.compose.material3.Button',
        'androidx.compose.material3.Checkbox',
        'androidx.compose.material3.CircularProgressIndicator',
        'androidx.compose.material3.ExperimentalMaterial3Api',
        'androidx.compose.material3.MaterialTheme',
        'androidx.compose.material3.Scaffold',
        'androidx.compose.material3.Text',
        'androidx.compose.material3.TopAppBar',
        'androidx.compose.runtime.Composable',
        'androidx.compose.runtime.collectAsState',
        'androidx.compose.runtime.getValue',
        'androidx.compose.ui.Alignment',
        'androidx.compose.ui.Modifier',
        'androidx.compose.ui.unit.dp',
        `${pkg}.ui.UiState`,
        hilt ? 'androidx.hilt.navigation.compose.hiltViewModel' : koin ? 'org.koin.androidx.compose.koinViewModel' : 'androidx.lifecycle.viewmodel.compose.viewModel',
      ],
      `${pkg}.ui.screens`,
    ),
  );
  if (koin) {
    const di = `${base}/di/NetworkModule.kt`;
    const text = read(di);
    const m = text ? /\bmodule\s*\{/.exec(text) : null;
    if (text && m) {
      const close = matchBrace(text, m.index + m[0].length - 1, 'dart');
      let t = `${text.slice(0, close).replace(/\s*$/, '')}\n    singleOf(::DemoTaskSource)\n    viewModelOf(::HomeViewModel)\n${text.slice(close)}`;
      t = addKotlinImports(t, ['org.koin.core.module.dsl.singleOf', 'org.koin.core.module.dsl.viewModelOf', `${pkg}.data.demo.DemoTaskSource`, `${pkg}.ui.screens.HomeViewModel`], `${pkg}.di`);
      write(di, t);
    }
  }
  plan.summary.push(`First screen: a demo task list with HomeViewModel (${hilt ? 'Hilt' : koin ? 'Koin' : 'its own Factory'}) and a StateFlow, on sample data (no network)`);
  return plan;
}
