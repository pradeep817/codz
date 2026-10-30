import 'package:freezed_annotation/freezed_annotation.dart';

part 'task.freezed.dart';
part 'task.g.dart';

@freezed
abstract class Task with _$Task {
  const Task._();

  const factory Task({
    required int id,
    required String title,
    @JsonKey(name: 'due_at') DateTime? dueAt,
    @Default(false) bool done,
  }) = _Task;

  factory Task.fromJson(Map<String, dynamic> json) => _$TaskFromJson(json);

  bool get overdue => !done && (dueAt?.isBefore(DateTime.now()) ?? false);
}
