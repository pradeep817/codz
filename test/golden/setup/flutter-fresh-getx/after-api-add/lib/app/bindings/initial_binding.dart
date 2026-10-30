import 'package:dio/dio.dart';
import 'package:get/get.dart';
import 'package:project/app/data/network/api_client.dart';
import 'package:project/app/data/repositories/user_repository.dart';

class InitialBinding extends Bindings {
  @override
  void dependencies() {
    Get.put<Dio>(createDio(), permanent: true);
    Get.lazyPut<UserRepository>(() => UserRepository(Get.find<Dio>()), fenix: true);
  }
}
