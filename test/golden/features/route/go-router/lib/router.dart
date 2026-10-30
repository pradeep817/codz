import 'package:go_router/go_router.dart';

import 'features/home/home_page.dart';
import 'features/order_details/order_details_page.dart';
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
    GoRoute(
      path: '/orders/:orderId',
      name: 'orderDetails',
      builder: (context, state) => OrderDetailsPage(orderId: state.pathParameters['orderId']!),
    ),
  ],
);
