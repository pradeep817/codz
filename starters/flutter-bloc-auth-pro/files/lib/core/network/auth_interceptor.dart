import 'package:dio/dio.dart';
import 'package:{{appName}}/core/storage/token_storage.dart';

/// Sends "Authorization: Bearer <token>". On a 401 it refreshes the token once
/// (POST /auth/refresh with the refresh token) and repeats the request; if that fails, the session ends.
class AuthInterceptor extends QueuedInterceptor {
  AuthInterceptor({required this.tokens, required this.retry, required this.refresh});

  final TokenStorage tokens;

  /// Sends a request again through the app's Dio.
  final Future<Response<dynamic>> Function(RequestOptions request) retry;

  /// Exchanges a refresh token for { token, refreshToken? } without going through this interceptor.
  final Future<Map<String, dynamic>> Function(String refreshToken) refresh;

  static const _retried = 'auth_retried';

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await tokens.accessToken;
    if (token != null) options.headers['Authorization'] = 'Bearer $token';
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final request = err.requestOptions;
    final isAuthCall = request.path.startsWith('/auth/login') || request.path.startsWith('/auth/refresh');
    if (err.response?.statusCode != 401 || isAuthCall || request.extra[_retried] == true) {
      return handler.next(err);
    }
    final refreshToken = await tokens.refreshToken;
    if (refreshToken == null) {
      await _endSession();
      return handler.next(err);
    }
    try {
      final data = await refresh(refreshToken);
      await tokens.save(access: data['token'] as String, refresh: data['refreshToken'] as String?);
      request.extra[_retried] = true;
      handler.resolve(await retry(request));
    } on DioException {
      await _endSession();
      handler.next(err);
    }
  }

  Future<void> _endSession() async {
    await tokens.clear();
    tokens.expire();
  }
}
