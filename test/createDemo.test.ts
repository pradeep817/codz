// codz create: the first screen is a demo task list written in the chosen
// architecture (not the platform template's setState counter).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createProject, type CreateOptions } from '../src/skills/create.ts';

async function made(o: Partial<CreateOptions> & Pick<CreateOptions, 'type' | 'name' | 'architecture'>): Promise<{ dir: string; read: (p: string) => string; done: () => void }> {
  const parent = mkdtempSync(join(tmpdir(), 'codz-demo-'));
  const r = await createProject({ parent, baseUrl: 'https://api.example.com', org: 'com.acme', install: false, git: false, offline: true, ...o } as CreateOptions);
  return { dir: r.dir, read: (p) => readFileSync(join(r.dir, p), 'utf8'), done: () => rmSync(parent, { recursive: true, force: true }) };
}

describe('codz create: a first screen in the chosen architecture', () => {
  const flutter: [string, string, RegExp[]][] = [
    ['riverpod', 'lib/features/home/home_page.dart', [/class HomePage extends ConsumerWidget/, /ref\.watch\(homeControllerProvider\)/]],
    ['bloc', 'lib/features/home/home_page.dart', [/BlocProvider\(\n\s+create: \(_\) => HomeCubit\(getIt<DemoTaskSource>\(\)\)\.\.load\(\)/, /BlocBuilder<HomeCubit, HomeState>/]],
    ['get_it', 'lib/features/home/home_page.dart', [/final _source = getIt<DemoTaskSource>\(\);/]],
    ['getx', 'lib/app/modules/home/views/home_view.dart', [/class HomeView extends GetView<HomeController>/, /body: Obx\(/]],
  ];
  for (const [arch, page, patterns] of flutter) {
    it(`Flutter + ${arch}: the home page uses ${arch}, main.dart opens it, and the widget test looks for the demo tasks`, async () => {
      const p = await made({ type: 'flutter', name: `shop_${arch}`, architecture: arch });
      try {
        const text = p.read(page);
        for (const re of patterns) assert.match(text, re);
        const main = p.read('lib/main.dart');
        assert.doesNotMatch(main, /setState|_counter|class HomePage/);
        assert.match(p.read('test/widget_test.dart'), /expect\(find\.text\('Ship the first screen'\), findsOneWidget\)/);
        if (arch === 'getx') assert.match(main, /initialRoute: AppPages\.initial/);
        else assert.match(main, /home: const HomePage\(\)/);
        if (arch === 'riverpod') assert.match(main, /runApp\(const ProviderScope\(child: MyApp\(\)\)\)/);
        if (arch === 'bloc' || arch === 'get_it') assert.match(p.read('lib/core/di/injection.dart'), /getIt\.registerLazySingleton<DemoTaskSource>\(DemoTaskSource\.new\);/);
        if (arch === 'getx') assert.match(p.read('lib/app/modules/home/bindings/home_binding.dart'), /Get\.lazyPut<DemoTaskSource>/);
      } finally {
        p.done();
      }
    });
  }

  it('Next.js: a server component loads the demo tasks and a client component ticks them off', async () => {
    const p = await made({ type: 'nextjs', name: 'shop-web', architecture: 'fetch-helper' });
    try {
      assert.match(p.read('app/page.tsx'), /const tasks = await getDemoTasks\(\);[\s\S]*<DemoTaskList initial=\{tasks\} \/>/);
      assert.match(p.read('app/demo-task-list.tsx'), /^'use client';/);
    } finally {
      p.done();
    }
  });

  it('React Native: useQuery with TanStack Query, plain state otherwise', async () => {
    const q = await made({ type: 'react-native', name: 'shop-rq', architecture: 'axios-react-query' });
    const f = await made({ type: 'react-native', name: 'shop-rf', architecture: 'fetch-helper', flavor: 'bare' });
    try {
      assert.match(q.read('src/screens/HomeScreen.tsx'), /useQuery\(\{ queryKey: \['demo-tasks'\], queryFn: getDemoTasks \}\)/);
      assert.match(f.read('src/screens/HomeScreen.tsx'), /const \[tasks, setTasks\] = useState<DemoTask\[\] \| null>\(null\);/);
    } finally {
      q.done();
      f.done();
    }
  });

  for (const [arch, vm, screen] of [
    ['retrofit-hilt', /@HiltViewModel\nclass HomeViewModel @Inject constructor\(private val source: DemoTaskSource\)/, /fun HomeScreen\(viewModel: HomeViewModel = hiltViewModel\(\)\)/],
    ['retrofit-koin', /class HomeViewModel\(private val source: DemoTaskSource\) : ViewModel\(\)/, /koinViewModel\(\)/],
    ['retrofit', /initializer \{ HomeViewModel\(DemoTaskSource\(\)\) \}/, /viewModel\(factory = HomeViewModel\.Factory\)/],
  ] as const) {
    it(`Android + ${arch}: HomeViewModel with a StateFlow, wired the ${arch} way`, async () => {
      const p = await made({ type: 'android', name: `shop${arch.replace(/-/g, '')}`, architecture: arch });
      try {
        const base = `app/src/main/java/com/acme/shop${arch.replace(/-/g, '')}`;
        assert.match(p.read(`${base}/ui/screens/HomeViewModel.kt`), vm);
        assert.match(p.read(`${base}/ui/screens/HomeScreen.kt`), screen);
        assert.ok(existsSync(join(p.dir, `${base}/ui/UiState.kt`)));
        if (arch === 'retrofit-koin') assert.match(p.read(`${base}/di/NetworkModule.kt`), /singleOf\(::DemoTaskSource\)\n\s+viewModelOf\(::HomeViewModel\)/);
      } finally {
        p.done();
      }
    });
  }

  it('architecture none keeps the template', async () => {
    const p = await made({ type: 'flutter', name: 'plain_app', architecture: 'none' });
    try {
      assert.ok(!existsSync(join(p.dir, 'lib/features/home')));
    } finally {
      p.done();
    }
  });
});
