import 'package:flutter/material.dart';

import 'app_colors.dart';

/// The app theme. Colors come from AppColors; change them with devtool theme set.
class AppTheme {
  AppTheme._();

  static ThemeData get light => ThemeData(
        fontFamily: 'Inter',
        colorScheme: ColorScheme.fromSeed(seedColor: AppColors.primary),
        useMaterial3: true,
      );

  static ThemeData get dark => ThemeData(
        fontFamily: 'Inter',
        colorScheme: ColorScheme.fromSeed(seedColor: AppColors.primary, brightness: Brightness.dark),
        useMaterial3: true,
      );
}
