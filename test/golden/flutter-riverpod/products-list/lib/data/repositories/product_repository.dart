import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/dio_provider.dart';
import '../models/product_model.dart';

final productRepositoryProvider = Provider<ProductRepository>((ref) {
  return ProductRepository(ref.watch(dioProvider));
});

class ProductRepository {
  ProductRepository(this._dio);

  final Dio _dio;

  /// GET /products
  Future<List<ProductModel>> getProducts({String? category}) async {
    final response = await _dio.get<List<dynamic>>(
      '/products',
      queryParameters: {if (category != null) 'category': category},
    );
    return response.data!.map((e) => ProductModel.fromJson(e as Map<String, dynamic>)).toList();
  }
}
