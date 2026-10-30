import 'package:dio/dio.dart';
import 'package:get_it/get_it.dart';
import 'package:project/core/network/api_client.dart';

final getIt = GetIt.instance;

/// Registers app-wide dependencies. Called once from main().
void setupDependencies() {
  getIt.registerLazySingleton<Dio>(createDio);
}
