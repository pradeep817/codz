import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:project/app/modules/profile/controllers/profile_controller.dart';

class ProfileView extends GetView<ProfileController> {
  const ProfileView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: const Center(child: Text('ProfileView is working')),
    );
  }
}
