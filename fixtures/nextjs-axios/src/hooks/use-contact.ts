import { useQuery } from '@tanstack/react-query';
import { getContact } from '@/lib/api/contacts';

export function useContact(id: number) {
  return useQuery({ queryKey: ['contacts', id], queryFn: () => getContact(id) });
}
