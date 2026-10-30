import 'package:dio/dio.dart';
import 'package:get_it/get_it.dart';
import 'package:field_ops/services/job_service.dart';

final getIt = GetIt.instance;

void setupDependencies() {
  getIt.registerLazySingleton<Dio>(() => Dio(BaseOptions(baseUrl: 'https://ops.example.com/api/v2')));
  getIt.registerLazySingleton<JobService>(() => JobService(getIt()));
}
