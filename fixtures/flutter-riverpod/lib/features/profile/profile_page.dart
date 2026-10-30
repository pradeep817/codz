import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/repositories/user_repository.dart';

class ProfilePage extends ConsumerWidget {
  const ProfilePage({super.key, required this.id});

  final int id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder(
      future: ref.watch(userRepositoryProvider).getUser(id),
      builder: (context, snapshot) => Text(snapshot.data?.name ?? ''),
    );
  }
}
