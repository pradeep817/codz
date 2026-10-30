import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:{{appName}}/app/shell.dart';
import 'package:{{appName}}/features/auth/auth_bloc.dart';
import 'package:{{appName}}/features/auth/login_page.dart';
import 'package:{{appName}}/features/home/home_page.dart';
import 'package:{{appName}}/features/settings/settings_page.dart';

/// Every screen of the app. Signed-out users only reach /login; signed-in users never see it.
GoRouter createRouter(AuthBloc auth) {
  return GoRouter(
    initialLocation: '/',
    refreshListenable: _StreamListenable(auth.stream),
    redirect: (context, state) {
      final status = auth.state.status;
      if (status == AuthStatus.unknown) return null;
      final atLogin = state.matchedLocation == '/login';
      if (status == AuthStatus.signedOut) return atLogin ? null : '/login';
      return atLogin ? '/' : null;
    },
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginPage()),
      ShellRoute(
        builder: (context, state, child) => AppShell(location: state.matchedLocation, child: child),
        routes: [
          GoRoute(path: '/', builder: (context, state) => const HomePage()),
          GoRoute(path: '/settings', builder: (context, state) => const SettingsPage()),
        ],
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      appBar: AppBar(title: const Text('Not found')),
      body: Center(child: Text('No page at ${state.uri.path}')),
    ),
  );
}

/// Lets go_router re-check the redirect whenever the auth state changes.
class _StreamListenable extends ChangeNotifier {
  _StreamListenable(Stream<Object?> stream) {
    _sub = stream.listen((_) => notifyListeners());
  }

  late final StreamSubscription<Object?> _sub;

  @override
  void dispose() {
    _sub.cancel();
    super.dispose();
  }
}
