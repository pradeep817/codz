import 'package:dio/dio.dart';
import 'package:field_ops/models/job.dart';

class JobService {
  JobService(this.dio);

  final Dio dio;

  Future<List<Job>> getJobs() async {
    final response = await dio.get<List<dynamic>>('/jobs');
    return response.data!.map((e) => Job.fromJson(e as Map<String, dynamic>)).toList();
  }
}
