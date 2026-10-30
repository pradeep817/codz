import 'package:dio/dio.dart';
import 'package:get_it/get_it.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:{{appName}}/core/network/api_client.dart';
import 'package:{{appName}}/core/storage/token_storage.dart';
import 'package:{{appName}}/data/repositories/auth_repository.dart';
import 'package:{{appName}}/features/auth/auth_bloc.dart';
import 'package:{{appName}}/features/settings/theme_cubit.dart';

final getIt = GetIt.instance;

/// Registers app-wide dependencies. Called once from main().
Future<void> setupDependencies() async {
  getIt.registerSingleton<SharedPreferences>(await SharedPreferences.getInstance());
  getIt.registerLazySingleton<TokenStorage>(TokenStorage.new);
  getIt.registerLazySingleton<Dio>(() => createDio(getIt<TokenStorage>()));
  getIt.registerLazySingleton<AuthRepository>(() => AuthRepository(getIt<Dio>(), getIt<TokenStorage>()));
  getIt.registerLazySingleton<AuthBloc>(() => AuthBloc(getIt<AuthRepository>(), getIt<TokenStorage>()));
  getIt.registerFactory<ThemeCubit>(() => ThemeCubit(getIt<SharedPreferences>()));
}
