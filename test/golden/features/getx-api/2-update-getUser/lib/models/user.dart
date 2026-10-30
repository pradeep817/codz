class User {
  const User({
    required this.id,
    required this.name,
    required this.email,
    required this.createdAt,
    required this.role,
    required this.phone,
  });

  factory User.fromJson(Map<String, dynamic> json) => User(
        id: json['id'] as int,
        name: json['name'] as String,
        email: json['email'] as String,
        createdAt: DateTime.parse(json['created_at'] as String),
        role: json['role'] as String,
        phone: json['phone'] as String,
      );

  final int id;
  final String name;
  final String email;
  final DateTime createdAt;
  final String role;
  final String phone;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'email': email,
        'created_at': createdAt.toIso8601String(),
        'role': role,
        'phone': phone,
      };
}
