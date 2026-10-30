import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:project/app/data/network/mocks/mock_responses.dart';

/// Answers requests from [mockResponses] instead of the network.
///
/// Turn it on with: flutter run --dart-define=USE_MOCKS=true
class MockInterceptor extends Interceptor {
  static const enabled = bool.fromEnvironment('USE_MOCKS');

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final body = _find(options.method, Uri.parse(options.path).path);
    if (body == null) {
      handler.next(options);
      return;
    }
    handler.resolve(Response<dynamic>(requestOptions: options, statusCode: 200, data: jsonDecode(body)));
  }

  String? _find(String method, String path) {
    for (final entry in mockResponses.entries) {
      final space = entry.key.indexOf(' ');
      if (entry.key.substring(0, space) != method.toUpperCase()) continue;
      final want = entry.key.substring(space + 1).split('/');
      final got = path.split('/');
      if (want.length != got.length) continue;
      var same = true;
      for (var i = 0; i < want.length; i++) {
        final param = want[i].startsWith('{') && want[i].endsWith('}');
        if (!param && want[i] != got[i]) same = false;
      }
      if (same) return entry.value;
    }
    return null;
  }
}
