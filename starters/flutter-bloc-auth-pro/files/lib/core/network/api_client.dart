import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:{{appName}}/core/network/auth_interceptor.dart';
import 'package:{{appName}}/core/storage/token_storage.dart';

/// The API address. Override it per build: flutter run --dart-define=API_BASE_URL=https://staging.example.com
const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: '{{apiBaseUrl}}');

BaseOptions _options() => BaseOptions(
      baseUrl: apiBaseUrl,
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 20),
      headers: {'Accept': 'application/json'},
    );

/// Creates the Dio instance that every repository uses: it sends the access token and refreshes it on a 401.
Dio createDio(TokenStorage tokens) {
  final dio = Dio(_options());
  final refreshClient = Dio(_options());
  dio.interceptors.add(
    AuthInterceptor(
      tokens: tokens,
      retry: (request) => dio.fetch<dynamic>(request),
      refresh: (refreshToken) async {
        final res = await refreshClient.post<Map<String, dynamic>>('/auth/refresh', data: {'refreshToken': refreshToken});
        return res.data!;
      },
    ),
  );
  if (kDebugMode) {
    dio.interceptors.add(LogInterceptor(requestBody: true, responseBody: true));
  }
  return dio;
}
