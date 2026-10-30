class CreateUserOrderRequestModel {
  const CreateUserOrderRequestModel({
    required this.productId,
    required this.qty,
  });

  factory CreateUserOrderRequestModel.fromJson(Map<String, dynamic> json) => CreateUserOrderRequestModel(
        productId: json['product_id'] as int,
        qty: json['qty'] as int,
      );

  final int productId;
  final int qty;

  Map<String, dynamic> toJson() => {
        'product_id': productId,
        'qty': qty,
      };
}
