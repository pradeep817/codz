import 'package:get/get.dart';
import 'package:project/app/modules/home/bindings/home_binding.dart';
import 'package:project/app/modules/home/views/home_view.dart';
import 'package:project/app/modules/profile/bindings/profile_binding.dart';
import 'package:project/app/modules/profile/views/profile_view.dart';

part 'app_routes.dart';

class AppPages {
  AppPages._();

  static const initial = Routes.home;

  static final routes = [
    GetPage(
      name: _Paths.home,
      page: () => const HomeView(),
      binding: HomeBinding(),
    ),
    GetPage(
      name: _Paths.profile,
      page: () => const ProfileView(),
      binding: ProfileBinding(),
    ),
  ];
}
