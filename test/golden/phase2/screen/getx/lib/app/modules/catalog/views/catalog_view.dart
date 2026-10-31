import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:project/app/modules/catalog/controllers/catalog_controller.dart';

class CatalogView extends GetView<CatalogController> {
  const CatalogView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Catalog')),
      body: Obx(() {
        if (controller.isProductsLoading.value) return const Center(child: CircularProgressIndicator());
        final error = controller.productsError.value;
        if (error != null) {
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(error, textAlign: TextAlign.center),
                TextButton(onPressed: controller.loadProducts, child: const Text('Retry')),
              ],
            ),
          );
        }
        if (controller.products.isEmpty) return const Center(child: Text('No items'));
        return RefreshIndicator(
          onRefresh: controller.loadProducts,
          child: ListView.builder(
            itemCount: controller.products.length,
            itemBuilder: (context, index) {
              final item = controller.products[index];
              return ListTile(title: Text(item.name));
            },
          ),
        );
      }),
    );
  }
}
