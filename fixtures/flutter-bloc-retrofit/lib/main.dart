import 'package:flutter/material.dart';
import 'package:task_board/di.dart';
import 'package:task_board/router.dart';

void main() {
  setupDependencies();
  runApp(MaterialApp.router(routerConfig: router));
}
