import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getContact, updateContact } from '@/lib/api/contacts';
import type { UpdateContactRequest } from '@/types/update-contact-request';

export function useContact(id: number) {
  return useQuery({ queryKey: ['contacts', id], queryFn: () => getContact(id) });
}

/** PATCH /v1/contacts/{id} */
export function useUpdateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateContactRequest }) => updateContact(id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
  });
}
