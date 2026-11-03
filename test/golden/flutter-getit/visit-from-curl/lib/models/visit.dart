import 'package:json_annotation/json_annotation.dart';

part 'visit.g.dart';

@JsonSerializable(explicitToJson: true)
class Visit {
  const Visit({
    required this.id,
    required this.siteId,
    required this.status,
    required this.scheduledFor,
    required this.checklist,
  });

  factory Visit.fromJson(Map<String, dynamic> json) => _$VisitFromJson(json);

  final int id;
  @JsonKey(name: 'site_id')
  final int siteId;
  final String status;
  @JsonKey(name: 'scheduled_for')
  final DateTime scheduledFor;
  final List<ChecklistItem> checklist;

  Map<String, dynamic> toJson() => _$VisitToJson(this);
}

@JsonSerializable()
class ChecklistItem {
  const ChecklistItem({
    required this.label,
    required this.done,
  });

  factory ChecklistItem.fromJson(Map<String, dynamic> json) => _$ChecklistItemFromJson(json);

  final String label;
  final bool done;

  Map<String, dynamic> toJson() => _$ChecklistItemToJson(this);
}
