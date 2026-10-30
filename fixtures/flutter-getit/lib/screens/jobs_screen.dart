import 'package:flutter/material.dart';
import 'package:field_ops/di.dart';
import 'package:field_ops/services/job_service.dart';

class JobsScreen extends StatelessWidget {
  const JobsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return FutureBuilder(
      future: getIt<JobService>().getJobs(),
      builder: (context, snapshot) => Text('${snapshot.data?.length ?? 0} jobs'),
    );
  }
}
