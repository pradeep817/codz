import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:project/app/data/network/mocks/mock_interceptor.dart';

/// Creates the Dio instance that every repository uses.
///
/// Add auth headers or token refresh here with an interceptor.
Dio createDio() {
  final dio = Dio(
    BaseOptions(
      baseUrl: 'https://api.yourapp.com',
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 20),
      headers: {'Accept': 'application/json'},
    ),
  );
  if (kDebugMode) {
    dio.interceptors.add(LogInterceptor(requestBody: true, responseBody: true));
  }
  if (MockInterceptor.enabled) dio.interceptors.add(MockInterceptor());
  return dio;
}
