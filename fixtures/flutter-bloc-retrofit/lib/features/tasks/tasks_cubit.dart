import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:task_board/data/api/task_api.dart';
import 'package:task_board/models/task.dart';

class TasksCubit extends Cubit<List<Task>> {
  TasksCubit(this._api) : super(const []);

  final TaskApi _api;

  Future<void> load() async => emit(await _api.getTasks());
}
