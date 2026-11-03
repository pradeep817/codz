class Order {
  const Order({
    required this.id,
    required this.status,
    required this.total,
    required this.items,
    this.shippingAddress,
  });

  factory Order.fromJson(Map<String, dynamic> json) => Order(
        id: json['id'] as String,
        status: json['status'] as String,
        total: (json['total'] as num).toDouble(),
        items: (json['items'] as List<dynamic>).map((e) => OrderItem.fromJson(e as Map<String, dynamic>)).toList(),
        shippingAddress: json['shipping_address'] == null ? null : Address.fromJson(json['shipping_address'] as Map<String, dynamic>),
      );

  final String id;
  final String status;
  final double total;
  final List<OrderItem> items;
  final Address? shippingAddress;

  Map<String, dynamic> toJson() => {
        'id': id,
        'status': status,
        'total': total,
        'items': items.map((e) => e.toJson()).toList(),
        'shipping_address': shippingAddress?.toJson(),
      };
}

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

class Address {
  const Address({
    this.line1,
    this.city,
  });

  factory Address.fromJson(Map<String, dynamic> json) => Address(
        line1: json['line1'] as String?,
        city: json['city'] as String?,
      );

  final String? line1;
  final String? city;

  Map<String, dynamic> toJson() => {
        'line1': line1,
        'city': city,
      };
}
