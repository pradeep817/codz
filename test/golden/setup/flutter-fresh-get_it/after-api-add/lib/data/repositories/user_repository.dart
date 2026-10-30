import 'package:dio/dio.dart';
import 'package:project/data/models/user_model.dart';

class UserRepository {
  UserRepository(this._dio);

  final Dio _dio;

  /// GET /users/{id}
  Future<UserModel> getUser(int id) async {
    final response = await _dio.get<Map<String, dynamic>>('/users/$id');
    return UserModel.fromJson(response.data!);
  }
}
