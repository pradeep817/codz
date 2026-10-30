import 'package:get/get.dart';
import 'package:project/app/data/models/product_model.dart';
import 'package:project/app/data/repositories/product_repository.dart';

class CatalogController extends GetxController {
  final ProductRepository _productRepository = Get.find<ProductRepository>();

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

  @override
  void onInit() {
    super.onInit();
    loadProducts();
  }
}
