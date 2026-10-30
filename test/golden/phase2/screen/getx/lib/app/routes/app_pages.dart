import 'package:get/get.dart';
import 'package:project/app/modules/catalog/bindings/catalog_binding.dart';
import 'package:project/app/modules/catalog/views/catalog_view.dart';

part 'app_routes.dart';

class AppPages {
  AppPages._();

  static const initial = Routes.catalog;

  static final routes = [
    GetPage(
      name: _Paths.catalog,
      page: () => const CatalogView(),
      binding: CatalogBinding(),
    ),
  ];
}
