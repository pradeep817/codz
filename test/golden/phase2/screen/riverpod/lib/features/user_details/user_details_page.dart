import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/user_model.dart';
import '../../data/repositories/user_repository.dart';

class UserDetailsPage extends ConsumerStatefulWidget {
  const UserDetailsPage({super.key, required this.id});

  final String id;

  @override
  ConsumerState<UserDetailsPage> createState() => _UserDetailsPageState();
}

class _UserDetailsPageState extends ConsumerState<UserDetailsPage> {
  late Future<UserModel> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<UserModel> _load() => ref.read(userRepositoryProvider).getUser(int.parse(widget.id));

  void _reload() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('User Details')),
      body: FutureBuilder<UserModel>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('${snapshot.error}', textAlign: TextAlign.center),
                  TextButton(onPressed: _reload, child: const Text('Retry')),
                ],
              ),
            );
          }
          final data = snapshot.data!;
          return ListView(
            children: [
              ListTile(title: const Text('id'), subtitle: Text('${data.id}')),
              ListTile(title: const Text('name'), subtitle: Text('${data.name}')),
              ListTile(title: const Text('email'), subtitle: Text('${data.email}')),
            ],
          );
        },
      ),
    );
  }
}
