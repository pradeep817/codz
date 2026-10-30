import 'package:json_annotation/json_annotation.dart';

part 'checklist_item.g.dart';

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
