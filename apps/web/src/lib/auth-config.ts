'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
export interface AuthConfig {
  provider: 'local' | 'keycloak';
  loginUrl: string;
  accountUrl: string | null;
}
export function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<AuthConfig>('/auth/config'), staleTime: 60_000, retry: false });
}
