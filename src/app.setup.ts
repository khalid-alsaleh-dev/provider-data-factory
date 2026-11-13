import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_KEY_HEADER } from './common/api-key.guard';

/** Application-wide setup shared by main.ts and the integration tests. */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('Provider Data Factory')
    .setDescription('Turns raw provider exports into clean restaurant data.')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: API_KEY_HEADER }, 'api-key')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, openApi));

  return app;
}
