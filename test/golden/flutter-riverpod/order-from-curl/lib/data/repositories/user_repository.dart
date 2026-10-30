import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/dio_provider.dart';
import '../models/create_user_order_request_model.dart';
import '../models/order_model.dart';
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

  /// POST /users/{userId}/orders
  Future<OrderModel> createUserOrder(int userId, CreateUserOrderRequestModel body, {String? expand}) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/users/$userId/orders',
      data: body.toJson(),
      queryParameters: {if (expand != null) 'expand': expand},
    );
    return OrderModel.fromJson(response.data!['data'] as Map<String, dynamic>);
  }
}
