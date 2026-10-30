import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The API address. Override it per build: flutter run --dart-define=API_BASE_URL=https://staging.example.com
const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: '{{apiBaseUrl}}');

/// Creates the Dio instance that every repository uses.
///
/// Add auth headers or token refresh here with an interceptor.
Dio createDio() {
  final dio = Dio(
    BaseOptions(
      baseUrl: apiBaseUrl,
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
