import type { FriendsResource } from './resources/friends.js';
import type { ScenariosResource } from './resources/scenarios.js';
import type { BroadcastsResource } from './resources/broadcasts.js';
import type {
  StepDefinition,
  ScenarioTriggerType,
  ScenarioWithSteps,
  Broadcast,
  MessageType,
  SegmentCondition,
} from './types.js';
import { parseDelay } from './delay.js';

export class Workflows {
  constructor(
    private readonly friends: FriendsResource,
    private readonly scenarios: ScenariosResource,
    private readonly broadcasts: BroadcastsResource,
  ) {}

  async createStepScenario(
    name: string,
    triggerType: ScenarioTriggerType,
    steps: StepDefinition[],
  ): Promise<ScenarioWithSteps> {
    // Triggers must not enroll friends while the step list is incomplete.
    // Leave a failed construction inactive so staff can inspect and repair it.
    const scenario = await this.scenarios.create({ name, triggerType, isActive: false });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await this.scenarios.addStep(scenario.id, {
        stepOrder: i + 1,
        delayMinutes: parseDelay(step.delay),
        messageType: step.type,
        messageContent: step.content,
      });
    }

    await this.scenarios.update(scenario.id, { isActive: true });
    return this.scenarios.get(scenario.id);
  }

  async broadcastText(text: string): Promise<Broadcast> {
    const broadcast = await this.broadcasts.create({
      title: text.slice(0, 50),
      messageType: 'text',
      messageContent: text,
      targetType: 'all',
    });
    return this.broadcasts.send(broadcast.id);
  }

  async broadcastToTag(tagId: string, messageType: MessageType, content: string): Promise<Broadcast> {
    const broadcast = await this.broadcasts.create({
      title: content.slice(0, 50),
      messageType,
      messageContent: content,
      targetType: 'tag',
      targetTagId: tagId,
    });
    return this.broadcasts.send(broadcast.id);
  }

  async broadcastToSegment(
    messageType: MessageType,
    content: string,
    conditions: SegmentCondition,
  ): Promise<Broadcast> {
    const broadcast = await this.broadcasts.create({
      title: content.slice(0, 50),
      messageType,
      messageContent: content,
      targetType: 'all',
    });
    return this.broadcasts.sendToSegment(broadcast.id, conditions);
  }

  async sendTextToFriend(friendId: string, text: string): Promise<{ messageId: string }> {
    return this.friends.sendMessage(friendId, text, 'text');
  }

  async sendFlexToFriend(friendId: string, flexJson: string): Promise<{ messageId: string }> {
    return this.friends.sendMessage(friendId, flexJson, 'flex');
  }
}
