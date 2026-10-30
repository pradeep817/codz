import 'package:get/get.dart';

/// App texts per language. Use them as 'key'.tr in widgets.
class AppTranslations extends Translations {
  @override
  Map<String, Map<String, String>> get keys => {
        'en_US': {
          'home.title': 'Welcome',
          'cart.empty': 'It\'s empty',
        },
        'hi_IN': {
          'home.title': 'Welcome',
          'cart.empty': 'कार्ट खाली है',
        },
      };
}
