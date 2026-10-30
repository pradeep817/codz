import 'package:json_annotation/json_annotation.dart';

part 'job.g.dart';

@JsonSerializable()
class Job {
  const Job({required this.id, required this.title, this.dueAt});

  factory Job.fromJson(Map<String, dynamic> json) => _$JobFromJson(json);

  final int id;
  final String title;
  @JsonKey(name: 'due_at')
  final DateTime? dueAt;

  Map<String, dynamic> toJson() => _$JobToJson(this);
}
