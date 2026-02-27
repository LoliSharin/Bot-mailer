import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { MockSiteService } from './mock-site.service';

@Controller('api')
export class MockSiteController {
  constructor(private readonly mockSiteService: MockSiteService) {}

  @Get('link')
  getLink(@Query('token') token?: string) {
    if (!token) {
      throw new NotFoundException('Token is required');
    }

    const result = this.mockSiteService.resolveLinkToken(token);
    if (!result) {
      throw new NotFoundException('Token is invalid or expired');
    }

    return result;
  }

  @Post('chat/from-telegram')
  @HttpCode(HttpStatus.OK)
  postFromTelegram(
    @Body() payload: { chatId: string; text: string; orderId?: string },
  ) {
    return this.mockSiteService.saveFromTelegram(payload);
  }

  @Post('telegram/disconnected')
  @HttpCode(HttpStatus.OK)
  postDisconnected(@Body() payload: { chatId: string }) {
    return this.mockSiteService.markDisconnected(payload.chatId);
  }

  @Get('chat/messages')
  getMessages() {
    return this.mockSiteService.getMessages();
  }

  @Get('telegram/disconnected')
  getDisconnectedUsers() {
    return this.mockSiteService.getDisconnectedUsers();
  }
}
