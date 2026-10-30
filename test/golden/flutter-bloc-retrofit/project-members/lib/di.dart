import 'package:dio/dio.dart';
import 'package:get_it/get_it.dart';
import 'package:task_board/data/api/project_api.dart';
import 'package:task_board/data/api/task_api.dart';

final getIt = GetIt.instance;

void setupDependencies() {
  getIt.registerLazySingleton<Dio>(() => Dio(BaseOptions(baseUrl: 'https://api.taskboard.dev/v1')));
  getIt.registerLazySingleton<TaskApi>(() => TaskApi(getIt()));
  getIt.registerLazySingleton<ProjectApi>(() => ProjectApi(getIt()));
}
