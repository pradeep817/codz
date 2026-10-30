import 'package:dio/dio.dart';

import '../../models/order.dart';

class OrderRepository {
  OrderRepository(this._dio);

  final Dio _dio;

  /// GET /v1/orders/{orderId}
  Future<Order> getOrder(String orderId) async {
    final response = await _dio.get<Map<String, dynamic>>('/v1/orders/$orderId');
    return Order.fromJson(response.data!);
  }
}
