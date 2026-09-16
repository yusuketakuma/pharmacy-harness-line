/**
 * Notify: check external conditions and trigger automated LINE notifications
 * via LINE Harness scenarios.
 *
 * Contract note (F08): the per-friend messages API
 * (`POST /api/friends/:id/messages`, exposed as `sendTextToFriend` /
 * `sendFlexToFriend`) requires the `X-Line-Harness-Source: manual` header and
 * is reserved for manual 1:1 staff replies — the Worker rejects it for
 * automated sends. There is no external API for automated 1:1 pushes, so
 * automated notifications must go through a `tag_added` scenario or a
 * broadcast instead.
 *
 * Pattern used here:
 *   1. cron checks external conditions
 *   2. attach a per-notification *trigger* tag to the target friend
 *   3. a `tag_added` scenario fires and sends the message
 *   4. the tag itself doubles as the dedup marker — friends already carrying
 *      it are skipped on the next cron run
 *
 * Scenario messages are static: per-friend variables (e.g. an appointment
 * time) cannot be interpolated from outside. Point users at a LIFF page or
 * web page for the details instead.
 */

import { LineHarness } from '@line-harness/sdk'
import { MyServiceClient } from './external-api.js'
import type { Env } from './index.js'

/**
 * Check conditions in MyService and send relevant notifications.
 */
export async function checkAndNotify(env: Env): Promise<void> {
  const harness = new LineHarness({
    apiUrl: env.LINE_HARNESS_API_URL,
    apiKey: env.LINE_HARNESS_API_KEY,
    tenantId: env.LINE_HARNESS_TENANT_ID,
    lineAccountId: env.LINE_ACCOUNT_ID,
  })
  const myService = new MyServiceClient(env.EXTERNAL_API_KEY)

  // Example 1: Send appointment reminders
  await sendAppointmentReminders(harness, myService)

  // Example 2: Notify about expiring memberships
  await notifyExpiringMemberships(harness, myService)
}

/**
 * Find-or-create a `tag_added` scenario that sends a static message when the
 * trigger tag is attached to a friend.
 */
async function ensureTagAddedScenario(
  harness: LineHarness,
  name: string,
  triggerTagId: string,
  messageContent: string,
): Promise<void> {
  const existing = (await harness.scenarios.list()).find((s) => s.name === name)
  if (existing) return
  const scenario = await harness.scenarios.create({
    name,
    triggerType: 'tag_added',
    triggerTagId,
    isActive: true,
  })
  await harness.scenarios.addStep(scenario.id, {
    stepOrder: 1,
    delayMinutes: 0,
    messageType: 'text',
    messageContent,
  })
}

/**
 * Example: trigger a reminder scenario for friends with upcoming appointments.
 *
 * The scenario sends a static reminder text; per-appointment details like the
 * time or location stay in MyService, so the message links to a details page.
 * Friends keep the trigger tag, which also prevents re-notification — remove
 * it when the appointment passes so a future appointment can re-trigger.
 */
async function sendAppointmentReminders(
  harness: LineHarness,
  myService: MyServiceClient,
): Promise<void> {
  const upcoming = await myService.getUpcomingAppointments(24) // next 24 hours

  const allTags = await harness.tags.list()
  let triggerTag = allTags.find((t) => t.name === 'myservice:appt-reminder')
  if (!triggerTag) {
    triggerTag = await harness.tags.create({ name: 'myservice:appt-reminder', color: '#6B7280' })
  }
  await ensureTagAddedScenario(
    harness,
    'MyService appointment reminder',
    triggerTag.id,
    'Reminder: you have an appointment coming up.\n\nPlease check your booking page for the time and location.',
  )

  for (const appointment of upcoming) {
    if (!appointment.lineHarnessFriendId) continue

    try {
      const friend = await harness.friends.get(appointment.lineHarnessFriendId)
      if (friend.tags.some((t) => t.id === triggerTag.id)) {
        console.log(`[Notify] Skipping (reminder already triggered): ${appointment.lineHarnessFriendId}`)
        continue
      }

      // Attaching the trigger tag enrolls the friend in the scenario, which
      // performs the actual send — do NOT call sendTextToFriend here.
      await harness.friends.addTag(appointment.lineHarnessFriendId, triggerTag.id)

      console.log(`[Notify] Reminder scenario triggered for ${appointment.lineHarnessFriendId}`)
    } catch (error) {
      console.error(`[Notify] Failed to trigger reminder:`, error)
    }
  }
}

/**
 * Example: trigger a renewal scenario for friends whose memberships expire
 * within 7 days.
 *
 * To send a Flex Message instead of text, create the scenario step with
 * messageType 'flex' and the Flex JSON in messageContent.
 */
async function notifyExpiringMemberships(
  harness: LineHarness,
  myService: MyServiceClient,
): Promise<void> {
  const expiring = await myService.getExpiringMemberships(7) // next 7 days

  const allTags = await harness.tags.list()
  let triggerTag = allTags.find((t) => t.name === 'myservice:renewal-reminder')
  if (!triggerTag) {
    triggerTag = await harness.tags.create({ name: 'myservice:renewal-reminder', color: '#F59E0B' })
  }
  await ensureTagAddedScenario(
    harness,
    'MyService renewal reminder',
    triggerTag.id,
    'Your membership is expiring soon.\n\nPlease renew from your account page to keep your benefits.',
  )

  for (const membership of expiring) {
    if (!membership.lineHarnessFriendId) continue

    try {
      const friend = await harness.friends.get(membership.lineHarnessFriendId)
      if (friend.tags.some((t) => t.id === triggerTag.id)) {
        console.log(`[Notify] Skipping (already notified): ${membership.lineHarnessFriendId}`)
        continue
      }

      await harness.friends.addTag(membership.lineHarnessFriendId, triggerTag.id)

      console.log(`[Notify] Renewal scenario triggered for ${membership.lineHarnessFriendId}`)
    } catch (error) {
      console.error(`[Notify] Failed to trigger renewal reminder:`, error)
    }
  }
}
