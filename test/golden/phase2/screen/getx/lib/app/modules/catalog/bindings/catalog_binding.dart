import 'package:get/get.dart';
import 'package:project/app/modules/catalog/controllers/catalog_controller.dart';

class CatalogBinding extends Bindings {
  @override
  void dependencies() {
    Get.lazyPut<CatalogController>(() => CatalogController());
  }
}
