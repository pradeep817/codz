import type { Job } from '../types/job';
import { apiFetch } from './client';

export function getJobs(): Promise<Job[]> {
  return apiFetch<Job[]>('/jobs');
}

export function getJob(id: number): Promise<Job> {
  return apiFetch<Job>(`/jobs/${id}`);
}
