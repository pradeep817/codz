class User {
  const User({
    required this.name,
    required this.email,
    required this.id,
    required this.createdAt,
    this.role,
    this.avatarUrl,
  });

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String,
        email: json['email'] as String,
        id: json['id'] as int,
        createdAt: DateTime.parse(json['created_at'] as String),
        role: json['role'] as String?,
        avatarUrl: json['avatar_url'] as String?,
      );

  final String name;
  final String email;
  final int id;
  final DateTime createdAt;
  final String? role;
  final String? avatarUrl;

  Map<String, dynamic> toJson() => {
        'name': name,
        'email': email,
        'id': id,
        'created_at': createdAt.toIso8601String(),
        'role': role,
        'avatar_url': avatarUrl,
      };
}
