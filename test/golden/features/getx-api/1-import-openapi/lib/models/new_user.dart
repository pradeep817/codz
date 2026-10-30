class NewUser {
  const NewUser({
    required this.name,
    required this.email,
  });

  factory NewUser.fromJson(Map<String, dynamic> json) => NewUser(
        name: json['name'] as String,
        email: json['email'] as String,
      );

  final String name;
  final String email;

  Map<String, dynamic> toJson() => {
        'name': name,
        'email': email,
      };
}
