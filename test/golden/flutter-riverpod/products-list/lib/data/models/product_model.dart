class ProductModel {
  const ProductModel({
    required this.id,
    required this.name,
    required this.price,
    required this.inStock,
    required this.tags,
    this.discount,
  });

  factory ProductModel.fromJson(Map<String, dynamic> json) => ProductModel(
        id: json['id'] as int,
        name: json['name'] as String,
        price: (json['price'] as num).toDouble(),
        inStock: json['in_stock'] as bool,
        tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
        discount: (json['discount'] as num?)?.toDouble(),
      );

  final int id;
  final String name;
  final double price;
  final bool inStock;
  final List<String> tags;
  final double? discount;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'price': price,
        'in_stock': inStock,
        'tags': tags,
        'discount': discount,
      };
}
