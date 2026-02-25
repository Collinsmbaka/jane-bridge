# Jane Bridge Server — Implementation Spec

## Overview

Extend the existing `app.js` (WhatsApp ↔ Voiceflow bridge) with **message counting**, **limit enforcement**, **referral system**, and **Airtable integration** using an in-memory cache. This is the bridge + referrals scope — no Make.com or Shopify integration in this phase.

---

## Scope

### In Scope
- Airtable user lookup/creation with in-memory caching
- Free user message counting (user-sent messages only; Jane's replies don't count)
- Limit enforcement at 10 messages (soft block)
- Referral code generation, detection, and processing
- Referral link delivery and reward fulfillment (bridge handles directly)
- Pass user metadata to Voiceflow as session variables
- Hourly cache cleanup with dirty-entry sync
- Fix existing webhook verification bug
- Optional Make.com webhook fire for analytics (not required for referral processing)

### Out of Scope
- Make.com workflow integration (purchase links, order processing, prescriber flow)
- Shopify/Paystack integration
- Monthly check-in triggers
- Website user flow
- PicoVoice audio transcription changes (preserve existing behavior)

---

## Architecture

```
[User sends WhatsApp message]
        ↓
[Meta WhatsApp Cloud API]
        ↓
┌─────────────────────────────────────────────────────┐
│            NODE.JS BRIDGE SERVER (app.js)            │
│                                                     │
│  1. Receive webhook from WhatsApp                   │
│        ↓                                            │
│  2. Check in-memory cache for user                  │
│     └─ Not cached → Fetch from Airtable, cache it  │
│     └─ Not in Airtable → Create new user            │
│        ↓                                            │
│  3. Detect referral code (new users only)           │
│     └─ If REF-XXXXXX found → Process referral       │
│     └─ Strip code from message before forwarding    │
│        ↓                                            │
│  4. Check message limit (free users only)           │
│     └─ count >= limit AND status != 'paying'        │
│       → Soft block: handle keywords or send prompt  │
│       → STOP (don't forward to Voiceflow)           │
│        ↓                                            │
│  5. Increment message count (in cache)              │
│        ↓                                            │
│  6. Every 5 messages → Sync count to Airtable       │
│        ↓                                            │
│  7. Forward message to Voiceflow DM API             │
│     (with customer_status, message_count,           │
│      referral_code as session variables)             │
│        ↓                                            │
│  8. Send Voiceflow response via WhatsApp API        │
└─────────────────────────────────────────────────────┘
```

---

## Environment Variables

### Existing (no changes)
```
WHATSAPP_TOKEN          # Meta System User Access Token
VERIFY_TOKEN            # Webhook verification token
VF_API_KEY              # Voiceflow Dialog Manager API key
VF_PROJECT_ID           # Voiceflow project ID (optional, for transcripts)
VF_VERSION_ID           # 'production' or 'development'
VF_DM_URL               # Voiceflow DM endpoint
PICOVOICE_API_KEY       # Optional, for audio transcription
PORT                    # Server port (default: 3000)
```

### New
```
AIRTABLE_PAT            # Airtable Personal Access Token
AIRTABLE_BASE_ID        # Airtable base ID (e.g., appXXXXXXXX)
JANE_WHATSAPP_NUMBER    # Jane's WhatsApp number for referral links (e.g., 2348012345678)
FREE_MESSAGE_LIMIT      # Default: 10. Number of free messages before block.
REFERRAL_BONUS          # Default: 10. Messages added per successful referral.
MAX_REFERRALS           # Default: 3. Max referrals a user can earn credit from.
SHOPIFY_STORE_URL       # Store URL for buy keyword response (e.g., https://janeforwomen.com)
MAKE_WEBHOOK_URL        # Optional. If set, fire analytics events to Make.com.
```

---

## In-Memory Cache

### Data Structure

Use a JavaScript `Map` keyed by WhatsApp phone number (raw from Meta, no transformation).

```js
cache = Map {
  "2348012345678": {
    airtable_id: "recXXXXXX",       // Airtable record ID
    message_count: 7,                // Current count
    customer_status: "free",         // "free" or "paying"
    referral_code: "REF-A3F8K2",     // This user's referral code
    referrals_earned: 1,             // Number of successful referrals (max 3)
    lastSynced: 1708900000000,       // Timestamp of last Airtable sync
    lastActive: 1708900000000,       // Timestamp of last message
    dirty: true                      // Has unsynced changes
  }
}
```

### Cache Events

| Event | Action |
|-------|--------|
| First message from user | Fetch from Airtable → store in cache |
| User not in Airtable | Create in Airtable → store in cache |
| Subsequent messages | Read from cache only (no API call) |
| Every 5 messages | Sync count to Airtable (background, mark `dirty: false`) |
| Hourly cleanup | Sync dirty entries → clear entries inactive >1 hour |
| Server restart | Cache is empty. Accept cold start — users re-fetched on next message |

### Sync Strategy

- **Every 5 messages**: When `message_count % 5 === 0`, fire a background Airtable PATCH to update `message_count`. Mark entry `dirty: false`.
- **Hourly cleanup** (via `setInterval`): Iterate cache. For entries with `lastActive` older than 1 hour: if `dirty`, sync to Airtable first, then delete from cache.
- **Acceptable loss**: Up to 4 unsaved message counts on server restart. This is fine — free messages are a soft limit, not a billing concern.

---

## Airtable Integration

### Table: `Users`

Field names match the Notion doc exactly:

| Field | Type | Purpose |
|-------|------|---------|
| `whatsapp_number` | Phone | Primary identifier (raw from Meta) |
| `name` | Text | User's name |
| `age` | Number | User's age |
| `location` | Single Select | Nigerian state |
| `tracks` | Multiple Select | Assigned tracks |
| `customer_status` | Single Select | `free` / `paying` |
| `message_count` | Number | Free message counter |
| `referrer_id` | Link to Users | Who referred them |
| `referral_code` | Text | Their unique referral code |
| `referrals_earned` | Number | Successful referrals count |
| `total_spent` | Currency | Lifetime value (NGN) |
| `source` | Single Select | `whatsapp` / `website` |
| `last_active` | DateTime | Last interaction |
| `created_at` | DateTime | Account creation |

### API Operations

**Lookup user:**
```
GET /v0/{baseId}/Users?filterByFormula={whatsapp_number}="{phone}"
```

**Create user:**
```
POST /v0/{baseId}/Users
Body: { fields: { whatsapp_number, customer_status: "free", message_count: 0, referral_code: "REF-XXXXXX", source: "whatsapp", created_at: ISO timestamp } }
```

**Update message count:**
```
PATCH /v0/{baseId}/Users/{recordId}
Body: { fields: { message_count: N, last_active: ISO timestamp } }
```

**Update referral reward:**
```
PATCH /v0/{baseId}/Users/{recordId}
Body: { fields: { message_count: current + REFERRAL_BONUS, referrals_earned: current + 1 } }
```

### Airtable Down / Errors

If Airtable is unreachable (network error, 5xx):
- **Log the error** via `console.log`
- **Forward the message to Voiceflow anyway** — user gets a response but isn't tracked
- **Do not cache** — next message will retry Airtable
- No error message sent to user

---

## Message Counting

### What Counts
- **Only user-sent messages** count toward the limit
- Jane's replies do NOT count
- Audio messages that get transcribed count as 1 message
- Interactive button replies count as 1 message

### Paying Users
- Still cached for quick lookup
- **Skip message counting and limit checks entirely**
- Forwarded to Voiceflow normally
- `customer_status`, `message_count`, `referral_code` still passed to Voiceflow as session variables

### Limit Calculation
```
effective_limit = FREE_MESSAGE_LIMIT + (referrals_earned * REFERRAL_BONUS)
```
Default: `10 + (referrals_earned * 10)`, max `10 + (3 * 10) = 40`.

---

## Soft Block Behavior

When a free user's `message_count >= effective_limit`:

### Keyword Handling (case-insensitive)

| Keyword | Response |
|---------|----------|
| `referral` | Send their referral link again (if `referrals_earned < MAX_REFERRALS`). If maxed out, tell them they've used all referral slots and suggest purchasing. |
| `help` | Explain they've reached the free message limit. Mention both options: refer a friend for +10 messages, or purchase a product for unlimited access. |
| `buy` / `purchase` | Explain that purchasing any product unlocks unlimited messages. Include `SHOPIFY_STORE_URL`. Also mention the referral option for free messages. |
| _anything else_ | Send the standard limit prompt with referral link. |

### Standard Limit Prompt
```
You've used all your free messages with Jane! 😊

But don't worry, here are two ways to keep chatting:

1️⃣ *Share with a friend* — You'll BOTH get 10 more free messages!
Your link: https://wa.me/{JANE_WHATSAPP_NUMBER}?text=Hi%20Jane%20{REFERRAL_CODE}

2️⃣ *Get a wellness product* — Unlock unlimited messages!
Visit: {SHOPIFY_STORE_URL}
```

If `referrals_earned >= MAX_REFERRALS`, omit option 1 and only show the purchase option.

### Message NOT forwarded to Voiceflow during soft block.

---

## Referral System

### Code Generation
- Format: `REF-` followed by 6 random uppercase alphanumeric characters
- Generated by the bridge when creating a new user in Airtable
- Example: `REF-A3F8K2`, `REF-9BX4M1`
- Stored in the `referral_code` field in Airtable

### Code Detection
- **Scan any incoming message** for the pattern `/REF-[A-Z0-9]{6}/i` (case-insensitive)
- **Only process for new users** — if the sender already exists in Airtable, ignore the code
- Strip the referral code from the message before forwarding to Voiceflow

### Referral Processing (Bridge handles directly)

When a new user's message contains a valid referral code:

1. **Look up referrer** in Airtable by `referral_code` field
2. **Validate**: referrer exists AND referrer's `referrals_earned < MAX_REFERRALS`
3. **Create new user** in Airtable with `referrer_id` linked to the referrer
4. **Update referrer** in Airtable: `message_count += REFERRAL_BONUS`, `referrals_earned += 1`
5. **Update referrer in cache** (if cached): same changes + `dirty: false` (just synced)
6. **Send WhatsApp notification to referrer**:
   ```
   Great news! Your friend just joined Jane 🎉
   You've both been gifted 10 extra messages. Enjoy!
   ```
7. **Forward cleaned message** (without REF code) to Voiceflow for the new user
8. **Optional**: If `MAKE_WEBHOOK_URL` is set, POST referral event for analytics:
   ```json
   { "event": "referral_completed", "referrer_phone": "...", "referee_phone": "...", "referral_code": "..." }
   ```

### Invalid Referral Code
If the code doesn't match any user in Airtable, or the referrer has maxed out referrals:
- **Silently ignore** — still create the new user, just without referral linkage
- Strip the code from the message and forward to Voiceflow normally
- Do not notify the user that the code was invalid

---

## Voiceflow Session Variables

On each `interact()` call, PATCH these variables to the Voiceflow session:

| Variable | Value | Purpose |
|----------|-------|---------|
| `user_id` | Airtable record ID | Link user across systems |
| `user_name` | From WhatsApp profile | Personalization |
| `customer_status` | `free` or `paying` | AI can adjust tone/offers |
| `message_count` | Current count | AI awareness of usage |
| `referral_code` | User's referral code | AI can reference if needed |

---

## Bug Fix: Webhook Verification

### Current (broken)
```js
if ((mode === 'subscribe' && token === process.env.VERIFY_TOKEN) || 'voiceflow')
```
The `|| 'voiceflow'` is always truthy — any request passes verification.

### Fixed
```js
if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN)
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Airtable unreachable | Log error, forward to Voiceflow without tracking |
| Airtable lookup fails | Treat as new user on next attempt |
| Referral code lookup fails (Airtable error) | Ignore referral, create user normally |
| WhatsApp notification to referrer fails | Log error, continue — don't block the new user's flow |
| Voiceflow unreachable | Existing behavior (try-catch, log error) |
| Invalid phone number | Existing `isValidUserId` validation — reject |

---

## New Environment Variables to Add to `.env.example`

```
# Airtable Configuration
AIRTABLE_PAT=patxxxxxxxx
AIRTABLE_BASE_ID=appxxxxxxxx

# Jane Configuration
JANE_WHATSAPP_NUMBER=2348012345678
FREE_MESSAGE_LIMIT=10
REFERRAL_BONUS=10
MAX_REFERRALS=3
SHOPIFY_STORE_URL=https://janeforwomen.com

# Optional: Make.com analytics webhook
MAKE_WEBHOOK_URL=
```

---

## Implementation Checklist

### Phase 1: Core Infrastructure
- [ ] Add new env vars to `.env.example` and `dotenv` config
- [ ] Create in-memory cache (Map) with helper functions: `getUser`, `setUser`, `syncToAirtable`
- [ ] Implement Airtable API helpers: `lookupUser`, `createUser`, `updateUser`
- [ ] Implement referral code generator (`REF-` + 6 random alphanumeric)
- [ ] Set up hourly cache cleanup with `setInterval`

### Phase 2: Message Flow Integration
- [ ] Modify webhook POST handler to check cache before forwarding to Voiceflow
- [ ] Add message counting logic (increment on each user message)
- [ ] Add every-5-messages sync trigger
- [ ] Add limit check with soft block behavior
- [ ] Implement soft block keyword handling (`referral`, `help`, `buy`/`purchase`)
- [ ] Send standard limit prompt for unrecognized messages when blocked

### Phase 3: Referral System
- [ ] Add referral code detection (regex on incoming messages)
- [ ] Implement referral processing (lookup referrer, validate, reward both)
- [ ] Send WhatsApp notification to referrer
- [ ] Strip referral code from message before Voiceflow forwarding
- [ ] Optional: fire Make.com webhook for analytics

### Phase 4: Voiceflow Integration Updates
- [ ] Pass `customer_status`, `message_count`, `referral_code` as session variables
- [ ] Fix webhook verification bug

### Phase 5: Testing
- [ ] New user creation flow (no referral)
- [ ] New user creation flow (with valid referral)
- [ ] New user with invalid/expired referral code
- [ ] Existing user with referral code in message (should be ignored)
- [ ] Free user reaching message limit
- [ ] Soft block keyword responses (referral, help, buy)
- [ ] Paying user bypasses counting
- [ ] Cache cold start after restart
- [ ] Airtable unreachable graceful degradation
- [ ] Referrer at max referrals (3)
- [ ] Concurrent messages from same user (race condition check)
