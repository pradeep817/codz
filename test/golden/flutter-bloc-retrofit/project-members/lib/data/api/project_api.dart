import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';
import 'package:task_board/models/member.dart';

part 'project_api.g.dart';

@RestApi()
abstract class ProjectApi {
  factory ProjectApi(Dio dio, {String? baseUrl}) = _ProjectApi;

  /// GET /v1/projects/{projectId}/members
  @GET('/projects/{projectId}/members')
  Future<List<Member>> getProjectMembers(@Path('projectId') String projectId, {@Query('role') String? role});
}
