import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { configureHttpSecurity } from './security/http-security';
import { ShutdownService } from './health/shutdown.service';

// ─── Graceful-shutdown constants ─────────────────────────────────────────────
/** Maximum time (ms) to wait for in-flight requests to drain. */
const IN_FLIGHT_TIMEOUT_MS = 30_000;
/** Hard kill-switch: force-exit if graceful shutdown takes longer than this. */
const FORCE_KILL_TIMEOUT_MS = 60_000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable NestJS lifecycle hooks (OnApplicationShutdown, etc.)
  app.enableShutdownHooks();

  // Attach the Socket.io WebSocket adapter — required for the EventsGateway
  app.useWebSocketAdapter(new IoAdapter(app));

  configureHttpSecurity(app);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Setup Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('BACKit on Stellar API')
    .setDescription(
      'API documentation for BACKit - Blockchain Asset Call Kit on Stellar. ' +
        'A prediction market platform for cryptocurrency trading calls.',
    )
    .setVersion('1.0.0')
    .setContact(
      'BACKit Team',
      'https://github.com/degenspot/BACKit-onStellar',
      'support@backit.io',
    )
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addServer(
      `http://localhost:${process.env.PORT || 3001}`,
      'Local Development',
    )
    .addServer('https://api.backit.io', 'Production')
    .addTag('default', 'General API information')
    .addTag('health', 'Health check and monitoring endpoints')
    .addTag('authentication', 'User authentication and registration')
    .addTag('calls', 'Trading call management and predictions')
    .addTag('feed', 'Social feed and posts')
    .addTag('profile', 'User profile management')
    .addTag('create', 'Content creation endpoints')
    .addTag('oracle', 'Oracle and blockchain interaction endpoints')
    .addTag('indexer', 'Event indexer endpoints')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'BACKit API Documentation',
    customfavIcon: 'https://docs.nestjs.com/assets/favicon.ico',
    customCss: `
      .swagger-ui .topbar { background-color: #1a1a1a; }
      .swagger-ui .info { margin: 50px 0; }
      .swagger-ui .info .title { font-size: 36px; color: #00d4ff; }
      .swagger-ui .info .description { font-size: 16px; line-height: 1.6; }
      .swagger-ui .scheme-container { background: #fafafa; padding: 15px; }
      .swagger-ui .opblock-tag { font-size: 18px; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      showRequestDuration: true,
      tryItOutEnabled: true,
      displayRequestDuration: true,
      defaultModelsExpandDepth: 3,
      defaultModelExpandDepth: 3,
      syntaxHighlight: {
        activate: true,
        theme: 'monokai',
      },
    },
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  await app.listen(port);

  Logger.log(`🚀 Backend running on http://localhost:${port}`, 'Bootstrap');
  Logger.log(
    `📚 Swagger documentation available at http://localhost:${port}/api/docs`,
    'Bootstrap',
  );
  Logger.log(
    `📊 API JSON spec available at http://localhost:${port}/api/docs-json`,
    'Bootstrap',
  );
  Logger.log(
    `💚 Health check available at http://localhost:${port}/health`,
    'Bootstrap',
  );
  Logger.log(
    `🔌 WebSocket gateway available at ws://localhost:${port}/ws`,
    'Bootstrap',
  );
  Logger.log(
    `🌍 Environment: ${process.env.NODE_ENV || 'development'}`,
    'Bootstrap',
  );

  // ─── Graceful Shutdown ──────────────────────────────────────────────────

  const shutdownService = app.get(ShutdownService);

  const gracefulShutdown = async (signal: string) => {
    const shutdownLogger = new Logger('GracefulShutdown');
    shutdownLogger.log(`Received ${signal} — starting graceful shutdown`);

    // Force-kill timer: if shutdown stalls, exit hard after FORCE_KILL_TIMEOUT_MS
    const forceKillTimer = setTimeout(() => {
      shutdownLogger.error(
        `Graceful shutdown exceeded ${FORCE_KILL_TIMEOUT_MS / 1000}s — forcing exit`,
      );
      process.exit(1);
    }, FORCE_KILL_TIMEOUT_MS);
    // Don't let this timer keep the event loop alive (Node.js Timeout object)
    (forceKillTimer as unknown as { unref(): void }).unref();

    try {
      // 1. Signal readiness probe to return 503 — stops new traffic immediately
      shutdownLogger.log('Step 1/6 — marking application as shutting down (503 on /health/ready)');
      shutdownService.beginShutdown();

      // 2. Stop accepting new HTTP connections; drain in-flight requests
      shutdownLogger.log(
        `Step 2/6 — closing HTTP server (${IN_FLIGHT_TIMEOUT_MS / 1000}s drain window)`,
      );
      const httpServer = app.getHttpServer();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Resolve early if drain completes before timeout
        setTimeout(resolve, IN_FLIGHT_TIMEOUT_MS);
      });
      shutdownLogger.log('Step 2/6 — HTTP server closed');

      // 3. Save indexer checkpoint before DB goes away
      shutdownLogger.log('Step 3/6 — saving indexer checkpoint');
      await shutdownService.saveIndexerCheckpoint();

      // 4. Stop cron jobs, close WebSocket connections, flush queues, close DB/Redis
      //    app.close() triggers NestJS OnApplicationShutdown hooks on all providers
      //    (ScheduleModule stops crons, BullMQ closes Redis, TypeORM closes DB, etc.)
      shutdownLogger.log('Step 4/6 — stopping cron jobs');
      shutdownLogger.log('Step 5/6 — closing WebSocket connections');
      shutdownLogger.log('Step 6/6 — closing database and Redis connections');
      await app.close();

      clearTimeout(forceKillTimer);
      shutdownLogger.log('Graceful shutdown complete — exiting');
      process.exit(0);
    } catch (err: any) {
      shutdownLogger.error(`Error during graceful shutdown: ${err.message}`, err.stack);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap().catch((error) => {
  Logger.error(
    `Failed to start application: ${error.message}`,
    error.stack,
    'Bootstrap',
  );
  process.exit(1);
});
