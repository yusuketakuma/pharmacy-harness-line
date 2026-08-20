import type { HttpClient } from '../http.js'
import type { ApiResponse, StaffCredentialIssue, StaffMember, StaffProfile, CreateStaffInput, UpdateStaffInput } from '../types.js'

export class StaffResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<StaffMember[]> {
    const res = await this.http.get<ApiResponse<StaffMember[]>>('/api/staff')
    return res.data
  }

  async get(id: string): Promise<StaffMember> {
    const res = await this.http.get<ApiResponse<StaffMember>>(`/api/staff/${id}`)
    return res.data
  }

  async me(): Promise<StaffProfile> {
    const res = await this.http.get<ApiResponse<StaffProfile>>('/api/staff/me')
    return res.data
  }

  async create(input: CreateStaffInput): Promise<StaffMember & StaffCredentialIssue> {
    const res = await this.http.post<ApiResponse<StaffMember & StaffCredentialIssue>>('/api/staff', input)
    return res.data
  }

  async update(id: string, input: UpdateStaffInput): Promise<StaffMember> {
    const res = await this.http.patch<ApiResponse<StaffMember>>(`/api/staff/${id}`, input)
    return res.data
  }

  async delete(id: string): Promise<void> {
    await this.http.delete(`/api/staff/${id}`)
  }

  async resetPassword(id: string, loginId?: string): Promise<StaffCredentialIssue> {
    const res = await this.http.post<ApiResponse<StaffCredentialIssue>>(
      `/api/staff/${id}/reset-password`,
      { loginId },
    )
    return res.data
  }
}
