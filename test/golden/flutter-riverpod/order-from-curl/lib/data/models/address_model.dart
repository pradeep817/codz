class AddressModel {
  const AddressModel({
    required this.line1,
    required this.city,
  });

  factory AddressModel.fromJson(Map<String, dynamic> json) => AddressModel(
        line1: json['line1'] as String,
        city: json['city'] as String,
      );

  final String line1;
  final String city;

  Map<String, dynamic> toJson() => {
        'line1': line1,
        'city': city,
      };
}
