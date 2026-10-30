import 'package:dio/dio.dart';
import 'package:field_ops/models/create_site_visit_request.dart';
import 'package:field_ops/models/visit.dart';

class SiteService {
  SiteService(this.dio);

  final Dio dio;

  /// POST /api/v2/sites/{siteId}/visits
  Future<Visit> createSiteVisit(int siteId, CreateSiteVisitRequest body) async {
    final response = await dio.post<Map<String, dynamic>>(
      '/sites/$siteId/visits',
      data: body.toJson(),
    );
    return Visit.fromJson(response.data!);
  }
}
