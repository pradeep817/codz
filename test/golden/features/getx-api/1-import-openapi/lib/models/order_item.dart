class OrderItem {
  const OrderItem({
    required this.sku,
    required this.qty,
  });

  factory OrderItem.fromJson(Map<String, dynamic> json) => OrderItem(
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
