import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class InternalSecretGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedSecret = this.configService.get<string>('SITE_API_SECRET');
    if (!expectedSecret) {
      throw new ServiceUnavailableException(
        'SITE_API_SECRET is not configured',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedSecret = this.getHeaderValue(
      request.headers['x-site-api-secret'],
    );

    if (providedSecret !== expectedSecret) {
      throw new UnauthorizedException('невалидный api секретного ключа');
    }

    return true;
  }

  private getHeaderValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }

    return value ?? '';
  }
}
