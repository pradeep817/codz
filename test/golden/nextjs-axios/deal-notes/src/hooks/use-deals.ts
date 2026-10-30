import { useQuery } from '@tanstack/react-query';
import { getDealNotes } from '@/lib/api/deals';

/** GET /v1/deals/{dealId}/notes */
export function useDealNotes(dealId: string, params?: { page?: number }) {
  return useQuery({
    queryKey: ['deals', dealId, params],
    queryFn: () => getDealNotes(dealId, params),
  });
}
