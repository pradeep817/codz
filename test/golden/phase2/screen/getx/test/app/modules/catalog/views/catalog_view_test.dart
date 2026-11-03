import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get/get.dart';
import 'package:project/app/data/repositories/product_repository.dart';
import 'package:project/app/modules/catalog/controllers/catalog_controller.dart';
import 'package:project/app/modules/catalog/views/catalog_view.dart';

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
  tearDown(Get.reset);

  testWidgets('CatalogView shows a spinner, then the data', (tester) async {
    final data = [
      {
        'id': 1,
        'name': 'Sample name 1',
        'price': 19.99,
        'in_stock': true,
        'tags': [
          'Sample tags',
          'Sample tags',
        ],
        'discount': 4.5,
      },
      {
        'id': 2,
        'name': 'Sample name 2',
        'price': 19.99,
        'in_stock': true,
        'tags': [
          'Sample tags',
          'Sample tags',
        ],
        'discount': 4.5,
      },
    ];
    Get.put<ProductRepository>(ProductRepository(Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = _FakeApi(200, [data])));
    Get.put(CatalogController());
    await tester.pumpWidget(GetMaterialApp(home: const CatalogView()));
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    await tester.pumpAndSettle();
    expect(find.text('Sample name 1'), findsWidgets);
  });

  testWidgets('CatalogView says when there is nothing to show', (tester) async {
    Get.put<ProductRepository>(ProductRepository(Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = _FakeApi(200, [[]])));
    Get.put(CatalogController());
    await tester.pumpWidget(GetMaterialApp(home: const CatalogView()));
    await tester.pumpAndSettle();
    expect(find.text('No items'), findsOneWidget);
  });

  testWidgets('CatalogView shows the error with Retry', (tester) async {
    Get.put<ProductRepository>(ProductRepository(Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = _FakeApi(500, [{'error': 'nope'}])));
    Get.put(CatalogController());
    await tester.pumpWidget(GetMaterialApp(home: const CatalogView()));
    await tester.pumpAndSettle();
    expect(find.text('Retry'), findsOneWidget);
  });
}
