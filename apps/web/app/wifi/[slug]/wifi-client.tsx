'use client';

import { useEffect, useState, useTransition } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  Wifi,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Signal,
  Smartphone,
  ChevronLeft,
  Copy,
  Utensils,
  Award,
} from 'lucide-react';
import type { TierLevel, WifiConnectResponse } from '@nexora/shared';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { isOptimizableImage } from '@/components/consumer/utils';

export interface VenueWifiDto {
  name: string;
  slug: string;
  imageUrl: string;
}

const TIER_DISPLAY_CONFIG: Record<
  TierLevel,
  { label: string; tone: 'neutral' | 'blue' | 'green' | 'amber' | 'accent' }
> = {
  BASE: { label: 'Guest', tone: 'neutral' },
  MEMBER: { label: 'Club Member', tone: 'blue' },
  REGULAR: { label: 'VIP Regular', tone: 'amber' },
  FRIENDS_AND_FAMILY: { label: 'VIP • Friends & Family', tone: 'accent' },
};

export function WifiPortalClient({
  venue,
  initialMac,
  initialAp,
}: {
  venue: VenueWifiDto;
  initialMac?: string;
  initialAp?: string;
}) {
  // Navigation step: 1 (Guest Details) -> 2 (Verification OTP) -> 3 (Connected)
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Device & Network Parameters
  const [mac, setMac] = useState<string>(initialMac || '02:00:00:12:34:56');
  const [apId] = useState<string>(initialAp || 'AP-ENTRANCE-01');

  // Step 1 Form State
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Step 2 OTP State
  const [otp, setOtp] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(300); // 5 minutes TTL
  const [otpError, setOtpError] = useState<string | null>(null);

  // Step 3 Result State
  const [connectResult, setConnectResult] = useState<WifiConnectResponse | null>(null);

  // Transitions
  const [isSendingOtp, startSendOtp] = useTransition();
  const [isConnecting, startConnect] = useTransition();

  // Persistent mock MAC initialization
  useEffect(() => {
    if (typeof window !== 'undefined' && !initialMac) {
      const stored = localStorage.getItem('nexora_wifi_mac');
      if (stored && /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(stored)) {
        setMac(stored);
      } else {
        const generated = '02:00:00:12:34:56';
        localStorage.setItem('nexora_wifi_mac', generated);
        setMac(generated);
      }
    }
  }, [initialMac]);

  // Countdown timer for Step 2
  useEffect(() => {
    if (step !== 2 || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [step, countdown]);

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  // Step 1: Validate and Request OTP
  const handleRequestOtp = (e: React.FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};

    if (!firstName.trim()) errors.firstName = 'First name is required';
    if (!lastName.trim()) errors.lastName = 'Last name is required';

    const cleanPhone = phone.replace(/[\s()-]/g, '');
    if (!cleanPhone || !/^\+?\d{10,15}$/.test(cleanPhone)) {
      errors.phone = 'Please enter a valid phone number (at least 10 digits)';
    }

    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = 'Please enter a valid email address';
    }

    if (!consent) {
      errors.consent = 'You must agree to the Terms of Service to access the Wi-Fi network';
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    setFormErrors({});
    startSendOtp(async () => {
      try {
        const res = await api<{ sent: true; devCode: string }>(`/wifi/${venue.slug}/otp`, {
          method: 'POST',
          json: { phone: cleanPhone },
        });

        if (res.devCode) {
          setDevCode(res.devCode);
          setOtp(res.devCode); // Pre-fill for instant seamless testing
        }
        setCountdown(300);
        setOtpError(null);
        setStep(2);
      } catch (err) {
        setFormErrors({
          api: err instanceof ApiRequestError ? err.message : errorMessage(err),
        });
      }
    });
  };

  // Step 2: Resend OTP
  const handleResendOtp = () => {
    const cleanPhone = phone.replace(/[\s()-]/g, '');
    startSendOtp(async () => {
      try {
        const res = await api<{ sent: true; devCode: string }>(`/wifi/${venue.slug}/otp`, {
          method: 'POST',
          json: { phone: cleanPhone },
        });

        if (res.devCode) {
          setDevCode(res.devCode);
          setOtp(res.devCode);
        }
        setCountdown(300);
        setOtpError(null);
      } catch (err) {
        setOtpError(err instanceof ApiRequestError ? err.message : errorMessage(err));
      }
    });
  };

  // Step 2: Verify OTP and Connect
  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp.trim())) {
      setOtpError('Please enter a 6-digit verification code');
      return;
    }

    setOtpError(null);
    startConnect(async () => {
      try {
        const cleanPhone = phone.replace(/[\s()-]/g, '');
        const res = await api<WifiConnectResponse>(`/wifi/${venue.slug}/connect`, {
          method: 'POST',
          json: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: cleanPhone,
            email: email.trim() || undefined,
            otp: otp.trim(),
            mac,
            apId,
            marketingOptIn,
            consent: true,
          },
        });

        setConnectResult(res);
        setStep(3);
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'INVALID_OTP') {
          setOtpError('The code is invalid or has expired. Please check and try again.');
          return;
        }
        setOtpError(err instanceof ApiRequestError ? err.message : errorMessage(err));
      }
    });
  };

  return (
    <div className="min-h-screen bg-background-2 flex flex-col justify-center py-8 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-md">
        {/* Venue Branding Header */}
        <div className="mb-6 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
          <div className="relative h-32 w-full bg-gray-100">
            <Image
              src={venue.imageUrl}
              alt={venue.name}
              fill
              priority
              sizes="(max-width: 640px) 100vw, 448px"
              className="object-cover"
              unoptimized={!isOptimizableImage(venue.imageUrl)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
            <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between text-white">
              <span className="text-lg font-bold tracking-tight">{venue.name}</span>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-medium backdrop-blur-md">
                <Wifi size={12} />
                <span>Guest Wi-Fi</span>
              </div>
            </div>
          </div>

          {/* Stepped progress pill */}
          <div className="border-t border-border px-4 py-2.5 bg-background flex items-center justify-between text-xs text-gray-800">
            <span className="font-medium text-gray-900">
              {step === 1 && 'Step 1 of 3: Guest Details'}
              {step === 2 && 'Step 2 of 3: Phone Verification'}
              {step === 3 && 'Step 3 of 3: Connected'}
            </span>
            <div className="flex gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-6 rounded-full transition-colors',
                  step >= 1 ? 'bg-gray-1000' : 'bg-gray-300'
                )}
              />
              <span
                className={cn(
                  'h-1.5 w-6 rounded-full transition-colors',
                  step >= 2 ? 'bg-gray-1000' : 'bg-gray-300'
                )}
              />
              <span
                className={cn(
                  'h-1.5 w-6 rounded-full transition-colors',
                  step === 3 ? 'bg-success' : 'bg-gray-300'
                )}
              />
            </div>
          </div>
        </div>

        {/* STEP 1: Guest Information */}
        {step === 1 && (
          <Card className="border-border bg-background shadow-sm animate-fade-in">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Welcome to Guest Wi-Fi</CardTitle>
              <p className="text-xs text-gray-800">
                Please enter your information to get high-speed internet access.
              </p>
            </CardHeader>

            <CardBody className="pt-2">
              {formErrors.api && (
                <div className="mb-4 rounded-md border border-red/20 bg-red-soft p-3 text-xs text-red-fg flex items-start gap-2">
                  <AlertCircle size={15} className="shrink-0 mt-0.5" />
                  <span>{formErrors.api}</span>
                </div>
              )}

              <form onSubmit={handleRequestOtp} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="wifi-firstname" className="text-xs">
                      First Name *
                    </Label>
                    <Input
                      id="wifi-firstname"
                      value={firstName}
                      onChange={(e) => {
                        setFirstName(e.target.value);
                        if (formErrors.firstName) setFormErrors((p) => ({ ...p, firstName: '' }));
                      }}
                      placeholder="e.g. Priya"
                      className="h-9 text-xs"
                      aria-invalid={Boolean(formErrors.firstName)}
                    />
                    {formErrors.firstName && (
                      <p className="mt-1 text-[11px] text-red-fg">{formErrors.firstName}</p>
                    )}
                  </div>

                  <div>
                    <Label htmlFor="wifi-lastname" className="text-xs">
                      Last Name *
                    </Label>
                    <Input
                      id="wifi-lastname"
                      value={lastName}
                      onChange={(e) => {
                        setLastName(e.target.value);
                        if (formErrors.lastName) setFormErrors((p) => ({ ...p, lastName: '' }));
                      }}
                      placeholder="e.g. Sharma"
                      className="h-9 text-xs"
                      aria-invalid={Boolean(formErrors.lastName)}
                    />
                    {formErrors.lastName && (
                      <p className="mt-1 text-[11px] text-red-fg">{formErrors.lastName}</p>
                    )}
                  </div>
                </div>

                <div>
                  <Label htmlFor="wifi-phone" className="text-xs">
                    Mobile Phone *
                  </Label>
                  <Input
                    id="wifi-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      if (formErrors.phone) setFormErrors((p) => ({ ...p, phone: '' }));
                    }}
                    placeholder="+91 98765 43210"
                    className="h-9 text-xs font-mono tabular-nums"
                    aria-invalid={Boolean(formErrors.phone)}
                  />
                  {formErrors.phone ? (
                    <p className="mt-1 text-[11px] text-red-fg">{formErrors.phone}</p>
                  ) : (
                    <p className="mt-1 text-[11px] text-gray-800">
                      We'll send a 6-digit SMS verification code to this number.
                    </p>
                  )}
                </div>

                <div>
                  <Label htmlFor="wifi-email" className="text-xs">
                    Email Address (Optional)
                  </Label>
                  <Input
                    id="wifi-email"
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (formErrors.email) setFormErrors((p) => ({ ...p, email: '' }));
                    }}
                    placeholder="priya@example.com"
                    className="h-9 text-xs"
                    aria-invalid={Boolean(formErrors.email)}
                  />
                  {formErrors.email && (
                    <p className="mt-1 text-[11px] text-red-fg">{formErrors.email}</p>
                  )}
                </div>

                <div className="pt-2 space-y-3 border-t border-border">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => {
                        setConsent(e.target.checked);
                        if (formErrors.consent) setFormErrors((p) => ({ ...p, consent: '' }));
                      }}
                      className="mt-0.5 size-4 rounded border-border text-gray-1000 focus:ring-gray-1000/20"
                    />
                    <span className="text-xs text-gray-900 leading-snug">
                      I agree to the{' '}
                      <span className="font-semibold text-gray-1000">Terms of Service</span> and
                      Wi-Fi access policy (Required)
                    </span>
                  </label>
                  {formErrors.consent && (
                    <p className="text-[11px] text-red-fg ml-6">{formErrors.consent}</p>
                  )}

                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={marketingOptIn}
                      onChange={(e) => setMarketingOptIn(e.target.checked)}
                      className="mt-0.5 size-4 rounded border-border text-gray-1000 focus:ring-gray-1000/20"
                    />
                    <span className="text-xs text-gray-800 leading-snug">
                      Receive special offers, chef's tastings, and invites from {venue.name}
                    </span>
                  </label>
                </div>

                <Button
                  type="submit"
                  size="md"
                  loading={isSendingOtp}
                  className="w-full mt-4"
                >
                  Send Verification Code
                  {!isSendingOtp && <ArrowRight size={14} className="ml-1" />}
                </Button>
              </form>
            </CardBody>
          </Card>
        )}

        {/* STEP 2: Phone Verification (OTP) */}
        {step === 2 && (
          <Card className="border-border bg-background shadow-sm animate-fade-in">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="inline-flex items-center gap-1 text-xs text-gray-800 hover:text-gray-1000"
                >
                  <ChevronLeft size={14} />
                  Change Phone
                </button>
                <div className="flex items-center gap-1 text-xs text-gray-800 tabular-nums">
                  <Clock size={13} />
                  <span>Expires in {formatCountdown(countdown)}</span>
                </div>
              </div>
              <CardTitle className="text-base font-semibold mt-2">
                Enter Verification Code
              </CardTitle>
              <p className="text-xs text-gray-800">
                We sent a 6-digit SMS verification code to{' '}
                <strong className="text-gray-1000 font-mono">{phone}</strong>.
              </p>
            </CardHeader>

            <CardBody className="pt-2">
              {/* Highlighted Demo Code Banner */}
              {devCode && (
                <div className="mb-5 rounded-lg border border-accent/25 bg-accent-soft p-3.5 text-accent shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <Sparkles size={16} className="shrink-0 mt-0.5 text-accent" />
                      <div>
                        <p className="text-xs font-semibold text-accent">Demo Verification Code</p>
                        <p className="mt-0.5 text-[11px] text-accent/90">
                          (Captive SMS Simulator) Code:{' '}
                          <span className="font-mono text-sm font-bold tracking-wider underline">
                            {devCode}
                          </span>
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOtp(devCode)}
                      className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-accent-hover shrink-0"
                    >
                      <Copy size={11} />
                      Insert
                    </button>
                  </div>
                </div>
              )}

              {otpError && (
                <div className="mb-4 rounded-md border border-red/20 bg-red-soft p-3 text-xs text-red-fg flex items-start gap-2">
                  <AlertCircle size={15} className="shrink-0 mt-0.5" />
                  <span>{otpError}</span>
                </div>
              )}

              <form onSubmit={handleConnect} className="space-y-4">
                <div>
                  <Label htmlFor="wifi-otp" className="text-xs">
                    6-Digit Code
                  </Label>
                  <Input
                    id="wifi-otp"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoFocus
                    value={otp}
                    onChange={(e) => {
                      setOtp(e.target.value.replace(/\D/g, '').slice(0, 6));
                      if (otpError) setOtpError(null);
                    }}
                    placeholder="123456"
                    className="h-11 font-mono text-center text-lg tracking-widest tabular-nums"
                  />
                </div>

                <Button
                  type="submit"
                  size="md"
                  loading={isConnecting}
                  disabled={otp.length !== 6 || countdown === 0}
                  className="w-full"
                >
                  Connect to Wi-Fi
                  {!isConnecting && <Wifi size={14} className="ml-1" />}
                </Button>

                <div className="text-center pt-2">
                  <button
                    type="button"
                    disabled={isSendingOtp}
                    onClick={handleResendOtp}
                    className="text-xs font-medium text-gray-900 hover:text-gray-1000 underline disabled:opacity-50"
                  >
                    Didn't receive the code? Resend Code
                  </button>
                </div>
              </form>
            </CardBody>
          </Card>
        )}

        {/* STEP 3: Connected Success Screen */}
        {step === 3 && connectResult && (
          <div className="space-y-4 animate-fade-in">
            <Card className="border-border bg-background shadow-sm text-center p-6">
              {/* Green Animated Success Indicator */}
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-success-soft text-success ring-8 ring-success-soft/50">
                <CheckCircle2 size={32} />
              </div>

              <div className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success-soft px-3 py-1 text-xs font-semibold text-success-fg mb-3">
                <span className="size-1.5 rounded-full bg-success" />
                <span>Internet Access Granted</span>
              </div>

              <h2 className="text-xl font-bold tracking-tight text-gray-1000">
                {connectResult.isNewGuest
                  ? `Welcome to ${venue.name}!`
                  : `Welcome back, ${connectResult.guestName}!`}
              </h2>

              <p className="mt-1 text-xs text-gray-800">
                You are now connected to high-speed complimentary Wi-Fi.
              </p>

              {/* Loyalty Tier Chip */}
              <div className="mt-4 flex items-center justify-center gap-2">
                <span className="text-xs text-gray-800">Loyalty Status:</span>
                <Badge
                  tone={
                    TIER_DISPLAY_CONFIG[connectResult.tier]?.tone ?? 'neutral'
                  }
                  className="font-medium px-2.5 py-0.5 text-xs"
                >
                  <Award size={12} className="mr-1" />
                  {TIER_DISPLAY_CONFIG[connectResult.tier]?.label ?? connectResult.tier}
                </Badge>
              </div>
            </Card>

            {/* Matched Reservation Banner if Found */}
            {connectResult.matchedReservation && (
              <Card className="border-border bg-background p-4 border-l-4 border-l-accent shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-accent-soft p-2 text-accent">
                    <Utensils size={18} />
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-accent">
                      Reservation Recognized
                    </h3>
                    <p className="mt-0.5 text-sm font-semibold text-gray-1000">
                      We see your reservation today at {connectResult.matchedReservation.time}!
                    </p>
                    <p className="mt-1 text-xs text-gray-800">
                      {connectResult.matchedReservation.tableNumber
                        ? `Your table is Table ${connectResult.matchedReservation.tableNumber}. Enjoy your meal!`
                        : 'The host has been notified of your arrival and will seat you shortly.'}
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {/* Network Connection Metrics Card */}
            <Card className="border-border bg-background p-4 shadow-sm text-xs">
              <h3 className="font-semibold text-gray-900 uppercase tracking-wider text-[11px] mb-3">
                Connection Metrics
              </h3>
              <div className="grid grid-cols-2 gap-2.5 text-gray-800">
                <div className="flex items-center gap-2">
                  <Signal size={13} className="text-success" />
                  <span>Signal: <strong>Excellent (-48 dBm)</strong></span>
                </div>
                <div className="flex items-center gap-2">
                  <Wifi size={13} className="text-accent" />
                  <span>Bandwidth: <strong>150 Mbps</strong></span>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldCheck size={13} className="text-gray-700" />
                  <span>Protocol: <strong>WPA3-Enterprise</strong></span>
                </div>
                <div className="flex items-center gap-2">
                  <Smartphone size={13} className="text-gray-700" />
                  <span className="font-mono text-[10px]">MAC: {mac}</span>
                </div>
              </div>
            </Card>

            {/* CTA back to restaurant menu / reservations */}
            <div className="pt-2">
              <Link
                href={`/r/${venue.slug}`}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-gray-1000 px-4 text-xs font-medium text-white transition-colors hover:bg-[#383838]"
              >
                Explore {venue.name} Menu & Dining
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        )}

        {/* Footer attribution */}
        <p className="mt-6 text-center text-[11px] text-gray-800">
          Powered by Nexora Guest Engine · Enterprise Wi-Fi Gateway
        </p>
      </div>
    </div>
  );
}
