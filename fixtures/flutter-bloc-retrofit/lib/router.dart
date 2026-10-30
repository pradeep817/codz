import 'package:go_router/go_router.dart';
import 'package:task_board/features/tasks/tasks_page.dart';

final router = GoRouter(
  routes: [
    GoRoute(path: '/', name: 'tasks', builder: (context, state) => const TasksPage()),
  ],
);
