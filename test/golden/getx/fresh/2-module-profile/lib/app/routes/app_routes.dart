part of 'app_pages.dart';

abstract class Routes {
  Routes._();
  static const home = _Paths.home;
  static const profile = _Paths.profile;
}

abstract class _Paths {
  _Paths._();
  static const home = '/home';
  static const profile = '/profile';
}
