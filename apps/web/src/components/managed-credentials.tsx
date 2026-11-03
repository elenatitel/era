'use client';
import { Alert, Button, ErrorText, Spinner } from './ui';
import { useAuthConfig } from '@/lib/auth-config';
import { useI18n } from '@/lib/i18n';
export function ManagedCredentials({ signedIn = false }: { signedIn?: boolean }) {
  const auth = useAuthConfig();
  const {data} = auth;
  const { t } = useI18n();
  if(auth.isPending) return <Spinner />;
  if(auth.error) return <ErrorText error={auth.error} />;
  return (
    <Alert tone="blue">
      <p className="mb-3">{t('auth.ssoManaged')}</p>
      <Button onClick={() => window.location.assign((signedIn ? data?.accountUrl : data?.loginUrl) ?? '/login')}>
        {t(signedIn ? 'auth.manageCredentials' : 'auth.signIn')}
      </Button>
      {signedIn && (
        <Button className="ml-2" variant="secondary" onClick={() => window.location.assign('/api/auth/oidc/login?reauth=true')}>
          {t('auth.reauthenticate')}
        </Button>
      )}
    </Alert>
  );
}
