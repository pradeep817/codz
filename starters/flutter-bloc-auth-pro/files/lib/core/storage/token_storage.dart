import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The access and refresh tokens, in the Keychain (iOS) or the Keystore (Android).
class TokenStorage {
  TokenStorage([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  final _expired = StreamController<void>.broadcast();
  String? _access;

  static const _accessKey = 'access_token';
  static const _refreshKey = 'refresh_token';

  /// Fires when the session ended on the server (refresh failed); the auth bloc signs out.
  Stream<void> get sessionExpired => _expired.stream;

  Future<String?> get accessToken async => _access ??= await _storage.read(key: _accessKey);
  Future<String?> get refreshToken => _storage.read(key: _refreshKey);

  Future<void> save({required String access, String? refresh}) async {
    _access = access;
    await _storage.write(key: _accessKey, value: access);
    if (refresh != null) await _storage.write(key: _refreshKey, value: refresh);
  }

  Future<void> clear() async {
    _access = null;
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
  }

  void expire() => _expired.add(null);
}
