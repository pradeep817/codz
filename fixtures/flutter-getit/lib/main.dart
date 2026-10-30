import 'package:flutter/material.dart';
import 'package:field_ops/di.dart';
import 'package:field_ops/screens/jobs_screen.dart';

void main() {
  setupDependencies();
  runApp(const MaterialApp(home: JobsScreen()));
}
