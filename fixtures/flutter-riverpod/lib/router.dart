import 'package:go_router/go_router.dart';

import 'features/home/home_page.dart';
import 'features/profile/profile_page.dart';

final router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      name: 'home',
      builder: (context, state) => const HomePage(),
    ),
    GoRoute(
      path: '/profile/:id',
      name: 'profile',
      builder: (context, state) => ProfilePage(id: int.parse(state.pathParameters['id']!)),
    ),
  ],
);
