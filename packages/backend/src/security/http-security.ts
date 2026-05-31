import { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

export const secureCookieDefaults = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
};

function normalizeOrigins(value?: string): string[] {
  if (!value?.trim()) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
}

function getRequestId(request: Request): string {
  const existing = request.headers['x-request-id'];

  if (Array.isArray(existing) && existing.length > 0) {
    return existing[0];
  }

  if (typeof existing === 'string' && existing.trim().length > 0) {
    return existing.trim();
  }

  return randomUUID();
}

export function getAllowedOrigins(): string[] {
  return normalizeOrigins(
    process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL,
  );
}

export function configureHttpSecurity(
  app: INestApplication,
  allowedOrigins = getAllowedOrigins(),
) {
  const secureApp = app as INestApplication & {
    disable(setting: string): INestApplication;
  };

  secureApp.disable('x-powered-by');

  secureApp.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = getRequestId(request);
    response.setHeader('X-Request-ID', requestId);
    response.locals.requestId = requestId;
    next();
  });

  secureApp.use((request: Request, response: Response, next: NextFunction) => {
    const originalCookie = response.cookie.bind(response);

    response.cookie = ((name, value, options = {}) =>
      originalCookie(name, value, {
        ...secureCookieDefaults,
        ...options,
      })) as typeof response.cookie;

    next();
  });

  secureApp.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'https:', 'wss:'],
        },
      },
      frameguard: {
        action: 'deny',
      },
      noSniff: true,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  secureApp.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
}
