import { Injectable, BadGatewayException, GatewayTimeoutException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

const HOP_BY_HOP_HEADERS = ['host', 'content-length', 'connection'];

@Injectable()
export class ProxyService {
  constructor(private httpService: HttpService) {}

  private forwardableHeaders(headers: Request['headers']): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) continue;
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  }

  async forward(req: Request, res: Response, targetBaseUrl: string): Promise<void> {
    const targetUrl = `${targetBaseUrl}${req.originalUrl}`;

    try {
      const response = await firstValueFrom(
        this.httpService.request({
          method: req.method as any,
          url: targetUrl,
          data: req.body,
          headers: this.forwardableHeaders(req.headers),
          timeout: 15000,
          validateStatus: () => true,
        }),
      );
      res.status(response.status).json(response.data);
    } catch (error: any) {
      const axiosError = error as AxiosError;
      if (axiosError.code === 'ECONNABORTED') {
        throw new GatewayTimeoutException({ success: false, message: 'Upstream service timed out' });
      }
      throw new BadGatewayException({ success: false, message: 'Upstream service unavailable' });
    }
  }
}