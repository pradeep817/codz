class OrderItemModel {
  const OrderItemModel({
    required this.sku,
    required this.qty,
  });

  factory OrderItemModel.fromJson(Map<String, dynamic> json) => OrderItemModel(
        sku: json['sku'] as String,
        qty: json['qty'] as int,
      );

  final String sku;
  final int qty;

  Map<String, dynamic> toJson() => {
        'sku': sku,
        'qty': qty,
      };
}
