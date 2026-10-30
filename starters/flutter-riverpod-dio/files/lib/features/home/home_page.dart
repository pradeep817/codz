import 'package:flutter/material.dart';

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('{{appTitle}}')),
      body: const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Add your first endpoint with codz api add, then a screen with codz screen add.',
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
