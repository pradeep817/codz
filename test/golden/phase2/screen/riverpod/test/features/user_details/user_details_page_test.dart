import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shop_app/data/repositories/user_repository.dart';
import 'package:shop_app/features/user_details/user_details_page.dart';

/// Answers requests in turn with [bodies] (the last one again after that), all with [status].
class _FakeApi implements HttpClientAdapter {
  _FakeApi(this.status, this.bodies);

  final int status;
  final List<Object?> bodies;
  int calls = 0;

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    final body = bodies[calls < bodies.length ? calls : bodies.length - 1];
    calls++;
    return ResponseBody.fromString(jsonEncode(body), status, headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    });
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  testWidgets('UserDetailsPage shows a spinner, then the data', (tester) async {
    final data = {
      'id': 1,
      'name': 'Sample name 1',
      'email': 'user1@example.com',
    };
    await tester.pumpWidget(ProviderScope(overrides: [userRepositoryProvider.overrideWithValue(UserRepository(Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = _FakeApi(200, [data])))], child: MaterialApp(home: const UserDetailsPage(id: '1'))));
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    await tester.pumpAndSettle();
    expect(find.text('Sample name 1'), findsWidgets);
  });

  testWidgets('UserDetailsPage shows the error with Retry', (tester) async {
    await tester.pumpWidget(ProviderScope(overrides: [userRepositoryProvider.overrideWithValue(UserRepository(Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = _FakeApi(500, [{'error': 'nope'}])))], child: MaterialApp(home: const UserDetailsPage(id: '1'))));
    await tester.pumpAndSettle();
    expect(find.text('Retry'), findsOneWidget);
  });
}
