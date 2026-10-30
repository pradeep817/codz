import 'address_model.dart';
import 'order_item_model.dart';

class OrderModel {
  const OrderModel({
    required this.id,
    required this.totalPrice,
    required this.createdAt,
    required this.items,
    required this.address,
  });

  factory OrderModel.fromJson(Map<String, dynamic> json) => OrderModel(
        id: json['id'] as int,
        totalPrice: (json['total_price'] as num).toDouble(),
        createdAt: DateTime.parse(json['created_at'] as String),
        items: (json['items'] as List<dynamic>).map((e) => OrderItemModel.fromJson(e as Map<String, dynamic>)).toList(),
        address: AddressModel.fromJson(json['address'] as Map<String, dynamic>),
      );

  final int id;
  final double totalPrice;
  final DateTime createdAt;
  final List<OrderItemModel> items;
  final AddressModel address;

  Map<String, dynamic> toJson() => {
        'id': id,
        'total_price': totalPrice,
        'created_at': createdAt.toIso8601String(),
        'items': items.map((e) => e.toJson()).toList(),
        'address': address.toJson(),
      };
}
