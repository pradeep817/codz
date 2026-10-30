import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Light, dark or the phone's setting, remembered between launches.
class ThemeCubit extends Cubit<ThemeMode> {
  ThemeCubit(this._prefs) : super(ThemeMode.values.byName(_prefs.getString(_key) ?? ThemeMode.system.name));

  final SharedPreferences _prefs;
  static const _key = 'theme_mode';

  void set(ThemeMode mode) {
    _prefs.setString(_key, mode.name);
    emit(mode);
  }
}
