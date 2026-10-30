import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
  return dio;
}

final dioProvider = Provider<Dio>((ref) => createDio());
