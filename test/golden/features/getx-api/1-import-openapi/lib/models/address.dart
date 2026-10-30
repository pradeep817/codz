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
