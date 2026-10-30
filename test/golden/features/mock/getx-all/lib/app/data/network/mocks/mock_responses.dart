// Mock responses, used when the app runs with --dart-define=USE_MOCKS=true.
// Managed by `codz mock add`; edit the JSON freely.
const mockResponses = <String, String>{
  // codz:36a43d9970
  'GET /v1/orders/{orderId}': r'''
{
  "id": "id_1",
  "status": "active",
  "total": 19.99,
  "items": [
    {
      "sku": "Sample sku",
      "qty": 2
    },
    {
      "sku": "Sample sku",
      "qty": 2
    }
  ],
  "shipping_address": {
    "line1": "Sample line1",
    "city": "Sample city"
  }
}
''',
  // codz:e84847ddb8
  'GET /v1/users': r'''
[
  {
    "name": "Sample name 1",
    "email": "user1@example.com",
    "id": 1,
    "created_at": "2026-01-01T09:00:00Z",
    "role": "Sample role",
    "avatar_url": "https://example.com/image.png"
  },
  {
    "name": "Sample name 2",
    "email": "user2@example.com",
    "id": 2,
    "created_at": "2026-01-01T09:00:00Z",
    "role": "Sample role",
    "avatar_url": "https://example.com/image.png"
  }
]
''',
  // codz:bed438e150
  'POST /v1/users': r'''
{
  "name": "Sample name 1",
  "email": "user1@example.com",
  "id": 1,
  "created_at": "2026-01-01T09:00:00Z",
  "role": "Sample role",
  "avatar_url": "https://example.com/image.png"
}
''',
  // codz:bed438e150
  'GET /v1/users/{userId}': r'''
{
  "name": "Sample name 1",
  "email": "user1@example.com",
  "id": 1,
  "created_at": "2026-01-01T09:00:00Z",
  "role": "Sample role",
  "avatar_url": "https://example.com/image.png"
}
''',
  // codz:74234e98af
  'DELETE /v1/users/{userId}': r'''
null
''',
};
