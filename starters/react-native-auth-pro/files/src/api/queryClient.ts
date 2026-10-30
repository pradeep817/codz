import { QueryClient } from '@tanstack/react-query';
import axios from 'axios';

/** Retries network errors and 5xx twice; never retries 4xx (a retry would get the same answer). */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status && status < 500) return false;
        return count < 2;
      },
    },
  },
});
