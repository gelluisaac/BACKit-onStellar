import { Controller, Get, Module, Res } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { configureHttpSecurity } from '../src/security/http-security';

@Controller('security')
class SecurityTestController {
  @Get('headers')
  getHeaders() {
    return { ok: true };
  }

  @Get('cookie')
  setCookie(@Res({ passthrough: true }) response: Response) {
    response.cookie('session', 'abc123');
    return { ok: true };
  }
}

@Module({
  controllers: [SecurityTestController],
})
class SecurityTestModule {}

describe('HTTP security hardening', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let previousAllowedOrigins: string | undefined;
  let previousNodeEnv: string | undefined;

  async function createTestApp() {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [SecurityTestModule],
    }).compile();

    const application = moduleFixture.createNestApplication();
    configureHttpSecurity(application, [
      'http://allowed.test',
      'http://second.test',
    ]);
    await application.init();

    return application;
  }

  beforeAll(async () => {
    previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
    previousNodeEnv = process.env.NODE_ENV;
    process.env.ALLOWED_ORIGINS = 'http://allowed.test,http://second.test';
    process.env.NODE_ENV = 'production';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
    process.env.NODE_ENV = previousNodeEnv;
  });

  it('applies the expected security and CORS headers', async () => {
    const requestId = 'test-request-id-123';

    const response = await request(app.getHttpServer())
      .get('/security/headers')
      .set('Origin', 'http://allowed.test')
      .set('X-Request-ID', requestId)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://allowed.test',
    );
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.headers['strict-transport-security']).toContain('max-age=');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('applies secure cookie defaults when a response sets cookies', async () => {
    const response = await request(app.getHttpServer())
      .get('/security/cookie')
      .expect(200);

    const cookieHeader = response.headers['set-cookie'];
    expect(cookieHeader).toBeDefined();
    expect(Array.isArray(cookieHeader)).toBe(true);

    if (!Array.isArray(cookieHeader)) {
      throw new Error('Expected a set-cookie header array');
    }

    const [cookie] = cookieHeader;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });
});
