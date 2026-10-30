import { useQuery } from '@tanstack/react-query';

import { getMe } from '@/api/auth';

/** GET /auth/me: the signed-in user's latest profile. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => getMe(),
  });
}
