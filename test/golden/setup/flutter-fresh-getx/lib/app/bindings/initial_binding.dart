import 'package:dio/dio.dart';
import 'package:get/get.dart';
import 'package:project/app/data/network/api_client.dart';

class InitialBinding extends Bindings {
  @override
  void dependencies() {
    Get.put<Dio>(createDio(), permanent: true);
  }
}
