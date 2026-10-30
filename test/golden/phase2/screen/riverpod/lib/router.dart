import 'package:go_router/go_router.dart';

import 'features/home/home_page.dart';
import 'features/profile/profile_page.dart';
import 'features/user_details/user_details_page.dart';

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
    GoRoute(
      path: '/users/:id',
      name: 'userDetails',
      builder: (context, state) => UserDetailsPage(id: state.pathParameters['id']!),
    ),
  ],
);
