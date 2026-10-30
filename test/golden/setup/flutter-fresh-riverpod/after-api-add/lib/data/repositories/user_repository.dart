import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:project/core/network/dio_provider.dart';
import 'package:project/data/models/user_model.dart';

final userRepositoryProvider = Provider<UserRepository>((ref) {
  return UserRepository(ref.watch(dioProvider));
});

class UserRepository {
  UserRepository(this._dio);

  final Dio _dio;

  /// GET /users/{id}
  Future<UserModel> getUser(int id) async {
    final response = await _dio.get<Map<String, dynamic>>('/users/$id');
    return UserModel.fromJson(response.data!);
  }
}
