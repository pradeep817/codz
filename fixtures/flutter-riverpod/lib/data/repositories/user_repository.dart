import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/dio_provider.dart';
import '../models/user_model.dart';

final userRepositoryProvider = Provider<UserRepository>((ref) {
  return UserRepository(ref.watch(dioProvider));
});

class UserRepository {
  UserRepository(this._dio);

  final Dio _dio;

  Future<UserModel> getUser(int id) async {
    final response = await _dio.get<Map<String, dynamic>>('/users/$id');
    return UserModel.fromJson(response.data!);
  }
}
