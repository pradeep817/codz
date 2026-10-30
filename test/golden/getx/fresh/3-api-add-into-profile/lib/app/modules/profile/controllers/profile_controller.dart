import 'package:get/get.dart';
import 'package:project/app/data/models/user_model.dart';
import 'package:project/app/data/repositories/user_repository.dart';

class ProfileController extends GetxController {
  final UserRepository _userRepository = Get.find<UserRepository>();

  // GET /users/{id} via UserRepository.getUser
  final user = Rxn<UserModel>();
  final isUserLoading = false.obs;
  final userError = RxnString();

  Future<void> loadUser(int id) async {
    isUserLoading.value = true;
    userError.value = null;
    try {
      user.value = await _userRepository.getUser(id);
    } catch (e) {
      userError.value = e.toString();
    } finally {
      isUserLoading.value = false;
    }
  }
}
