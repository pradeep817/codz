import 'package:dio/dio.dart';

/// A message for the user from any error an API call can throw.
String apiErrorMessage(Object error) {
  if (error is DioException) {
    switch (error.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
        return 'The server took too long to answer. Try again.';
      case DioExceptionType.connectionError:
        return 'No connection. Check your internet and try again.';
      case DioExceptionType.badResponse:
        final status = error.response?.statusCode ?? 0;
        if (status == 401) return 'Please sign in again.';
        if (status == 404) return 'Not found.';
        if (status >= 500) return 'The server had a problem. Try again later.';
        return 'Request failed ($status).';
      default:
        return 'Something went wrong. Try again.';
    }
  }
  return 'Something went wrong. Try again.';
}
