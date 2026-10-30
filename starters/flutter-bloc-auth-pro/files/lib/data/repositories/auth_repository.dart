import 'package:dio/dio.dart';
import 'package:{{appName}}/core/storage/token_storage.dart';
import 'package:{{appName}}/data/models/user_model.dart';

/// Sign-in calls. Change the paths and field names to match your API.
class AuthRepository {
  AuthRepository(this._dio, this._tokens);

  final Dio _dio;
  final TokenStorage _tokens;

  /// POST /auth/login → { token, refreshToken?, user }
  Future<UserModel> login(String email, String password) async {
    final res = await _dio.post<Map<String, dynamic>>('/auth/login', data: {'email': email, 'password': password});
    final data = res.data!;
    await _tokens.save(access: data['token'] as String, refresh: data['refreshToken'] as String?);
    return UserModel.fromJson(data['user'] as Map<String, dynamic>);
  }

  /// GET /auth/me
  Future<UserModel> me() async {
    final res = await _dio.get<Map<String, dynamic>>('/auth/me');
    return UserModel.fromJson(res.data!);
  }

  Future<bool> hasSession() async => await _tokens.accessToken != null;

  Future<void> logout() async {
    try {
      await _dio.post<void>('/auth/logout');
    } on DioException {
      // Signed out on this device either way.
    }
    await _tokens.clear();
  }
}
