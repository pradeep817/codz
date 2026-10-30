import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:{{appName}}/core/storage/token_storage.dart';
import 'package:{{appName}}/data/models/user_model.dart';
import 'package:{{appName}}/data/repositories/auth_repository.dart';
import 'package:{{appName}}/features/auth/auth_bloc.dart';
import 'package:{{appName}}/features/auth/login_page.dart';

class _FakeTokens extends TokenStorage {
  @override
  Future<String?> get accessToken async => null;
}

class _FakeRepo extends AuthRepository {
  _FakeRepo() : super(Dio(), _FakeTokens());

  @override
  Future<UserModel> login(String email, String password) async =>
      UserModel(id: '1', name: 'Asha', email: email);
}

void main() {
  testWidgets('the login form checks its fields, then signs in', (tester) async {
    final bloc = AuthBloc(_FakeRepo(), _FakeTokens());
    await tester.pumpWidget(MaterialApp(home: BlocProvider.value(value: bloc, child: const LoginPage())));

    await tester.tap(find.text('Sign in'));
    await tester.pump();
    expect(find.text('Enter your email address.'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField).first, 'asha@example.com');
    await tester.enterText(find.byType(TextFormField).last, 'secret');
    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();
    expect(bloc.state.status, AuthStatus.signedIn);
    expect(bloc.state.user?.name, 'Asha');
  });
}
