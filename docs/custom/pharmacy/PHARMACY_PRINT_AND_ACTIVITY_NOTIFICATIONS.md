# Pharmacy Web print and activity inbox

## Scope

- Printing is a Web admin extension. The Worker never connects to a printer.
- Opening the print view claims one account/submission/active-revision task
  before private images are loaded, then opens the browser print dialog.
- The operator explicitly records that the print operation was performed.
- A ten-minute lease recovers abandoned browser sessions. Replacement
  revisions cancel older open tasks; cancelled tasks cannot be retried.
- No resident agent, printer telemetry, silent printing, or automatic retry is
  included.

The activity inbox stores one shared item per account event. It has only open
and acknowledged states. Source keys are SHA-256 hashed before persistence;
responses contain no dedupe hash, patient identifier, LINE identifier,
prescription content, R2 key, or free-form payload.

## Tenant boundary

Every route authenticates staff and validates the selected account server-side.
The environment owner is restricted to the LINE channel configured in the
Worker. Regular staff fail closed until the account-assignment table from the
Growth Loop release is installed.

## Human gates

- Test the browser print dialog and physical printer on each pharmacy PC.
- Confirm the Japanese acknowledgement wording with the pharmacy.
- Approve retention for acknowledged print tasks and activity items before
  production rollout.
