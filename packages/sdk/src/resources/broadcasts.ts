import { encodePathSegment } from '../path-segment.js';
import type { HttpClient } from '../http.js';
import type { ApiResponse, Broadcast, CreateBroadcastInput, UpdateBroadcastInput, SegmentCondition } from '../types.js';

export class BroadcastsResource {
  constructor(
    private readonly http: HttpClient,
    private readonly defaultAccountId?: string,
  ) {}

  async list(params?: { accountId?: string }): Promise<Broadcast[]> {
    const accountId = params?.accountId ?? this.defaultAccountId;
    const query = accountId ? `?lineAccountId=${encodeURIComponent(accountId)}` : '';
    const res = await this.http.get<ApiResponse<Broadcast[]>>(`/api/broadcasts${query}`);
    return res.data;
  }

  async get(id: string): Promise<Broadcast> {
    const res = await this.http.get<ApiResponse<Broadcast>>(`/api/broadcasts/${encodePathSegment(id)}`);
    return res.data;
  }

  async create(input: CreateBroadcastInput & { lineAccountId?: string; idempotencyKey?: string }): Promise<Broadcast> {
    const { idempotencyKey, ...body } = input;
    if (!body.lineAccountId && this.defaultAccountId) {
      body.lineAccountId = this.defaultAccountId;
    }
    const res = idempotencyKey
      ? await this.http.post<ApiResponse<Broadcast>>('/api/broadcasts', body, {
          'Idempotency-Key': idempotencyKey,
        })
      : await this.http.post<ApiResponse<Broadcast>>('/api/broadcasts', body);
    return res.data;
  }

  async update(id: string, input: UpdateBroadcastInput): Promise<Broadcast> {
    const res = await this.http.put<ApiResponse<Broadcast>>(`/api/broadcasts/${encodePathSegment(id)}`, input);
    return res.data;
  }

  async delete(id: string): Promise<void> {
    await this.http.delete(`/api/broadcasts/${encodePathSegment(id)}`);
  }

  async send(id: string): Promise<Broadcast> {
    const res = await this.http.post<ApiResponse<Broadcast>>(`/api/broadcasts/${encodePathSegment(id)}/send`);
    return res.data;
  }

  async sendToSegment(id: string, conditions: SegmentCondition): Promise<Broadcast> {
    const res = await this.http.post<ApiResponse<Broadcast>>(`/api/broadcasts/${encodePathSegment(id)}/send-segment`, {
      conditions,
    });
    return res.data;
  }
}
