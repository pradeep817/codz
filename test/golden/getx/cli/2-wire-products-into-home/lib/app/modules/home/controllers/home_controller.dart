import 'package:get/get.dart';

import '../../../data/models/product_model.dart';
import '../../../data/repositories/product_repository.dart';

class HomeController extends GetxController {
  final ProductRepository _productRepository = Get.find<ProductRepository>();

  //TODO: Implement HomeController

  final count = 0.obs;
  @override
  void onInit() {
    super.onInit();
    loadProducts();
  }

  @override
  void onReady() {
    super.onReady();
  }

  @override
  void onClose() {
    super.onClose();
  }

  void increment() => count.value++;

  // GET /products via ProductRepository.getProducts
  final products = <ProductModel>[].obs;
  final isProductsLoading = false.obs;
  final productsError = RxnString();

  Future<void> loadProducts() async {
    isProductsLoading.value = true;
    productsError.value = null;
    try {
      products.assignAll(await _productRepository.getProducts());
    } catch (e) {
      productsError.value = e.toString();
    } finally {
      isProductsLoading.value = false;
    }
  }
}
