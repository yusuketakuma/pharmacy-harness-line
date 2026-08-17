import type { HttpClient } from '../http.js'
import type {
  ApiResponse,
  CreateRichMenuGroupInput,
  PreparePharmacyRichMenuInput,
  PreparePharmacyRichMenuResult,
  RichMenuGroup,
  UpdateRichMenuGroupInput,
} from '../types.js'

export type RichMenuApplyInput = {
  mode: 'bulk-link' | 'set-default'
  tagId?: string | null
  dryRun?: boolean
  confirmationToken?: string
}

export type RichMenuMutationResult = {
  dryRun?: boolean
  confirmationToken?: string
  affected?: number
  chunks?: number
  [key: string]: unknown
}

function decodeBase64(value: string): Uint8Array {
  const base64 = value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class RichMenuGroupsResource {
  constructor(
    private readonly http: HttpClient,
    private readonly defaultAccountId?: string,
  ) {}

  private accountId(explicit?: string): string {
    const accountId = explicit ?? this.defaultAccountId
    if (!accountId) throw new Error('lineAccountId is required for rich-menu group operations')
    return accountId
  }

  private path(path: string, explicitAccountId?: string): string {
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}accountId=${encodeURIComponent(this.accountId(explicitAccountId))}`
  }

  async list(accountId?: string): Promise<RichMenuGroup[]> {
    const res = await this.http.get<ApiResponse<RichMenuGroup[]>>(this.path('/api/rich-menu-groups', accountId))
    return res.data
  }

  async get(groupId: string, accountId?: string): Promise<RichMenuGroup> {
    const res = await this.http.get<ApiResponse<RichMenuGroup>>(
      this.path(`/api/rich-menu-groups/${encodeURIComponent(groupId)}`, accountId),
    )
    return res.data
  }

  async create(input: CreateRichMenuGroupInput, accountId?: string): Promise<RichMenuGroup> {
    const resolvedAccountId = this.accountId(accountId ?? input.accountId)
    const { accountId: _inputAccountId, ...body } = input
    const res = await this.http.post<ApiResponse<RichMenuGroup>>(
      this.path('/api/rich-menu-groups', resolvedAccountId),
      { ...body, accountId: resolvedAccountId },
    )
    return res.data
  }

  async update(groupId: string, input: UpdateRichMenuGroupInput, accountId?: string): Promise<RichMenuGroup> {
    const res = await this.http.patch<ApiResponse<RichMenuGroup>>(
      this.path(`/api/rich-menu-groups/${encodeURIComponent(groupId)}`, accountId),
      input,
    )
    return res.data
  }

  async delete(groupId: string, options?: { force?: boolean; accountId?: string }): Promise<void> {
    const path = this.path(`/api/rich-menu-groups/${encodeURIComponent(groupId)}`, options?.accountId)
    const force = options?.force ? '&force=true' : ''
    await this.http.delete(`${path}${force}`)
  }

  async uploadImage(
    groupId: string,
    pageId: string,
    imageData: string,
    contentType: 'image/png' | 'image/jpeg',
    accountId?: string,
  ): Promise<{ imageR2Key: string; imageContentType: string; size: 'large' | 'compact' }> {
    const res = await this.http.postBinary<ApiResponse<{ imageR2Key: string; imageContentType: string; size: 'large' | 'compact' }>>(
      this.path(
        `/api/rich-menu-groups/${encodeURIComponent(groupId)}/pages/${encodeURIComponent(pageId)}/image`,
        accountId,
      ),
      decodeBase64(imageData),
      contentType,
    )
    return res.data
  }

  async publish(groupId: string, accountId?: string): Promise<RichMenuMutationResult> {
    const res = await this.http.post<ApiResponse<RichMenuMutationResult>>(
      this.path(`/api/rich-menu-groups/${encodeURIComponent(groupId)}/publish`, accountId),
    )
    return res.data
  }

  async unpublish(groupId: string, accountId?: string): Promise<RichMenuMutationResult> {
    const res = await this.http.post<ApiResponse<RichMenuMutationResult>>(
      this.path(`/api/rich-menu-groups/${encodeURIComponent(groupId)}/unpublish`, accountId),
    )
    return res.data
  }

  async applyToTag(
    groupId: string,
    input: RichMenuApplyInput,
    accountId?: string,
  ): Promise<RichMenuMutationResult> {
    const res = await this.http.post<ApiResponse<RichMenuMutationResult>>(
      this.path(`/api/rich-menu-groups/${encodeURIComponent(groupId)}/apply-to-tag`, accountId),
      input,
    )
    return res.data
  }

  async preparePharmacy(
    input: PreparePharmacyRichMenuInput = {},
    accountId?: string,
  ): Promise<PreparePharmacyRichMenuResult> {
    const res = await this.http.post<ApiResponse<PreparePharmacyRichMenuResult>>(
      this.path('/api/custom/pharmacy/rich-menus/prepare', accountId),
      input,
    )
    return res.data
  }
}
