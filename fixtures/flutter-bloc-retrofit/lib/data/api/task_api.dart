import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';
import 'package:task_board/models/task.dart';

part 'task_api.g.dart';

@RestApi()
abstract class TaskApi {
  factory TaskApi(Dio dio, {String? baseUrl}) = _TaskApi;

  @GET('/tasks')
  Future<List<Task>> getTasks();

  @GET('/tasks/{id}')
  Future<Task> getTask(@Path('id') int id);
}
