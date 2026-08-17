import type { HttpClient } from '../http.js'
import type { ApiResponse, RichMenu, CreateRichMenuInput } from '../types.js'

export class RichMenusResource {
  constructor(
    private readonly http: HttpClient,
    private readonly defaultAccountId?: string,
  ) {}

  private scopedPath(path: string, accountId?: string): string {
    const resolvedAccountId = accountId ?? this.defaultAccountId
    if (!resolvedAccountId) {
      throw new Error('lineAccountId is required for rich-menu operations')
    }
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}accountId=${encodeURIComponent(resolvedAccountId)}`
  }

  async list(accountId?: string): Promise<RichMenu[]> {
    const res = await this.http.get<ApiResponse<RichMenu[]>>(this.scopedPath('/api/rich-menus', accountId))
    return res.data
  }

  async create(menu: CreateRichMenuInput, accountId?: string): Promise<{ richMenuId: string }> {
    const res = await this.http.post<ApiResponse<{ richMenuId: string }>>(
      this.scopedPath('/api/rich-menus', accountId),
      menu,
    )
    return res.data
  }

  async delete(richMenuId: string, accountId?: string): Promise<void> {
    await this.http.delete(this.scopedPath(`/api/rich-menus/${encodeURIComponent(richMenuId)}`, accountId))
  }

  async setDefault(richMenuId: string, accountId?: string): Promise<void> {
    await this.http.post(this.scopedPath(`/api/rich-menus/${encodeURIComponent(richMenuId)}/default`, accountId))
  }

  async uploadImage(
    richMenuId: string,
    imageData: string,
    contentType: string = 'image/png',
    accountId?: string,
  ): Promise<void> {
    await this.http.post(this.scopedPath(`/api/rich-menus/${encodeURIComponent(richMenuId)}/image`, accountId), {
      imageData,
      contentType,
    })
  }
}
