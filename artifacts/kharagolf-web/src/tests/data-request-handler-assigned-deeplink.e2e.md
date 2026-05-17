# E2E: Privacy-handler assignment deep-link on Member 360 Messages

Covers Task #350 (verifies the Task #306 UI). This is the canonical Playwright
`runTest` plan for the `data_request_handler_assigned` notice rendered by
`MessagesTab` in `artifacts/kharagolf-web/src/pages/member-360.tsx`. Replay it
with the testing skill (`runTest({ testReplitAuth: true, testPlan, ... })`) to
verify:

1. The "Privacy request assigned" badge + UserCheck icon + "View privacy
   request #N" outline button render on every assignment notice.
2. Clicking that button switches the page to the **Data / GDPR** tab and
   briefly highlights the matching `data-request-row-<N>` with
   `ring-2 ring-red-500/70` (added then removed ~2.5s later by
   `openDataRequest` in `member-360.tsx`).
3. When the linked request id is not in the cache (e.g. it was deleted),
   the row instead shows the "Linked request unavailable." hint with
   `data-testid="message-handler-assigned-unlinked-<msgId>"`.

## Important auth gotcha

The auth middleware reads `req.user` from `sessions.sess.user`. Promoting the
freshly logged-in OIDC user via `UPDATE app_users SET role='org_admin'` is
NOT enough — the existing session blob still carries the original role and
all `/api/organizations/:orgId/members-360/...` endpoints will return 403.
Patch both:

```sql
UPDATE app_users SET role='org_admin' WHERE id = ...;
UPDATE sessions
   SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                        '{user,organizationId}', to_jsonb(${org_id}::int))
 WHERE (sess->'user'->>'id')::int = ${user_id};
```

## Highlight is short-lived — install a MutationObserver BEFORE clicking

`openDataRequest` adds `ring-2 ring-red-500/70` to the row, then removes the
classes 2.5s later. A test that polls *after* the click can race the removal
and read back only the base classes. Install a `MutationObserver` BEFORE the
click that records when the ring classes appear, then await it.

## Test plan (paste into `runTest`)

```
1. [New Context] Create a new browser context.

2. [OIDC] Configure next login claims:
   { sub: "test-handler-assign-" + Date.now(),
     email: "handler-assign-e2e-" + Date.now() + "@example.com",
     first_name: "Handler", last_name: "AssignTester" }

3. [Browser] Navigate to /api/login?returnTo=%2F. Wait for redirects.

4. [DB] Promote the new user to org_admin in BOTH app_users AND
   sessions.sess (req.user is from sessions.sess.user), then seed:
     - one club_member
     - one privacy data-request assigned to this admin
     - one in-app data_request_handler_assigned message linked to that
       request
     - one second assignment-notice message pointing at request id
       999999999 (deliberately not present).

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   INSERT INTO club_members (organization_id, first_name, last_name, email)
     VALUES (${org_id}, 'E2E', 'HandlerAssign',
             'e2e-handler-assign-' || floor(random()*1000000)::int || '@example.com')
     RETURNING id AS member_id;

   INSERT INTO member_data_requests
     (organization_id, club_member_id, request_type, status,
      requested_at, due_by, handler_user_id)
     VALUES (${org_id}, ${member_id}, 'access', 'pending',
             now(), now() + interval '30 days', ${user_id})
     RETURNING id AS request_id;

   INSERT INTO member_messages
     (club_member_id, organization_id, sender_user_id, channel,
      subject, body, status, related_entity, related_entity_id)
     VALUES (${member_id}, ${org_id}, ${user_id}, 'in_app',
             'Privacy request #' || ${request_id} || ' assigned to you',
             'Body', 'sent', 'data_request_handler_assigned', ${request_id})
     RETURNING id AS linked_msg_id;

   INSERT INTO member_messages
     (club_member_id, organization_id, sender_user_id, channel,
      subject, body, status, related_entity, related_entity_id)
     VALUES (${member_id}, ${org_id}, ${user_id}, 'in_app',
             'Privacy request #999999999 assigned to you',
             'Body', 'sent', 'data_request_handler_assigned', 999999999)
     RETURNING id AS unlinked_msg_id;

5. [Browser] Navigate to /member-360/${member_id}. Wait for the
   "Member 360°" header. Dismiss any Vite runtime overlay if present.

6. [Browser] Click the "Messages" TabsTrigger. Wait until row
   data-testid="message-row-${linked_msg_id}" exists.

7. [Verify] Linked notice (data-testid=message-row-${linked_msg_id}):
   - has data-handler-assigned-notice="true"
   - contains data-testid=message-handler-assigned-icon-${linked_msg_id}
   - contains data-testid=message-handler-assigned-badge-${linked_msg_id}
     whose text contains "Privacy request assigned"
   - contains data-testid=message-handler-assigned-open-${linked_msg_id}
     whose text contains "View privacy request #${request_id}"
   - data-testid=message-handler-assigned-unlinked-${linked_msg_id}
     does NOT exist.

8. [Verify] Unlinked notice (data-testid=message-row-${unlinked_msg_id}):
   - data-handler-assigned-notice="true"
   - badge visible
   - open button text contains "View privacy request #999999999"
   - data-testid=message-handler-assigned-unlinked-${unlinked_msg_id}
     IS visible AND text contains "Linked request unavailable."

9. [Browser] Install a MutationObserver BEFORE clicking, so the brief
   highlight cannot be missed. Run page.evaluate which:
   - sets window.__sawRing = false
   - creates window.__ringPromise = new Promise(r => window.__ringResolve = r)
   - creates a MutationObserver on document.body, subtree:true,
     attributes:true, attributeFilter:['class'] that, on each mutation,
     queries for [data-testid="data-request-row-${request_id}"] and if it
     has both 'ring-2' and 'ring-red-500/70', sets __sawRing = true and
     resolves __ringResolve(true)
   - As a safety net, also poll every 50ms for 5000ms and resolve early
     if the classes are present.

   Then click data-testid=message-handler-assigned-open-${linked_msg_id}.

10. [Verify] page.evaluate(() => window.__ringPromise) with a 5-second
    timeout returns true. Also assert the "Data / GDPR" TabsTrigger has
    data-state="active".

11. [DB] Cleanup:
    DELETE FROM member_messages    WHERE id IN (${linked_msg_id}, ${unlinked_msg_id});
    DELETE FROM member_data_requests WHERE id = ${request_id};
    DELETE FROM club_members       WHERE id = ${member_id};
```

## Relevant technical documentation (paste into `runTest`)

```
APP UNDER TEST
- kharagolf-web at "/"; route /member-360/:id (wouter).
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects after the bypass.

AUTH GOTCHA
- req.user is read from sessions.sess.user. Updating app_users.role alone
  does NOT change req.user — patch sessions.sess via jsonb_set in step 4
  or the members-360/:id/messages and /data-requests endpoints will 403.

BEHAVIOUR UNDER TEST (Task #306, member-360.tsx MessagesTab)
- isAssignedNotice = m.relatedEntity === 'data_request_handler_assigned'
                    && m.relatedEntityId != null
- linkedAssignedRequest = isAssignedNotice
                            ? dataReqById.get(m.relatedEntityId!) : undefined
- Row gets:
  - data-handler-assigned-notice="true" on the container
  - UserCheck icon (data-testid=message-handler-assigned-icon-<id>)
  - Indigo "Privacy request assigned" badge
    (data-testid=message-handler-assigned-badge-<id>)
  - Outline "View privacy request #<requestId>" button
    (data-testid=message-handler-assigned-open-<id>) →
    onOpenDataRequest(m.relatedEntityId)
  - "Linked request unavailable." span only when !linkedAssignedRequest
    (data-testid=message-handler-assigned-unlinked-<id>)

DEEP-LINK HIGHLIGHT (member-360.tsx → openDataRequest)
- setTab('data'); 80ms later starts polling every 100ms (max 20 attempts)
  for [data-testid="data-request-row-<id>"]. When found: scrollIntoView
  + adds 'ring-2' and 'ring-red-500/70'; removes them after 2.5s.
- Highlight is short-lived; install a MutationObserver BEFORE the click
  so a delayed test poll cannot miss it.
```
