import { encodePathSegment } from '../path-segment.js';
import type { HttpClient } from '../http.js';
import type {
  ApiResponse,
  Scenario,
  ScenarioListItem,
  ScenarioWithSteps,
  ScenarioStep,
  ScenarioStats,
  CreateScenarioInput,
  CreateStepInput,
  UpdateScenarioInput,
  UpdateStepInput,
  FriendScenarioEnrollment,
} from '../types.js';

export class ScenariosResource {
  constructor(
    private readonly http: HttpClient,
    private readonly defaultAccountId?: string,
  ) {}

  async list(params?: { accountId?: string }): Promise<ScenarioListItem[]> {
    const accountId = params?.accountId ?? this.defaultAccountId;
    const query = accountId ? `?lineAccountId=${encodeURIComponent(accountId)}` : '';
    const res = await this.http.get<ApiResponse<ScenarioListItem[]>>(`/api/scenarios${query}`);
    return res.data;
  }

  async get(id: string): Promise<ScenarioWithSteps> {
    const res = await this.http.get<ApiResponse<ScenarioWithSteps>>(`/api/scenarios/${encodePathSegment(id)}`);
    return res.data;
  }

  async create(input: CreateScenarioInput & { lineAccountId?: string }): Promise<Scenario> {
    const body = { ...input };
    if (!body.lineAccountId && this.defaultAccountId) {
      body.lineAccountId = this.defaultAccountId;
    }
    const res = await this.http.post<ApiResponse<Scenario>>('/api/scenarios', body);
    return res.data;
  }

  async update(id: string, input: UpdateScenarioInput): Promise<Scenario> {
    const res = await this.http.put<ApiResponse<Scenario>>(`/api/scenarios/${encodePathSegment(id)}`, input);
    return res.data;
  }

  async delete(id: string): Promise<void> {
    await this.http.delete(`/api/scenarios/${encodePathSegment(id)}`);
  }

  async addStep(scenarioId: string, input: CreateStepInput): Promise<ScenarioStep> {
    const res = await this.http.post<ApiResponse<ScenarioStep>>(
      `/api/scenarios/${encodePathSegment(scenarioId)}/steps`,
      input,
    );
    return res.data;
  }

  async updateStep(scenarioId: string, stepId: string, input: UpdateStepInput): Promise<ScenarioStep> {
    const res = await this.http.put<ApiResponse<ScenarioStep>>(
      `/api/scenarios/${encodePathSegment(scenarioId)}/steps/${encodePathSegment(stepId)}`,
      input,
    );
    return res.data;
  }

  async deleteStep(scenarioId: string, stepId: string): Promise<void> {
    await this.http.delete(`/api/scenarios/${encodePathSegment(scenarioId)}/steps/${encodePathSegment(stepId)}`);
  }

  async enroll(scenarioId: string, friendId: string): Promise<FriendScenarioEnrollment> {
    const res = await this.http.post<ApiResponse<FriendScenarioEnrollment>>(
      `/api/scenarios/${encodePathSegment(scenarioId)}/enroll/${encodePathSegment(friendId)}`,
    );
    return res.data;
  }

  async getStats(id: string): Promise<ScenarioStats> {
    const res = await this.http.get<ApiResponse<ScenarioStats>>(`/api/scenarios/${encodePathSegment(id)}/stats`);
    return res.data;
  }
}
