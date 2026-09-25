'use client';

import { Suspense, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { MeResponse } from '@nexora/shared';
import { api, ApiRequestError } from '@/lib/api';
import { apiMessage } from '@/components/admin/admin-api';
import { Button, Card, CardBody, Field, Input, Logo, Spinner } from '@/components/ui';
import { Lock, Mail, ShieldAlert } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function performLogin(targetEmail: string, targetPass: string) {
    setError(null);
    try {
      const res = await api<MeResponse>('/auth/login', {
        method: 'POST',
        json: { email: targetEmail.trim(), password: targetPass },
      });

      const fallbackVenue = res.venues[0]?.id;
      const destination =
        nextUrl && nextUrl.startsWith('/admin')
          ? nextUrl
          : fallbackVenue
            ? `/admin/${fallbackVenue}/floor`
            : '/admin';

      startTransition(() => {
        router.push(destination);
        router.refresh();
      });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setError('Invalid email or password. Please check your credentials.');
      } else {
        setError(apiMessage(err));
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }
    await performLogin(email, password);
  }

  function handleDemoLogin(demoEmail: string, demoPass: string) {
    setEmail(demoEmail);
    setPassword(demoPass);
    void performLogin(demoEmail, demoPass);
  }

  return (
    <Card className="w-full max-w-[420px] border-border bg-background shadow-md">
      <CardBody className="p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo subtitle="Console" className="scale-110" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-gray-1000">Sign in to Admin Console</h1>
          <p className="mt-1.5 text-xs text-gray-900">Live service, table inventory, orders, and triage</p>
        </div>

        {error ? (
          <div
            role="alert"
            className="mb-5 flex items-start gap-2.5 rounded-lg border border-red/20 bg-red-soft p-3 text-xs text-red-fg"
          >
            <ShieldAlert size={16} className="mt-0.5 shrink-0" />
            <div className="leading-relaxed">{error}</div>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Staff Email" htmlFor="admin-email">
            <div className="relative">
              <Input
                id="admin-email"
                type="email"
                autoComplete="email"
                required
                placeholder="name@venue.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isPending}
                className="pl-9"
              />
              <Mail size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-700" />
            </div>
          </Field>

          <Field label="Password" htmlFor="admin-password">
            <div className="relative">
              <Input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isPending}
                className="pl-9"
              />
              <Lock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-700" />
            </div>
          </Field>

          <Button type="submit" variant="primary" loading={isPending} className="w-full">
            {isPending ? 'Authenticating…' : 'Sign in'}
          </Button>
        </form>

        <div className="relative my-6 text-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <span className="relative bg-background px-3 text-[11px] font-medium tracking-wide uppercase text-gray-800">
            Quick Demo Login
          </span>
        </div>

        <div className="space-y-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={() => handleDemoLogin('manager@themill.com', 'manager123')}
            className="w-full justify-between text-xs"
          >
            <span>Login as Manager</span>
            <span className="text-[11px] text-gray-800 tabular">manager@themill.com</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={() => handleDemoLogin('host@themill.com', 'host123')}
            className="w-full justify-between text-xs"
          >
            <span>Login as Host</span>
            <span className="text-[11px] text-gray-800 tabular">host@themill.com</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={() => handleDemoLogin('admin@nexora.internal', 'admin123')}
            className="w-full justify-between text-xs"
          >
            <span>Login as Org Admin</span>
            <span className="text-[11px] text-gray-800 tabular">admin@nexora.internal</span>
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

export default function AdminLoginPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background-2 p-4 text-gray-1000">
      <Suspense
        fallback={
          <div className="flex items-center gap-2 text-sm text-gray-900">
            <Spinner size={16} /> Loading login...
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  );
}
