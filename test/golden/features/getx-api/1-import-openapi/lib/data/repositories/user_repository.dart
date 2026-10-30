import 'package:dio/dio.dart';

import '../../models/new_user.dart';
import '../../models/user.dart';

class UserRepository {
  UserRepository(this._dio);

  final Dio _dio;

  /// GET /v1/users
  Future<List<User>> listUsers({int? page, String? search}) async {
    final response = await _dio.get<List<dynamic>>(
      '/v1/users',
      queryParameters: {if (page != null) 'page': page, if (search != null) 'search': search},
    );
    return response.data!.map((e) => User.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// POST /v1/users
  Future<User> createUser(NewUser body) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/v1/users',
      data: body.toJson(),
    );
    return User.fromJson(response.data!);
  }

  /// GET /v1/users/{userId}
  Future<User> getUser(int userId) async {
    final response = await _dio.get<Map<String, dynamic>>('/v1/users/$userId');
    return User.fromJson(response.data!);
  }

  /// DELETE /v1/users/{userId}
  Future<void> deleteUser(int userId) async {
    await _dio.delete<void>('/v1/users/$userId');
  }
}
