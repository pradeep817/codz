import 'package:get/get.dart';

/// App texts per language. Use them as 'key'.tr in widgets.
class AppTranslations extends Translations {
  @override
  Map<String, Map<String, String>> get keys => {
        'en_US': {
          'home.title': 'Welcome',
        },
        'hi_IN': {
          'home.title': 'Welcome',
        },
      };
}
