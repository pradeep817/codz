import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:{{appName}}/core/network/api_error.dart';
import 'package:{{appName}}/core/storage/token_storage.dart';
import 'package:{{appName}}/data/models/user_model.dart';
import 'package:{{appName}}/data/repositories/auth_repository.dart';

sealed class AuthEvent {
  const AuthEvent();
}

/// Restores the session at launch.
class AuthStarted extends AuthEvent {
  const AuthStarted();
}

class AuthLoginRequested extends AuthEvent {
  const AuthLoginRequested(this.email, this.password);
  final String email;
  final String password;
}

class AuthLogoutRequested extends AuthEvent {
  const AuthLogoutRequested();
}

class _AuthSessionExpired extends AuthEvent {
  const _AuthSessionExpired();
}

enum AuthStatus { unknown, signedOut, signedIn }

class AuthState {
  const AuthState({this.status = AuthStatus.unknown, this.user, this.busy = false, this.error});

  final AuthStatus status;
  final UserModel? user;
  final bool busy;
  final String? error;

  AuthState copyWith({AuthStatus? status, UserModel? user, bool? busy, String? error}) =>
      AuthState(status: status ?? this.status, user: user ?? this.user, busy: busy ?? this.busy, error: error);
}

class AuthBloc extends Bloc<AuthEvent, AuthState> {
  AuthBloc(this._repo, TokenStorage tokens) : super(const AuthState()) {
    on<AuthStarted>(_onStarted);
    on<AuthLoginRequested>(_onLogin);
    on<AuthLogoutRequested>(_onLogout);
    on<_AuthSessionExpired>((event, emit) => emit(const AuthState(status: AuthStatus.signedOut, error: 'Your session ended. Sign in again.')));
    _expired = tokens.sessionExpired.listen((_) => add(const _AuthSessionExpired()));
  }

  final AuthRepository _repo;
  late final StreamSubscription<void> _expired;

  Future<void> _onStarted(AuthStarted event, Emitter<AuthState> emit) async {
    if (!await _repo.hasSession()) return emit(const AuthState(status: AuthStatus.signedOut));
    try {
      emit(AuthState(status: AuthStatus.signedIn, user: await _repo.me()));
    } on DioException catch (e) {
      // Offline at launch: keep the session and let the pages show their own errors.
      final offline = e.response == null;
      emit(AuthState(status: offline ? AuthStatus.signedIn : AuthStatus.signedOut));
    }
  }

  Future<void> _onLogin(AuthLoginRequested event, Emitter<AuthState> emit) async {
    emit(state.copyWith(busy: true));
    try {
      final user = await _repo.login(event.email, event.password);
      emit(AuthState(status: AuthStatus.signedIn, user: user));
    } catch (e) {
      final wrongPassword = e is DioException && (e.response?.statusCode == 401 || e.response?.statusCode == 400);
      emit(AuthState(status: AuthStatus.signedOut, error: wrongPassword ? 'That email and password do not match.' : apiErrorMessage(e)));
    }
  }

  Future<void> _onLogout(AuthLogoutRequested event, Emitter<AuthState> emit) async {
    await _repo.logout();
    emit(const AuthState(status: AuthStatus.signedOut));
  }

  @override
  Future<void> close() {
    _expired.cancel();
    return super.close();
  }
}
