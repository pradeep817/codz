import 'package:json_annotation/json_annotation.dart';

part 'create_site_visit_request.g.dart';

@JsonSerializable()
class CreateSiteVisitRequest {
  const CreateSiteVisitRequest({
    required this.technicianId,
    required this.scheduledFor,
    required this.notes,
  });

  factory CreateSiteVisitRequest.fromJson(Map<String, dynamic> json) => _$CreateSiteVisitRequestFromJson(json);

  @JsonKey(name: 'technician_id')
  final int technicianId;
  @JsonKey(name: 'scheduled_for')
  final DateTime scheduledFor;
  final String notes;

  Map<String, dynamic> toJson() => _$CreateSiteVisitRequestToJson(this);
}
