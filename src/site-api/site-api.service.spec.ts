import { HttpService } from '@nestjs/axios';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { SiteApiService } from './site-api.service';

describe('SiteApiService', () => {
  let service: SiteApiService;
  let httpServiceMock: { get: jest.Mock; post: jest.Mock };
  let configServiceMock: { get: jest.Mock };

  beforeEach(async () => {
    httpServiceMock = {
      get: jest.fn(),
      post: jest.fn(),
    };

    configServiceMock = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SiteApiService,
        { provide: HttpService, useValue: httpServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
      ],
    }).compile();

    service = module.get<SiteApiService>(SiteApiService);
  });

  it('returns null when SITE_API_URL is missing for link resolving', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return undefined;
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

    const result = await service.resolveLinkToken('any-token');

    expect(result).toBeNull();
    expect(httpServiceMock.get).not.toHaveBeenCalled();
  });

  it('resolves token through site api', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return 'http://localhost:3000';
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

    httpServiceMock.get.mockReturnValue(of({ data: { userId: 'u-1' } }));

    const result = await service.resolveLinkToken('valid-token');

    expect(result).toEqual({ userId: 'u-1' });
    expect(httpServiceMock.get).toHaveBeenCalledWith(
      'http://localhost:3000/api/link',
      expect.objectContaining({
        params: { token: 'valid-token' },
        headers: { 'x-site-api-secret': 'secret' },
      }),
    );
  });

  it('returns false when relay to site fails', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'SITE_API_URL') {
        return 'http://localhost:3000';
      }
      if (key === 'SITE_API_SECRET') {
        return 'secret';
      }
      return undefined;
    });

    httpServiceMock.post.mockReturnValue(
      throwError(() => new Error('connection refused')),
    );

    const result = await service.forwardMessageFromTelegram({
      chatId: '123',
      text: 'hello',
    });

    expect(result).toBe(false);
  });
});
