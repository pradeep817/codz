import 'package:freezed_annotation/freezed_annotation.dart';

part 'member.freezed.dart';
part 'member.g.dart';

@freezed
abstract class Member with _$Member {
  const factory Member({
    required int id,
    required String name,
    required double price,
    @JsonKey(name: 'in_stock') required bool inStock,
    required List<String> tags,
    double? discount,
  }) = _Member;

  factory Member.fromJson(Map<String, dynamic> json) => _$MemberFromJson(json);
}
