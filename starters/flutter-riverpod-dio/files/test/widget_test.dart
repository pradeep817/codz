import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:{{appName}}/main.dart';

void main() {
  testWidgets('the home page shows the app title', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: App()));
    await tester.pumpAndSettle();
    expect(find.text('{{appTitle}}'), findsWidgets);
  });
}
