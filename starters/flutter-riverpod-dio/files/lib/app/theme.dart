import 'package:flutter/material.dart';

/// Colors and text styles in one place. codz theme set primary "#hex" changes the seed.
class AppColors {
  static const primary = Color(0xFF3F51B5);
}

class AppTheme {
  static final light = ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: AppColors.primary),
    useMaterial3: true,
  );

  static final dark = ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: AppColors.primary, brightness: Brightness.dark),
    useMaterial3: true,
  );
}
