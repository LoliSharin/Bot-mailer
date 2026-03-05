import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
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
    if (payload.orderId && !this.mockSiteService.hasOrder(payload.orderId)) {
      throw new NotFoundException('Order not found');
    }

    return this.mockSiteService.saveFromTelegram(payload);
  }

  @Post('chat/:orderId/message')
  @HttpCode(HttpStatus.OK)
  postOrderMessage(
    @Param('orderId') orderId: string,
    @Body() payload: { chatId: string; text: string },
  ) {
    if (!this.mockSiteService.hasOrder(orderId)) {
      throw new NotFoundException('Order not found');
    }

    return this.mockSiteService.saveFromTelegramOrderPath(orderId, payload);
  }

  @Get('orders')
  getOrders() {
    return this.mockSiteService.getOrders();
  }

  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  createOrder(@Body() payload: { orderId?: string; title?: string }) {
    const orderId = payload.orderId?.trim();
    if (!orderId) {
      throw new BadRequestException('orderId is required');
    }

    return this.mockSiteService.createOrder(orderId, payload.title);
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
